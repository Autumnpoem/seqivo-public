import { HubError } from './store.mjs';
import { createHash } from 'node:crypto';
import { pendingChecks } from '../verification.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const strings = (value, fields) => Object.fromEntries(fields.filter(field => typeof value?.[field] === 'string').map(field => [field, value[field]]));
const integers = (value, fields) => Object.fromEntries(fields.filter(field => Number.isSafeInteger(value?.[field])).map(field => [field, value[field]]));
const booleans = (value, fields) => Object.fromEntries(fields.filter(field => typeof value?.[field] === 'boolean').map(field => [field, value[field]]));
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const date = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
const positive = value => Number.isSafeInteger(value) && value >= 1;
const writeReasons = new Set(['ACTIVE_EXECUTION','HUMAN_CONTROL','WORKSPACE_BUSY',
  'SOURCE_CHANGED','BINDING_UNAVAILABLE','CORE_UNAVAILABLE']);
const writeStates = new Set(['ready','blocked','unknown']);
const writeAction = value => {
  if (!object(value) || !writeStates.has(value.state) ||
      (value.state === 'ready' ? value.reasonCode !== null : !writeReasons.has(value.reasonCode)))
    throw new HubError('Invalid execution write gate');
  return {state:value.state,reasonCode:value.reasonCode};
};
const writeBase = value => {
  if (!object(value) || value.v !== 1 || !validId(value.bootId) ||
      typeof value.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.observedAt) ||
      !Number.isFinite(Date.parse(value.observedAt)) || new Date(value.observedAt).toISOString() !== value.observedAt)
    throw new HubError('Invalid execution write gate');
  return {v:1,bootId:value.bootId,observedAt:value.observedAt};
};

// The inbox is a projection, never a transport for raw provider errors or metadata.
export function inboxProjection(value, tasks) {
  if (!object(value) || !Array.isArray(value.items) || value.items.length > 10000 || !date(value.updatedAt)) throw new HubError('Invalid inbox projection');
  const seen = new Set();
  const items = value.items.map(item => {
    const task = object(item) && tasks.find(task => task.id === item.taskId && task.projectId === item.projectId);
    if (!task || !validId(item.id) || !validId(item.projectId) || !validId(item.taskId) || seen.has(item.id) ||
        !['decision','acceptance','blocked','unknown'].includes(item.kind) || !['open','acknowledged','resolved','superseded'].includes(item.state) ||
        !positive(item.itemRevision) || !positive(item.sourceRevision) || item.sourceRevision > task.revision ||
        !positive(item.contentVersion) || item.contentVersion > task.contentVersion ||
        !Number.isSafeInteger(item.priority) || item.priority < 0 || item.priority > 100 ||
        !object(item.source) || !validId(item.source.id) || typeof item.source.type !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(item.source.type) ||
        !date(item.createdAt) || !date(item.updatedAt) || (item.resolvedAt != null && !date(item.resolvedAt)) ||
        typeof item.shareWithRemote !== 'boolean') throw new HubError('Invalid inbox item');
    for (const [field, limit] of [['title',240],['summary',5000],['impact',5000],['recommendedAction',5000]]) {
      if (typeof item[field] !== 'string' || !item[field].trim() || item[field].length > limit) throw new HubError('Invalid inbox text');
    }
    if (item.options !== undefined && (!Array.isArray(item.options) || item.options.length > 10 ||
        new Set(item.options.map(option => option?.id)).size !== item.options.length || item.options.some(option => !object(option) || !validId(option.id) ||
          typeof option.label !== 'string' || !option.label.trim() || option.label.length > 240 ||
          typeof option.consequence !== 'string' || option.consequence.length > 2000))) throw new HubError('Invalid inbox options');
    seen.add(item.id);
    const shared = item.shareWithRemote;
    return { ...strings(item, ['id','projectId','taskId','kind','state','createdAt','updatedAt']),
      ...integers(item, ['itemRevision','sourceRevision','contentVersion','priority']),
      source: {type:item.source.type,id:item.source.id}, dedupKey:item.id,
      resolvedAt:item.resolvedAt ?? null, resolution:null, shareWithRemote:shared,
      ...(shared ? strings(item,['title','summary','impact','recommendedAction']) : {
        title: `${({decision:'待决策',acceptance:'待验收',blocked:'任务阻塞',unknown:'结果未知'})[item.kind]}（详情仅在桌面）`,
        summary: '此事项的详细内容未授权远程共享。', impact: '需要在项目电脑核对详情后处理。', recommendedAction: '在项目电脑打开关联任务。',
      }),
      ...(shared && item.options ? {options:item.options.map(option => strings(option,['id','label','consequence']))} : {}),
    };
  });
  const omitted=value.omitted ?? [];
  if (!Array.isArray(omitted) || omitted.length > 100 || new Set(omitted.map(item=>item?.projectId)).size !== omitted.length ||
      omitted.some(item=>!object(item)||!validId(item.projectId)||!Number.isSafeInteger(item.open)||item.open<0||item.open>10000||!Number.isSafeInteger(item.history)||item.history<0||item.history>10000)) throw new HubError('Invalid inbox omission counts');
  return {items,updatedAt:value.updatedAt,...(omitted.length?{omitted:omitted.map(item=>({projectId:item.projectId,open:item.open,history:item.history}))}:{})};
}

