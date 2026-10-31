import { createHash, randomUUID } from 'node:crypto';
import { BoardError, text } from './store.mjs';

const KEY = 'inbox.v1';
const MAX_ITEMS = 10000;
const MAX_RECEIPTS = 20000;
const now = () => new Date().toISOString();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, status = 400, code = 'INBOX_INVALID') => { throw new BoardError(message, status, code); };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const required = (value, name, max = 5000) => text(value, name, max, true);
const title = value => value.length <= 240 ? value : `${value.slice(0, 239)}…`;
const summary = value => value.length <= 5000 ? value : `${value.slice(0, 4999)}…`;
const AUTO_STOP_SUMMARIES = Object.freeze({
  retry_stopped: '自动继续计划需要核对，后续自动重试已停止。',
  budget_exhausted: '自动继续计划已到截止时间，不会再自动启动下一次尝试。',
  attempts_exhausted: '自动继续已达到本次计划的尝试次数上限。',
});
const AUTO_STOP_REASONS = Object.freeze({
  retry_failed: '一次自动继续尝试没有顺利完成，后续自动重试已停止。',
  legacy_plan_missing_deadline: '旧的自动继续计划没有记录截止时间，请核对后明确重新开始。',
  attempt_unconfirmed: '上次自动继续的结果尚未确认，后续尝试已停止。',
  restart_binding_changed: '重新开始计划后，任务或执行位置发生了变化。请核对当前要求，再决定是否重新开始。',
  plan_intent_missing: '旧的自动继续计划没有记录获准的目标和下一步。请核对当前要求，再明确重新开始。',
  plan_intent_changed: '任务目标或下一步发生了变化，原计划已停止。请核对新的要求，再决定是否重新开始。',
  repeated_quota_failure: '两次自动尝试后额度仍不可用，计划已停止。请先检查账号额度，再决定是否重新开始。',
});

function decisionInput(input) {
  if (!record(input) || Object.keys(input).some(key => !['expectedRevision','requestId','title','summary','impact','options','shareWithRemote'].includes(key))) fail('决策请求格式不正确');
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail('任务修订号不正确');
  const options = input.options === undefined ? [] : input.options;
  if (!Array.isArray(options) || options.length > 10) fail('决策选项格式不正确');
  const parsed = options.map(option => {
    if (!record(option) || Object.keys(option).some(key => !['id','label','consequence'].includes(key))) fail('决策选项格式不正确');
    const optionId = required(option.id, '选项 ID', 100);
    if (!/^[A-Za-z0-9_-]+$/.test(optionId)) fail('选项 ID 格式不正确');
    return { id: optionId, label: required(option.label, '选项名称', 240), consequence: required(option.consequence, '选项后果', 1000) };
  });
  if (new Set(parsed.map(option => option.id)).size !== parsed.length) fail('决策选项 ID 重复');
  if (input.shareWithRemote !== undefined && typeof input.shareWithRemote !== 'boolean') fail('远程共享设置不正确');
  return { expectedRevision: input.expectedRevision, requestId: required(input.requestId, '请求 ID', 200),
    title: required(input.title, '标题', 240), summary: required(input.summary, '说明'), impact: required(input.impact, '影响'),
    options: parsed, shareWithRemote: input.shareWithRemote === true };
}

function actionInput(input) {
  if (!record(input) || Object.keys(input).some(key => !['actionId','expectedRevision','expectedItemRevision','action','answer','optionId'].includes(key))) fail('收件箱操作格式不正确');
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || !Number.isSafeInteger(input.expectedItemRevision) || input.expectedItemRevision < 1) fail('修订号不正确');
  if (!['acknowledge','answer','supplement'].includes(input.action)) fail('未知收件箱操作');
  if (input.answer !== undefined && typeof input.answer !== 'string') fail('答复格式不正确');
  if (input.optionId !== undefined && typeof input.optionId !== 'string') fail('选项 ID 格式不正确');
  return { actionId: required(input.actionId, '操作 ID', 200), expectedRevision: input.expectedRevision,
    expectedItemRevision: input.expectedItemRevision, action: input.action,
    ...(input.answer === undefined ? {} : { answer: text(input.answer, '答复', 5000) }),
    ...(input.optionId === undefined ? {} : { optionId: text(input.optionId, '选项 ID', 100) }) };
}