// Keep local history intact. Bound the transport and explicitly report omitted
// counts per project so phones never mistake a partial inbox for an empty one.
export function budgetInboxSnapshot(snapshot,maxBytes=1_800_000) {
  if (!snapshot.inbox) return snapshot;
  const result={...snapshot,inbox:{...snapshot.inbox,items:[],omitted:[]}};
  let remaining=maxBytes-Buffer.byteLength(JSON.stringify(result))-15000;
  const isOpen=item=>['open','acknowledged'].includes(item.state);
  const items=[...snapshot.inbox.items].sort((a,b)=>Number(isOpen(b))-Number(isOpen(a))||b.priority-a.priority||Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
  const counts=new Map((snapshot.inbox.omitted||[]).map(item=>[item.projectId,{...item}]));
  for (const item of items) {
    const size=Buffer.byteLength(JSON.stringify(item))+1;
    if (size<=remaining) {result.inbox.items.push(item);remaining-=size;}
    else {const count=counts.get(item.projectId)||{projectId:item.projectId,open:0,history:0};count[isOpen(item)?'open':'history']++;counts.set(item.projectId,count);}
  }
  result.inbox.omitted=[...counts.values()];
  if (!result.inbox.omitted.length) delete result.inbox.omitted;
  return result;
}

export function validateInboxAction(board, task, body) {
  if (board.capabilities?.inbox !== true) throw new HubError('请更新项目电脑上的序程，以启用待处理收件箱',409,'NODE_UPDATE_REQUIRED');
  const item = board.inbox?.items?.find(item => item.id === body.itemId && item.projectId === task.projectId && item.taskId === task.id);
  if (!item) throw new HubError('Inbox item not in current task',404,'INBOX_NOT_FOUND');
  if (!['open','acknowledged'].includes(item.state) || item.itemRevision !== body.expectedItemRevision || item.contentVersion !== task.contentVersion) throw new HubError('Inbox item changed; refresh before deciding',409,'INBOX_CONFLICT');
  if (item.readOnly || item.kind === 'unknown') throw new HubError('结果未知时仅允许核对原操作',409,'INBOX_UNKNOWN');
  if (!item.shareWithRemote) throw new HubError('此事项需要在项目电脑处理',403,'INBOX_PRIVATE');
  if (body.action === 'answer' && (item.kind !== 'decision' || body.optionId && !item.options?.some(option => option.id === body.optionId))) throw new HubError('Invalid decision answer');
  if (body.action === 'supplement' && item.kind !== 'blocked') throw new HubError('Only blocked items accept supplementary information');
  return item;
}

export function projectProjection(project) {
  if (!object(project) || typeof project.id !== 'string' || typeof project.name !== 'string') throw new HubError('Invalid project projection');
  return {...strings(project, ['id', 'name', 'goal', 'createdAt']),
    ...(project.conversationStart === undefined ? {} :
      {conversationStart:{...writeBase(project.conversationStart),...writeAction(project.conversationStart)}})};
}

export function taskProjection(task) {
  if (!object(task) || typeof task.id !== 'string' || typeof task.projectId !== 'string' || !Number.isInteger(task.revision)) throw new HubError('Invalid task projection');
  let verification = null;
  if (task.verification != null) {
    const value = task.verification;
    if (!object(value) || !['unverified', 'passed', 'partial', 'failed'].includes(value.status) || value.source !== 'test' ||
        !Number.isSafeInteger(value.contentVersion) || value.contentVersion < 1 || value.contentVersion > task.contentVersion ||
        typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 5000 ||
        typeof value.reference !== 'string' || !value.reference.trim() || value.reference.length > 4000 ||
        typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
        !Array.isArray(value.criterionIds) || value.criterionIds.length > 100 ||
        value.criterionIds.some(id => typeof id !== 'string' || !id) || new Set(value.criterionIds).size !== value.criterionIds.length) {
      throw new HubError('Invalid task verification projection');
    }
    const currentIds = value.contentVersion === task.contentVersion
      ? (Array.isArray(task.criteria) ? task.criteria.filter(object).map(item => item.id) : []) : null;
    if (currentIds && value.criterionIds.some(id => !currentIds.includes(id))) throw new HubError('Invalid task verification projection');
    const checks = pendingChecks(value.pendingChecks, currentIds, HubError);
    if (value.status === 'passed' && checks.length || value.status === 'unverified' && value.criterionIds.length) throw new HubError('Invalid task verification projection');
    const remoteChecks = checks.map((check, index) => check.shareWithRemote ? { ...check, id: `remote-check-${index + 1}` } : {
      id: `remote-check-${index + 1}`, kind: check.kind,
      title: `验证待办 ${index + 1}（详情仅在桌面）`, criterionIds: [...check.criterionIds],
      steps: ['请在项目电脑打开任务详情，查看具体操作。'], expectedResult: '请在桌面查看通过标准。',
      blockedReason: check.blockedReason ? '请在桌面查看当前缺少的条件。' : '', shareWithRemote: false, completed: check.completed,
    });
    verification = { status: value.status, summary: value.summary, reference: '请在桌面端查看本地验证证据',
      criterionIds: [...value.criterionIds], pendingChecks: remoteChecks, source: 'test', contentVersion: value.contentVersion, createdAt: value.createdAt };
  }
  if (task.sourceConversationGroup !== undefined && task.sourceConversationGroup !== null &&
      (typeof task.sourceConversationGroup !== 'string' || !/^[a-f0-9]{64}$/.test(task.sourceConversationGroup)))
    throw new HubError('Invalid source conversation group');
  if (task.previewFeedback !== undefined &&
      (!object(task.previewFeedback) || !validId(task.previewFeedback.projectId) ||
        task.previewFeedback.projectId !== task.projectId || !validId(task.previewFeedback.previewId) ||
        !validId(task.previewFeedback.sourceTaskId) || !positive(task.previewFeedback.sourceContentVersion)))
    throw new HubError('Invalid preview feedback lineage');
  return {
    ...strings(task, ['id', 'projectId', 'title', 'goal', 'summary', 'approach', 'nextStep', 'status', 'acceptance', 'updatedAt']),
    ...integers(task, ['revision', 'contentVersion']),
    hasExecutionBinding: task.hasExecutionBinding === true || (typeof task.conversationId === 'string' && task.conversationId.trim().length > 0),
    ...(task.sourceConversationGroup === undefined ? {} : {sourceConversationGroup:task.sourceConversationGroup}),
    ...(task.previewFeedback === undefined ? {} : {previewFeedback:{
      projectId:task.previewFeedback.projectId,previewId:task.previewFeedback.previewId,
      sourceTaskId:task.previewFeedback.sourceTaskId,sourceContentVersion:task.previewFeedback.sourceContentVersion,
    }}),
    criteria: Array.isArray(task.criteria) ? task.criteria.slice(0, 100).filter(object).map(item => ({ ...strings(item, ['id', 'text']), ...booleans(item, ['passed']) })) : [],
    evidence: Array.isArray(task.evidence) ? task.evidence.slice(-50).filter(object).map(item => ({ ...strings(item, ['id', 'summary', 'source', 'createdAt']), ...integers(item, ['contentVersion']) })) : [],
    issues: Array.isArray(task.issues) ? task.issues.slice(-50).filter(object).map(item => ({ ...strings(item, ['summary', 'kind']),id:validId(item.id)?item.id:createHash('sha256').update(String(item.id)).digest('hex'), ...booleans(item, ['open']) })) : [],
    verification,
    ...(task.executionWrite === undefined ? {} : {executionWrite:(() => {
      const value=task.executionWrite,base=writeBase(value);
      if (!positive(value.taskRevision) || !positive(value.contentVersion) ||
          value.taskRevision!==task.revision || value.contentVersion!==task.contentVersion)
        throw new HubError('Execution write gate task binding changed');
      return {...base,taskRevision:value.taskRevision,contentVersion:value.contentVersion,
        message:writeAction(value.message),continue:writeAction(value.continue),
        ...(value.start === undefined ? {} : {start:writeAction(value.start)})};
    })()}),
  };
}

export function sanitizeSnapshot(input) {
  if (!object(input) || !Array.isArray(input.projects) || !Array.isArray(input.tasks)) throw new HubError('Invalid snapshot');
  const tasks = input.tasks.map(taskProjection);
  const conversations = Array.isArray(input.conversations) ? input.conversations.slice(0, 5).map(conversationProjection) : [];
  if (conversations.some(item => !tasks.some(task => task.id === item.taskId && task.projectId === item.projectId))) throw new HubError('Conversation must belong to a snapshot task');
  const inbox = input.capabilities?.inbox === true ? inboxProjection(input.inbox,tasks) : null;
  if (inbox?.omitted?.some(item=>!input.projects.some(project=>project.id===item.projectId))) throw new HubError('Inbox omission must belong to a snapshot project');
  const projects=input.projects.map(projectProjection);
  const boots=new Set([...projects.map(project=>project.conversationStart?.bootId),
    ...tasks.map(task=>task.executionWrite?.bootId)].filter(Boolean));
  if(boots.size>1)throw new HubError('Execution write gates have different Core boot identities');
  return { projects, tasks, conversations,
    ...(inbox ? {inbox} : {}),
    capabilities: {conversations: input.capabilities?.conversations === true, inbox:input.capabilities?.inbox === true,
      taskCreation:input.capabilities?.taskCreation === true,taskStart:input.capabilities?.taskStart === true} };
}

// Share only visible conversation content. Provider metadata and reasoning are never projected.
export function conversationProjection(value) {
  if (!object(value) || typeof value.taskId !== 'string' || typeof value.projectId !== 'string' || !Array.isArray(value.messages)) throw new HubError('Invalid conversation projection');
  let remaining = 100000;
  const messages = value.messages.slice(-100).reverse().filter(object).flatMap(message => {
    if (!['user', 'assistant', 'tool', 'system'].includes(message.role) || typeof message.text !== 'string' || remaining <= 0) return [];
    const text = message.text.slice(0, Math.min(12000, remaining)); remaining -= text.length;
    return [{ ...strings(message, ['id', 'role', 'createdAt', 'status']), text }];
  }).reverse();
  return { ...strings(value, ['taskId', 'projectId', 'status', 'updatedAt']), messages,
    truncated: value.truncated === true || value.messages.length > messages.length || remaining <= 0 };
}

export function sanitizeReceiptResult(result) {
  if (!object(result)) return null;
  const source = object(result.task) ? result.task : result;
  return { ...strings(source, ['taskId', 'status', 'acceptance', 'commandId','itemId']), ...integers(source, ['revision','itemRevision']) };
}