export function createInbox({ store }) {
  if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('Inbox requires Store');
  const read = () => {
    const row = store.db.prepare('SELECT value FROM metadata WHERE key=?').get(KEY);
    if (!row) return { version: 1, items: [], receipts: [], updatedAt: '1970-01-01T00:00:00.000Z' };
    let image;
    try { image = JSON.parse(row.value); } catch { fail('收件箱记录损坏', 500, 'INBOX_CORRUPT'); }
    if (image?.version !== 1 || !Array.isArray(image.items) || !Array.isArray(image.receipts) || image.items.length > MAX_ITEMS || image.receipts.length > MAX_RECEIPTS ||
      typeof image.updatedAt !== 'string' || !Number.isFinite(Date.parse(image.updatedAt)) ||
      image.items.some(item => !record(item) || ['id','projectId','taskId','dedupKey','title','summary','impact','recommendedAction','createdAt','updatedAt'].some(key => typeof item[key] !== 'string') ||
        !['decision','acceptance','blocked','unknown'].includes(item.kind) || !['open','acknowledged','resolved','superseded'].includes(item.state) ||
        !Number.isSafeInteger(item.itemRevision) || item.itemRevision < 1 || !Number.isSafeInteger(item.sourceRevision) || item.sourceRevision < 1 ||
        !Number.isSafeInteger(item.contentVersion) || item.contentVersion < 1 || !Number.isSafeInteger(item.priority) ||
        !record(item.source) || typeof item.source.id !== 'string' || typeof item.source.type !== 'string' || typeof item.shareWithRemote !== 'boolean' ||
        (item.options !== undefined && (!Array.isArray(item.options) || item.options.some(option => !record(option) || ['id','label','consequence'].some(key => typeof option[key] !== 'string')))) ||
        (item.resolvedAt !== null && (typeof item.resolvedAt !== 'string' || !Number.isFinite(Date.parse(item.resolvedAt)))) ||
        (item.resolution !== null && !record(item.resolution))) ||
      image.receipts.some(receipt => !record(receipt) || typeof receipt.id !== 'string' || typeof receipt.hash !== 'string' || !record(receipt.result))) fail('收件箱记录损坏', 500, 'INBOX_CORRUPT');
    return image;
  };
  const write = image => {
    if (image.items.length > MAX_ITEMS || image.receipts.length > MAX_RECEIPTS) fail('收件箱容量已满，请导出归档', 409, 'INBOX_FULL');
    image.updatedAt = now();
    store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, JSON.stringify(image));
  };
  const state = () => { const image = read(); return { items: structuredClone(image.items), updatedAt: image.updatedAt }; };
  const makeItem = (task, kind, source, dedupKey, fields) => {
    const at = now();
    return { id: randomUUID(), projectId: task.projectId, taskId: task.id, kind, state: 'open', itemRevision: 1,
      sourceRevision: task.revision, contentVersion: task.contentVersion, source, dedupKey,
      priority: fields.priority, title: title(fields.title), summary: summary(fields.summary), impact: fields.impact,
      recommendedAction: fields.recommendedAction, createdAt: at, updatedAt: at, resolvedAt: null,
      resolution: null, ...(fields.options ? { options: fields.options } : {}), shareWithRemote: fields.shareWithRemote ?? true };
  };
  const sourceCandidates = ({ executions = {}, policies = [] } = {}) => {
    const candidates = [];
    const tasks = store.tasks();
    const byId = new Map(tasks.map(task => [task.id, task]));
    const add = (task, kind, source, key, fields) => candidates.push({ task, kind, source, key, fields });
    for (const task of tasks) {
      if (task.status === 'submitted' && task.acceptance !== 'passed' && task.review?.contentVersion !== task.contentVersion) {
        add(task, 'acceptance', { type: 'task.acceptance', id: String(task.contentVersion) }, `acceptance:${task.id}:${task.contentVersion}`, {
          priority: 80, title: title(`验收：${task.title}`), summary: '当前版本已提交，等待人工验收。', impact: '交付尚未获得人工确认。', recommendedAction: '查看当前证据并作出验收结论。' });
      }
      if (task.status === 'blocked') {
        const reason = typeof task.blockedReason === 'string' && task.blockedReason.trim() ? task.blockedReason.trim() : '任务已阻塞，原因尚未记录';
        const occurrence = typeof task.blockedOccurrence === 'string' && task.blockedOccurrence ? task.blockedOccurrence : 'legacy';
        add(task, 'blocked', { type: 'task.blocked', id: hash({ taskId: task.id, occurrence, reason }) }, `blocked:task:${task.id}:${occurrence}:${hash(reason)}`, {
          priority: 90, title: title(`阻塞：${task.title}`), summary: reason, impact: '任务无法按原路径继续。', recommendedAction: '查看阻塞原因，必要时补充信息或调整任务。', shareWithRemote: false });
      }
      for (const [index, issue] of (Array.isArray(task.issues) ? task.issues : []).entries()) if (issue?.open) {
        const issueId = typeof issue.id === 'string' && issue.id ? issue.id : `legacy-${index}`;
        add(task, 'blocked', { type: 'task.issue', id: hash(issueId) }, `blocked:issue:${task.id}:${hash(issueId)}`, {
          priority: 85, title: title(`交付偏差：${task.title}`), summary: typeof issue.summary === 'string' && issue.summary.trim() ? issue.summary : '偏差说明未记录', impact: '该偏差阻止通过人工验收。', recommendedAction: '查看偏差，提供所需信息或通过现有偏差流程处理。' });
      }
      for (const check of task.verification?.pendingChecks || []) if (check.blockedReason && !check.completed && task.verification.contentVersion === task.contentVersion) {
        add(task, 'blocked', { type: 'verification.check', id: hash(check.id) }, `blocked:check:${task.id}:${hash(check.id)}:${task.contentVersion}`, {
          priority: 70, title: title(`验证受阻：${check.title}`), summary: check.blockedReason, impact: '当前版本的验证步骤尚未完成。', recommendedAction: '查看验证计划并补充所需信息。', shareWithRemote: check.shareWithRemote === true });
      }
    }
    for (const lease of [...(executions.active || [])]) {
      if (lease.status !== 'unknown' || !lease.commandId) continue;
      const task = byId.get(lease.taskId);
      if (!task) continue;
      add(task, 'unknown', { type: 'execution.command', id: hash(lease.commandId) }, `unknown:execution:${task.id}:${hash(lease.commandId)}`, {
        priority: 100, title: title(`执行结果待核对：${task.title}`), summary: '执行器尚未确认该命令的结果。', impact: '重复发送可能造成重复执行。', recommendedAction: '检查当前执行状态，并使用现有核对或暂停流程。' });
    }
    for (const policy of policies || []) {
      const task = byId.get(policy.taskId);
      if (!task) continue;
      if (policy.status === 'awaiting_approval') add(task, 'blocked', { type: 'plugin.policy', id: task.id }, `blocked:policy:${task.id}:awaiting_approval`, {
        priority: 90, title: title(`执行等待处理：${task.title}`), summary: '执行器等待授权或用户输入。', impact: '自动执行已停止等待。', recommendedAction: '打开任务及执行器状态，处理所需输入。' });
      if (policy.status === 'unknown') add(task, 'unknown', { type: 'plugin.policy', id: task.id }, `unknown:policy:${task.id}`, {
        priority: 100, title: title(`执行状态未知：${task.title}`), summary: '执行器未确认最近操作结果。', impact: '不能安全地假定任务已完成或可以重试。', recommendedAction: '查看执行器状态并使用现有核对流程。' });
      const stopped = Object.hasOwn(AUTO_STOP_SUMMARIES, policy.status) ? AUTO_STOP_SUMMARIES[policy.status] : null;
      const stoppedSummary = policy.status === 'retry_stopped' && Object.hasOwn(AUTO_STOP_REASONS, policy.stopReason)
        ? AUTO_STOP_REASONS[policy.stopReason] : stopped;
      if (stopped) add(task, 'blocked', { type: 'plugin.autocontinue', id: task.id },
        `blocked:autocontinue:${task.id}:${hash({ startedAt: policy.startedAt || null, status: policy.status })}`, {
          priority: 90, title: title(`自动继续已停止：${task.title}`), summary: stoppedSummary,
          impact: '后续尝试不会自动启动；正在运行的任务仍需单独查看或暂停。',
          recommendedAction: '在电脑的“接入与插件”中查看自动继续计划；核对原因后，再决定是否明确重新开始。',
          // Only fixed product language is shared. Provider diagnostics may
          // contain credentials or local paths and must stay out of this card.
          shareWithRemote: true,
        });
    }
    return candidates;
  };
  function sync(sources = {}) {
    const candidates = sourceCandidates(sources);
    const wanted = new Map(candidates.map(candidate => [candidate.key, candidate]));
    const confirmedUnknown = item => {
      if (item.source.type === 'execution.command') return (sources.executions?.recent || []).some(value =>
        value.taskId === item.taskId && hash(value.commandId) === item.source.id && ['completed','failed','paused','not_started','waiting_quota'].includes(value.status));
      if (item.source.type === 'plugin.policy') return (sources.policies || []).some(value =>
        value.taskId === item.taskId && ['reconciled','verified_idle','completed','failed','paused','stale_result'].includes(value.status));
      return false;
    };
    const image = read();
    let dirty = false;
    const tasks = new Map(store.tasks().map(task => [task.id, task]));
    for (const item of image.items) {
      if (!['open','acknowledged'].includes(item.state)) continue;
      if (item.kind === 'decision') {
        const task = tasks.get(item.taskId);
        if (task && task.contentVersion !== item.contentVersion) {
          item.state = 'superseded'; item.itemRevision++; item.updatedAt = now(); item.resolvedAt = item.updatedAt;
          item.resolution = { source: 'sync', reason: 'content_changed' }; dirty = true;
        }
        continue;
      }
      const current = wanted.get(item.dedupKey);
      if (!current) {
        if (item.kind === 'unknown' && !confirmedUnknown(item)) continue;
        const task = tasks.get(item.taskId);
        const stale = task && task.contentVersion !== item.contentVersion;
        item.state = stale ? 'superseded' : 'resolved'; item.itemRevision++; item.updatedAt = now(); item.resolvedAt = item.updatedAt;
        item.resolution = { source: 'sync', reason: stale ? 'content_changed' : 'source_cleared' }; dirty = true;
      } else {
        const { task, fields } = current;
        if (item.kind === 'unknown') { wanted.delete(item.dedupKey); continue; }
        if (item.contentVersion !== task.contentVersion) {
          item.state = 'superseded'; item.itemRevision++; item.updatedAt = now(); item.resolvedAt = item.updatedAt;
          item.resolution = { source: 'sync', reason: 'content_changed' }; dirty = true;
          continue;
        }
        wanted.delete(item.dedupKey);
        if (item.sourceRevision !== task.revision || item.summary !== summary(fields.summary) || item.title !== title(fields.title)) {
          item.sourceRevision = task.revision; item.summary = summary(fields.summary);
          item.title = title(fields.title); item.itemRevision++; item.updatedAt = now(); dirty = true;
        }
      }
    }
    for (const candidate of wanted.values()) {
      // A resolved occurrence stays resolved if its source was present throughout. A
      // new occurrence is created only after sync observed its source disappear.
      if (image.items.some(item => item.dedupKey === candidate.key && item.state === 'resolved' && item.resolution?.reason !== 'source_cleared')) continue;
      if (image.items.some(item => item.dedupKey === candidate.key && item.state === 'resolved' && item.resolution?.reason === 'source_cleared' && candidate.kind !== 'blocked')) continue;
      image.items.push(makeItem(candidate.task, candidate.kind, candidate.source, candidate.key, candidate.fields)); dirty = true;
    }
    if (dirty) store.transaction(() => write(image));
    return state();
  }
  function requestDecision(taskId, input, source = 'api') {
    const data = decisionInput(input);
    const sourceType = typeof source === 'string' ? source : source?.type;
    if (!['api','mcp','file','remote-controller'].includes(sourceType)) fail('决策来源不正确');
    const receiptId = `decision:${taskId}:${sourceType}:${data.requestId}`;
    const receiptHash = hash({ taskId, sourceType, data });
    const previous = read().receipts.find(value => value.id === receiptId);
    if (previous) { if (previous.hash !== receiptHash) fail('请求 ID 已用于另一项决策', 409, 'INBOX_REQUEST_CONFLICT'); return structuredClone(previous.result); }
    return store.transaction(() => {
      const image = read();
      const receipt = image.receipts.find(value => value.id === receiptId);
      if (receipt) { if (receipt.hash !== receiptHash) fail('请求 ID 已用于另一项决策', 409, 'INBOX_REQUEST_CONFLICT'); return structuredClone(receipt.result); }
      const task = store.getTask(taskId); store.checkRevision(task, data.expectedRevision);
      const item = makeItem(task, 'decision', { type: 'decision.request', id: hash(data.requestId) }, receiptId, {
        priority: 95, title: data.title, summary: data.summary, impact: data.impact,
        recommendedAction: '由任务拥有者或控制者明确答复。', options: data.options, shareWithRemote: data.shareWithRemote });
      image.items.push(item);
      const result = structuredClone(item);
      image.receipts.push({ id: receiptId, hash: receiptHash, result });
      write(image); store.event(task.projectId, 'decision.requested', { taskId, itemId: item.id, requestId: data.requestId });
      return result;
    });
  }
  function act(itemId, input, actor = 'owner') {
    if (!['owner','remote-controller'].includes(typeof actor === 'string' ? actor : actor?.role)) fail('只有任务拥有者或控制者可以处理收件箱', 403, 'INBOX_FORBIDDEN');
    const data = actionInput(input);
    const actorKey = typeof actor === 'string' ? actor : { role: actor.role, id: actor.id };
    const receiptId = `action:${data.actionId}`, receiptHash = hash({ itemId, data, actor: actorKey });
    const snapshot = read();
    if (snapshot.items.some(value => value.id === itemId && value.kind === 'unknown')) fail('未知执行结果只能通过执行器核对，不能手动处理', 409, 'INBOX_UNKNOWN_READ_ONLY');
    const previous = snapshot.receipts.find(value => value.id === receiptId);
    if (previous) { if (previous.hash !== receiptHash) fail('操作 ID 已用于另一项操作', 409, 'INBOX_ACTION_CONFLICT'); return structuredClone(previous.result); }
    return store.transaction(() => {
      const image = read();
      const receipt = image.receipts.find(value => value.id === receiptId);
      if (receipt) { if (receipt.hash !== receiptHash) fail('操作 ID 已用于另一项操作', 409, 'INBOX_ACTION_CONFLICT'); return structuredClone(receipt.result); }
      const item = image.items.find(value => value.id === itemId);
      if (!item) fail('收件箱项目不存在', 404, 'INBOX_NOT_FOUND');
      if (item.kind === 'unknown') fail('未知执行结果只能通过执行器核对，不能手动处理', 409, 'INBOX_UNKNOWN_READ_ONLY');
      const task = store.getTask(item.taskId); store.checkRevision(task, data.expectedRevision);
      if (item.itemRevision !== data.expectedItemRevision || item.contentVersion !== task.contentVersion || !['open','acknowledged'].includes(item.state)) fail('收件箱项目已更新，请刷新后重试', 409, 'INBOX_STALE');
      if (data.action === 'acknowledge') {
        if (data.answer || data.optionId) fail('确认操作不能包含答复');
        if (item.state !== 'open') fail('收件箱项目已经确认', 409, 'INBOX_STALE');
        item.state = 'acknowledged';
      } else if (data.action === 'answer') {
        if (item.kind !== 'decision') fail('仅明确决策请求可以答复', 409);
        if (!data.answer && !data.optionId) fail('请输入答复或选择选项');
        if (data.optionId && !item.options?.some(option => option.id === data.optionId)) fail('选项不属于此决策请求');
        const selected = item.options?.find(option => option.id === data.optionId);
        const answer = data.answer || selected.label;
        task.decisions = [...(task.decisions || []), { id: data.actionId, itemId, requestId: item.source.id,
          answer, ...(selected ? { optionId: selected.id } : {}), source: 'human', actor: typeof actor === 'string' ? actor : actor.id || actor.role,
          contentVersion: task.contentVersion, createdAt: now() }];
        task.nextStep = item.shareWithRemote ? answer : '已记录私人决策，请在本地查看决策记录。';
        store.saveTask(task, 'decision.answered', { itemId });
        item.state = 'resolved'; item.resolvedAt = now(); item.resolution = { source: 'human', action: 'answer', actionId: data.actionId };
      } else {
        if (item.kind !== 'blocked') fail('仅阻塞项目可以补充信息', 409);
        if (!data.answer || data.optionId) fail('请输入补充信息');
        task.supplementHistory = [...(task.supplementHistory || []), { id: data.actionId, itemId,
          answer: data.answer, source: 'human', actor: typeof actor === 'string' ? actor : actor.id || actor.role,
          contentVersion: task.contentVersion, createdAt: now() }];
        task.nextStep = item.shareWithRemote
          ? [task.nextStep, `补充信息：${data.answer}`].filter(Boolean).join('\n')
          : '已记录私人补充信息，请在本地查看人工补充记录。';
        store.saveTask(task, 'task.supplemented', { itemId });
      }
      item.sourceRevision = task.revision; item.itemRevision++; item.updatedAt = now();
      const result = { taskId: task.id, status: 'completed', itemId, itemRevision: item.itemRevision };
      image.receipts.push({ id: receiptId, hash: receiptHash, result });
      write(image); store.event(task.projectId, `inbox.${data.action}`, { taskId: task.id, itemId });
      return result;
    });
  }
  return { sync, state, requestDecision, act };
}
