import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { BoardError } from './store.mjs';

const KEY = 'execution.leases.v1';
const active = new Set(['startup', 'reserved', 'running', 'unknown']);
const releasable = new Set(['completed', 'failed', 'paused', 'not_started', 'waiting_quota']);
const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const stamp = () => new Date().toISOString();
const fail = (message, code = 'EXECUTION_INVALID', status = 400) => { throw new BoardError(message, status, code); };
const required = (value, label, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label}格式不正确`);
  return value.trim();
};
const within = (a, b) => { const r = relative(a, b); return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)); };
const overlaps = (a, b) => within(a, b) || within(b, a);
// An old active record without a canonical path cannot prove disjointness.
const conflicts = (record, workspace) => typeof record.workspace !== 'string' || !isAbsolute(record.workspace) || overlaps(record.workspace, workspace);

export function createExecutionLeases({ store, inspect, beforeReserve = () => {}, resolveWorktree }) {
  if (!store?.db || typeof store.transaction !== 'function' || typeof inspect !== 'function') throw new TypeError('Execution leases require Store and inspect callback');
  const read = () => {
    const row = store.db.prepare('SELECT value FROM metadata WHERE key=?').get(KEY);
    if (!row) return { version: 1, cursor: 0, reservations: [] };
    const image = JSON.parse(row.value);
    if (image?.version !== 1 || !Array.isArray(image.reservations) || !Number.isSafeInteger(image.cursor)) fail('执行租约记录已损坏', 'EXECUTION_STATE_CORRUPT', 500);
    return image;
  };
  const mutate = fn => store.transaction(() => {
    const image = read();
    const before = JSON.stringify(image);
    const result = fn(image);
    if (JSON.stringify(image) !== before) store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, JSON.stringify(image));
    return result;
  });
  const publicRecord = reservation => {
    const { workspace, startupId, recordId, conversationId, commandHistory, retirementReceipt,
      shutdownStoppedReceipt, disposition, ...visible } = reservation;
    return clone(visible);
  };
  const projectWorkspace = projectId => {
    const project = store.getProject(projectId);
    const directory = project.directory;
    if (typeof directory !== 'string' || !isAbsolute(directory)) fail('项目尚未绑定目录', 'EXECUTION_WORKSPACE', 409);
    let real;
    try {
      real = realpathSync(directory);
      if (!statSync(real).isDirectory()) throw new Error('not a directory');
    } catch { fail('项目目录不存在或不可访问', 'EXECUTION_WORKSPACE', 409); }
    if (resolve(real) !== resolve(directory)) fail('项目目录的真实路径已变化，请重新绑定', 'EXECUTION_WORKSPACE_CHANGED', 409);
    return real;
  };
  const workspaceFor = (taskId, provider, requireBound = true, worktreeId = null) => {
    const task = store.getTask(taskId);
    if (provider && task.executionProvider && task.executionProvider !== provider) fail('任务已绑定其他执行工具', 'EXECUTION_PROVIDER_MISMATCH', 409);
    if (requireBound && (typeof task.conversationId !== 'string' || !task.conversationId.trim())) fail('任务尚未绑定可控制会话', 'EXECUTION_UNBOUND', 409);
    if (worktreeId !== null) {
      if (typeof resolveWorktree !== 'function') fail('工作树执行未接线', 'EXECUTION_WORKTREE_UNAVAILABLE', 409);
      const workspace = resolveWorktree({ taskId, worktreeId });
      if (typeof workspace !== 'string' || !isAbsolute(workspace) || realpathSync(workspace) !== workspace)
        fail('工作树目录已变化', 'EXECUTION_WORKSPACE_CHANGED', 409);
      return { task, workspace };
    }
    return { task, workspace: projectWorkspace(task.projectId) };
  };

  function state() {
    const image = read();
    return { version: 1, active: image.reservations.filter(item => active.has(item.status)).map(publicRecord),
      recent: image.reservations.filter(item => !active.has(item.status)).slice(-50).map(publicRecord) };
  }

  function available({ taskId, workspace, worktreeId = null }) {
    try {
      const id = required(taskId, '任务 ID');
      const { task, workspace: registered } = workspaceFor(id, undefined, false, worktreeId);
      beforeReserve(task.projectId);
      if (workspace !== undefined) {
        if (typeof workspace !== 'string' || !isAbsolute(workspace) || realpathSync(workspace) !== registered) return false;
      }
      return !read().reservations.some(item => active.has(item.status) && (item.taskId === id ||
        item.projectId === task.projectId && (!worktreeId || !item.worktreeId) || conflicts(item, registered)));
    } catch { return false; }
  }

  // A workflow continuation may use the same task's already-confirmed
  // dedicated executor. This is only a read-only scheduling hint: reserve()
  // still requires the exact startupId/recordId before any provider send.
  // Keep available() stricter for human/terminal callers.
  function workflowMayContinue({ taskId, provider, workspace, worktreeId = null }) {
    try {
      const id = required(taskId, '任务 ID');
      const executionProvider = required(provider, '执行工具', 100);
      const { task, workspace: registered } = workspaceFor(id, executionProvider, true, worktreeId);
      beforeReserve(task.projectId);
      if (workspace !== undefined &&
          (typeof workspace !== 'string' || !isAbsolute(workspace) || realpathSync(workspace) !== registered)) return false;
      const image = read();
      const own = image.reservations.filter(item => active.has(item.status) && item.taskId === id);
      if (own.length > 1) return false;
      if (own.length === 1) {
        const startup = own[0];
        if (startup.status !== 'startup' || startup.ready !== true || startup.purpose !== 'turn' ||
            startup.provider !== executionProvider || startup.projectId !== task.projectId ||
            startup.workspace !== registered || (startup.worktreeId || null) !== worktreeId ||
            startup.conversationId !== task.conversationId ||
            typeof startup.startupId !== 'string' || !startup.startupId ||
            typeof startup.recordId !== 'string' || !/^[a-f0-9]{32}$/.test(startup.recordId)) return false;
      }
      return !image.reservations.some(item => item !== own[0] && active.has(item.status) &&
        (item.taskId === id ||
         item.projectId === task.projectId && (!worktreeId || !item.worktreeId) ||
         conflicts(item, registered)));
    } catch { return false; }
  }

  function reserve({ taskId, commandId, provider, workspace: requestedWorkspace, worktreeId = null,
    startupId = null, recordId = null }) {
    const id = required(taskId, '任务 ID');
    const command = required(commandId, '命令 ID');
    const executionProvider = required(provider, '执行工具', 100);
    return mutate(image => {
      const { task, workspace } = workspaceFor(id, executionProvider, true, worktreeId);
      if (requestedWorkspace !== undefined && requestedWorkspace !== workspace)
        fail('请求目录与登记工作树不符', 'EXECUTION_WORKSPACE_CHANGED', 409);
      beforeReserve(task.projectId);
      if(image.reservations.some(item=>item.provider===executionProvider&&
        item.commandHistory?.some(row=>row.commandId===command)))
        fail('命令 ID 已有确认记录，不能再次发送', 'EXECUTION_COMMAND_CONFLICT', 409);
      const startup = image.reservations.find(item => item.taskId === id && item.provider === executionProvider && item.status === 'startup');
      if (startup) {
        if (startup.startupId !== startupId || startup.recordId !== recordId ||
          startup.projectId !== task.projectId ||
          startup.workspace !== workspace || (startup.worktreeId || null) !== worktreeId ||
          startup.ready !== true || !startup.recordId ||
          image.reservations.some(item => item !== startup && item.commandId === command && item.provider === executionProvider) ||
          startup.commandHistory?.some(row => row.commandId === command))
          fail('任务启动租约尚未核实或命令已使用', 'EXECUTION_COMMAND_CONFLICT', 409);
        startup.commandId = command;
        startup.status = 'reserved';
        startup.confirmedAt = null;
        store.event(task.projectId, 'execution.reserved', { taskId: id, commandId: command, provider: executionProvider });
        return { ...publicRecord(startup), duplicate: false, maySend: true };
      }
      const existing = image.reservations.find(item => item.taskId === id && item.commandId === command && item.provider === executionProvider);
      if (existing) {
        if ((existing.worktreeId || null) !== worktreeId || existing.workspace !== workspace)
          fail('命令 ID 的工作树绑定已变化', 'EXECUTION_COMMAND_CONFLICT', 409);
        return { ...publicRecord(existing), duplicate: true, maySend: false };
      }
      if (image.reservations.some(item => item.commandId === command && item.provider === executionProvider && (item.taskId !== id || item.workspace !== workspace))) fail('命令 ID 已用于其他任务', 'EXECUTION_COMMAND_CONFLICT', 409);
      if (image.reservations.some(item => active.has(item.status) && (item.taskId === id ||
        item.projectId === task.projectId && (!worktreeId || !item.worktreeId) || conflicts(item, workspace))))
        fail('任务或工作区已有执行租约', 'EXECUTION_BUSY', 409);
      const reservation = { taskId: id, projectId: task.projectId, commandId: command, provider: executionProvider,
        workspace, worktreeId, status: 'reserved', createdAt: stamp(), confirmedAt: null, actualModel: null };
      image.reservations.push(reservation);
      store.event(task.projectId, 'execution.reserved', { taskId: id, commandId: command, provider: executionProvider });
      return { ...publicRecord(reservation), duplicate: false, maySend: true };
    });
  }

  function reserveStartup({ taskId, startupId, provider, workspace: requestedWorkspace, worktreeId = null,
    purpose, expectedRevision, expectedHandoffGeneration }) {
    const id = required(taskId, '任务 ID');
    const startup = required(startupId, '启动 ID');
    const executionProvider = required(provider, '执行工具', 100);
    if (!['session', 'turn'].includes(purpose) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 ||
      expectedHandoffGeneration !== null &&
        (!Number.isSafeInteger(expectedHandoffGeneration) || expectedHandoffGeneration < 1))
      fail('启动租约参数不正确');
    return mutate(image => {
      const { task, workspace } = workspaceFor(id, executionProvider, purpose !== 'session', worktreeId);
      if (task.revision !== expectedRevision || (purpose === 'session' ? !!task.conversationId : !task.conversationId) ||
        requestedWorkspace !== workspace) fail('任务启动绑定已变化', 'EXECUTION_BINDING_CHANGED', 409);
      beforeReserve(task.projectId);
      const existing = image.reservations.find(item => item.startupId === startup && item.provider === executionProvider);
      if (existing) fail('启动 ID 已使用，请核对原执行器', 'EXECUTION_DUPLICATE', 409);
      if (image.reservations.some(item => active.has(item.status) && (item.taskId === id ||
        item.projectId === task.projectId && (!worktreeId || !item.worktreeId) || conflicts(item, workspace))))
        fail('任务或工作区已有执行租约', 'EXECUTION_BUSY', 409);
      const record = { taskId: id, projectId: task.projectId, commandId: startup, startupId: startup,
        provider: executionProvider, workspace, worktreeId, purpose,
        expectedRevision, expectedHandoffGeneration,
        conversationId: purpose === 'turn' ? task.conversationId : null,
        recordId: null, ready: false,
        commandHistory: [], status: 'startup', createdAt: stamp(), confirmedAt: null, actualModel: null };
      image.reservations.push(record);
      store.event(task.projectId, 'execution.startup', { taskId: id, provider: executionProvider });
      return publicRecord(record);
    });
  }

  // A controlled preview build is a system operation, not an AI command. Keep
  // it in the same ledger so every existing execution/worktree fence sees it.
  function reservePreviewBuild({ taskId, requestId, projectId, workspace: requestedWorkspace,
    worktreeId = null, expectedRevision, contentVersion }) {
    const id = required(taskId, '任务 ID');
    const request = required(requestId, '构建请求 ID', 100);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 ||
      !Number.isSafeInteger(contentVersion) || contentVersion < 1)
      fail('构建版本不正确', 'BUILD_BINDING_CHANGED', 409);
    return mutate(image => {
      const { task, workspace } = workspaceFor(id, undefined, false, worktreeId);
      if (task.projectId !== projectId || task.revision !== expectedRevision ||
        task.contentVersion !== contentVersion || requestedWorkspace !== workspace)
        fail('构建任务或目录已变化', 'BUILD_BINDING_CHANGED', 409);
      beforeReserve(projectId,workspace);
      if (image.reservations.some(item => item.kind === 'preview_build' && item.requestId === request))
        fail('构建请求已经登记，请核对原请求', 'BUILD_REQUEST_CONFLICT', 409);
      if (image.reservations.some(item => active.has(item.status) &&
        (item.taskId === id || item.projectId === projectId && (!worktreeId || !item.worktreeId) ||
          conflicts(item, workspace))))
        fail('任务或目录已有活动操作', 'BUILD_BUSY', 409);
      const record = { kind: 'preview_build', provider: 'core-preview-build', taskId: id,
        projectId, requestId: request, commandId: request, workspace, worktreeId,
        expectedRevision, contentVersion, status: 'reserved', createdAt: stamp() };
      image.reservations.push(record);
      return publicRecord(record);
    });
  }

  function updatePreviewBuild({ requestId, taskId, status }) {
    if (!['running', 'unknown', 'failed', 'completed'].includes(status))
      fail('构建租约结果不正确', 'BUILD_INVALID');
    return mutate(image => {
      const record = image.reservations.find(item => item.kind === 'preview_build' &&
        item.requestId === requestId && item.taskId === taskId);
      if (!record || !active.has(record.status) ||
        !({ reserved: ['running', 'unknown', 'failed'], running: ['unknown', 'failed', 'completed'],
          unknown: ['unknown', 'failed', 'completed'] }[record.status] || []).includes(status))
        fail('原构建租约无法核实', 'BUILD_EXECUTOR_UNKNOWN', 409);
      record.status = status;
      record.confirmedAt = stamp();
      return publicRecord(record);
    });
  }

  function previewBuildFor({ requestId, taskId }) {
    const record = read().reservations.find(item => item.kind === 'preview_build' &&
      item.requestId === requestId && item.taskId === taskId);
    return record ? clone(record) : null;
  }

  function startupFor({ taskId, startupId, provider, recordId = undefined }) {
    const record = read().reservations.find(item => item.taskId === taskId && item.startupId === startupId &&
      item.provider === provider && active.has(item.status));
    if (!record || recordId !== undefined && record.recordId !== recordId)
      fail('原执行器启动租约不存在或已变化', 'EXECUTION_NOT_FOUND', 409);
    return clone(record);
  }

  function retiredStartupFor({ taskId, startupId, provider, recordId }) {
    const image = read();
    const record = image.reservations.find(item => item.taskId === taskId &&
      item.startupId === startupId && item.provider === provider &&
      item.recordId === recordId && item.status === 'not_started' &&
      item.retirementReceipt?.startupId === startupId &&
      item.retirementReceipt?.recordId === recordId);
    if (!record || image.reservations.some(item => item !== record &&
        item.taskId === taskId && active.has(item.status)))
      fail('原执行器退休收据不存在或已有新执行', 'EXECUTION_STARTUP_UNKNOWN', 409);
    const { task, workspace } = workspaceFor(taskId, provider,
      record.purpose !== 'session', record.worktreeId || null);
    if (task.projectId !== record.projectId || workspace !== record.workspace ||
      record.retirementReceipt.workspace !== record.workspace ||
      (record.retirementReceipt.worktreeId || null) !== (record.worktreeId || null))
      fail('原执行器退休目录已变化', 'EXECUTION_BINDING_CHANGED', 409);
    return clone(record);
  }

  function bindStartup({ taskId, startupId, provider, recordId }) {
    if (typeof recordId !== 'string' || !/^[a-f0-9]{32}$/.test(recordId)) fail('执行器记录 ID 不正确');
    return mutate(image => {
      const record = image.reservations.find(item => item.taskId === taskId && item.startupId === startupId &&
        item.provider === provider && item.status === 'startup');
      if (!record || record.recordId && record.recordId !== recordId)
        fail('原执行器启动租约不存在或已变化', 'EXECUTION_NOT_FOUND', 409);
      record.recordId = recordId;
      return publicRecord(record);
    });
  }

  function confirmStartup({ taskId, startupId, provider, recordId }) {
    return mutate(image => {
      const record = image.reservations.find(item => item.taskId === taskId && item.startupId === startupId &&
        item.provider === provider && item.status === 'startup' && item.recordId === recordId);
      if (!record) fail('原执行器启动租约不存在或已变化', 'EXECUTION_NOT_FOUND', 409);
      record.ready = true;
      return publicRecord(record);
    });
  }

  function bindStartupConversation({ taskId, startupId, provider, recordId, threadId }) {
    const id=required(threadId,'会话 ID',300);
    return mutate(image=>{
      const record=image.reservations.find(item=>item.taskId===taskId&&item.startupId===startupId&&
        item.provider===provider&&item.recordId===recordId&&item.status==='startup'&&
        item.ready===true&&item.purpose==='session');
      if(!record)fail('原会话启动租约已变化','EXECUTION_STARTUP_UNKNOWN',409);
      const task=store.getTask(taskId);
      if(task.projectId!==record.projectId||task.conversationId!==id||
        workspaceFor(taskId,provider,true,record.worktreeId||null).workspace!==record.workspace)
        fail('原会话绑定不符','EXECUTION_BINDING_CHANGED',409);
      record.purpose='turn';record.conversationId=id;record.expectedRevision=task.revision;
      return publicRecord(record);
    });
  }

  function retireStartup({ taskId, startupId, provider, recordId, settledCommandId = null,
    settledStatus = null }) {
    return mutate(image => {
      const record = image.reservations.find(item => item.taskId === taskId && item.startupId === startupId &&
        item.provider === provider && item.recordId === recordId);
      if (!record) fail('原执行器启动租约尚有命令或身份已变化', 'EXECUTION_STARTUP_UNKNOWN', 409);
      if (record.shutdownStoppedReceipt)
        fail('原命令结果仍未知，不能作为已确认执行释放', 'EXECUTION_UNCONFIRMED', 409);
      if (record.status === 'not_started') {
        const receipt = record.retirementReceipt;
        if (!receipt || receipt.startupId !== startupId || receipt.recordId !== recordId ||
          receipt.workspace !== record.workspace ||
          (receipt.worktreeId || null) !== (record.worktreeId || null) ||
          receipt.commandId !== settledCommandId || receipt.settledStatus !== settledStatus ||
          image.reservations.some(item => item !== record && item.taskId === taskId && active.has(item.status)))
          fail('原执行器退休收据不匹配', 'EXECUTION_STARTUP_UNKNOWN', 409);
        return publicRecord(record);
      }
      if (!active.has(record.status))
        fail('原执行器启动租约状态已变化', 'EXECUTION_STARTUP_UNKNOWN', 409);
      if (record.status !== 'startup') {
        if (record.commandId !== settledCommandId || !releasable.has(settledStatus))
          fail('原执行命令结果尚未确认', 'EXECUTION_UNCONFIRMED', 409);
        record.commandHistory.push({commandId:record.commandId,status:settledStatus,confirmedAt:stamp()});
        store.event(record.projectId,'execution.confirmed',{taskId,commandId:record.commandId,status:settledStatus});
      }
      record.retirementReceipt = { startupId, recordId, workspace: record.workspace,
        worktreeId: record.worktreeId || null,
        commandId: record.status === 'startup' ? null : settledCommandId,
        settledStatus: record.status === 'startup' ? null : settledStatus };
      record.status = 'not_started';
      record.confirmedAt = stamp();
      record.ready = false;
      store.event(record.projectId, 'execution.startup_retired', { taskId });
      return publicRecord(record);
    });
  }

  // Process retirement is independent of the provider turn outcome. This
  // receipt remains an active fence; it is never an execution.confirmed event.
  function markShutdownStoppedUnknown({taskId,startupId,provider,recordId,receipt}) {
    return mutate(image=>{
      const record=image.reservations.find(item=>item.taskId===taskId&&item.startupId===startupId&&
        item.provider===provider&&item.recordId===recordId);
      if(!record||!receipt||receipt.version!==1||
        (receipt.stopCause!==undefined&&receipt.stopCause!=='provider_approval')||
        receipt.taskId!==taskId||
        receipt.projectId!==record.projectId||receipt.startupId!==startupId||
        receipt.recordId!==recordId||receipt.commandId!==record.commandId||
        receipt.threadId!==record.conversationId||receipt.workspace!==record.workspace||
        (receipt.worktreeId||null)!==(record.worktreeId||null)||
        receipt.expectedHandoffGeneration!==record.expectedHandoffGeneration||
        !required(receipt.turnId,'原回合 ID',300)||
        !Number.isSafeInteger(receipt.bridgePid)||receipt.bridgePid<2)
        fail('原退出收据身份不符','EXECUTION_STARTUP_UNKNOWN',409);
      if(record.shutdownStoppedReceipt){
        if(record.status!=='unknown'||JSON.stringify(record.shutdownStoppedReceipt)!==JSON.stringify(receipt))
          fail('原退出收据已变化','EXECUTION_STARTUP_UNKNOWN',409);
        return publicRecord(record);
      }
      if(!['reserved','running','unknown'].includes(record.status)||
        image.reservations.some(item=>item!==record&&active.has(item.status)&&item.taskId===taskId))
        fail('原命令结果或租约已变化','EXECUTION_UNCONFIRMED',409);
      record.status='unknown';record.ready=false;
      record.shutdownStoppedReceipt=clone(receipt);
      record.confirmedAt=stamp();
      return publicRecord(record);
    });
  }

  function retireStoppedUnknownForHuman({taskId,startupId,provider,recordId,receipt,disposition}) {
    return mutate(image=>{
      const record=image.reservations.find(item=>item.taskId===taskId&&item.startupId===startupId&&
        item.provider===provider&&item.recordId===recordId);
      if(!record||provider!=='codex-autocontinue'||!receipt||!disposition||
        JSON.stringify(record.shutdownStoppedReceipt)!==JSON.stringify(receipt)||
        disposition.version!==1||disposition.providerOutcome!=='unknown'||
        disposition.reason!=='human_disposition'||
        disposition.taskId!==taskId||disposition.projectId!==record.projectId||
        disposition.commandId!==record.commandId||disposition.startupId!==startupId||
        disposition.recordId!==recordId||disposition.threadId!==record.conversationId||
        disposition.turnId!==receipt.turnId||disposition.workspace!==record.workspace||
        (disposition.worktreeId||null)!==(record.worktreeId||null)||
        JSON.stringify(disposition.shutdownReceipt)!==JSON.stringify(receipt))
        fail('原未知命令处置收据与租约不符','EXECUTION_UNCONFIRMED',409);
      if(record.status==='retired_unknown'){
        if(JSON.stringify(record.disposition)!==JSON.stringify(disposition))
          fail('原未知命令已有不同处置收据','EXECUTION_UNCONFIRMED',409);
        return clone(record.disposition);
      }
      if(record.status!=='unknown'||image.reservations.some(item=>item!==record&&
          item.taskId===taskId&&active.has(item.status)))
        fail('原未知命令租约已变化','EXECUTION_UNCONFIRMED',409);
      record.status='retired_unknown';
      record.ready=false;
      record.disposition=clone(disposition);
      record.confirmedAt=stamp();
      return clone(record.disposition);
    });
  }

  function dispositions() {
    return read().reservations.filter(item=>item.status==='retired_unknown'&&item.disposition)
      .map(item=>clone(item.disposition));
  }

  function activeOverlaps(projectId) {
    const workspace = projectWorkspace(projectId);
    return read().reservations.filter(item => active.has(item.status) && (item.projectId === projectId || conflicts(item, workspace))).map(publicRecord);
  }

  function markLinuxStoppedUnknown({ taskId, commandId, provider, receipt }) {
    return mutate(image => {
      const record = image.reservations.find(item => item.taskId === taskId &&
        item.commandId === commandId && item.provider === provider);
      const task = store.getTask(taskId);
      if (!record || record.startupId || provider !== 'codex-autocontinue' || receipt?.version !== 1 ||
        !['linux-original-task-job-and-managed-handoff', 'linux-original-task-job-and-current-writers'].includes(receipt.scope) ||
        receipt.taskId !== taskId || receipt.commandId !== commandId || receipt.projectId !== record.projectId ||
        task.projectId !== record.projectId || receipt.workspace !== record.workspace ||
        (receipt.worktreeId ?? null) !== (record.worktreeId ?? null) ||
        receipt.threadId !== task.conversationId || typeof receipt.turnId !== 'string' || !receipt.turnId ||
        !/^[0-9a-f]{32}$/.test(receipt.recordId) || !Number.isSafeInteger(receipt.recordGeneration) || receipt.recordGeneration < 1 ||
        !['reserved', 'running', 'unknown'].includes(record.status))
        fail('Linux 原命令停止收据与租约不符', 'EXECUTION_UNCONFIRMED', 409);
      if (record.shutdownStoppedReceipt && JSON.stringify(record.shutdownStoppedReceipt) !== JSON.stringify(receipt))
        fail('Linux 原命令停止收据已变化', 'EXECUTION_UNCONFIRMED', 409);
      record.status = 'unknown'; record.ready = false;
      record.shutdownStoppedReceipt = clone(receipt);
      record.confirmedAt = stamp();
      return publicRecord(record);
    });
  }
  function bindingFor({ taskId, commandId }) {
    const item = read().reservations.find(row => row.taskId === taskId && row.commandId === commandId && active.has(row.status));
    if (!item) fail('执行命令没有有效租约', 'EXECUTION_NOT_FOUND', 409);
    const { workspace } = workspaceFor(taskId, item.provider, item.purpose !== 'session', item.worktreeId || null);
    if (workspace !== item.workspace) fail('执行租约目录已变化', 'EXECUTION_WORKSPACE_CHANGED', 409);
    return { workspace, worktreeId: item.worktreeId || null };
  }

  function releaseConfirmed({ taskId, commandId, status }) {
    const id = required(taskId, '任务 ID');
    const command = required(commandId, '命令 ID');
    if (!releasable.has(status)) fail('执行结果尚未确认，不能释放租约', 'EXECUTION_UNCONFIRMED', 409);
    return mutate(image => {
      const reservation = image.reservations.find(item => item.taskId === id && item.commandId === command);
      if (!reservation) fail('租约命令 ID 不匹配', 'EXECUTION_NOT_FOUND', 409);
      if (reservation.shutdownStoppedReceipt)
        fail('原命令结果仍未知，不能作为已确认执行释放','EXECUTION_UNCONFIRMED',409);
      if (reservation.kind === 'preview_build')
        fail('受控构建租约仅能按原构建收据结算', 'BUILD_EXECUTOR_UNKNOWN', 409);
      if (reservation.status === 'startup') fail('任务执行器启动仍活跃，不能作为命令释放', 'EXECUTION_UNCONFIRMED', 409);
      if (!active.has(reservation.status)) {
        if (reservation.status === status) return publicRecord(reservation);
        fail('租约已经以不同结果结束', 'EXECUTION_RESULT_CONFLICT', 409);
      }
      if (reservation.startupId) {
        reservation.commandHistory.push({ commandId: command, status, confirmedAt: stamp() });
        reservation.commandId = reservation.startupId;
        reservation.status = 'startup';
        reservation.confirmedAt = stamp();
        store.event(reservation.projectId, 'execution.confirmed', { taskId: id, commandId: command, status });
        return publicRecord(reservation);
      }
      reservation.status = status;
      reservation.confirmedAt = stamp();
      store.event(reservation.projectId, 'execution.confirmed', { taskId: id, commandId: command, status });
      return publicRecord(reservation);
    });
  }

  async function reconcile() {
    const snapshot = read();
    const pending = snapshot.reservations.filter(item => active.has(item.status) &&
      item.status !== 'startup' && item.kind !== 'preview_build' && !item.shutdownStoppedReceipt);
    if (!pending.length) return { inspected: 0, released: 0,
      active: snapshot.reservations.filter(item => active.has(item.status)).length };
    const count = Math.min(10, pending.length);
    const start = snapshot.cursor % pending.length;
    const batch = Array.from({ length: count }, (_, index) => pending[(start + index) % pending.length]);
    mutate(image => { image.cursor = (start + count) % pending.length; });
    let released = 0;
    for (const reservation of batch) {
      let result;
      try { result = await inspect({ provider: reservation.provider, taskId: reservation.taskId, commandId: reservation.commandId }); }
      catch { result = { status: 'unknown' }; }
      if (!isRecord(result)) result = { status: 'unknown' };
      const observed = result.status;
      mutate(image => {
        const current = image.reservations.find(item => item.taskId === reservation.taskId && item.commandId === reservation.commandId && item.provider === reservation.provider);
        if (!current || !active.has(current.status) || current.shutdownStoppedReceipt) return;
        if (typeof result.actualModel === 'string' && result.actualModel.length <= 240) current.actualModel = result.actualModel;
        if (releasable.has(observed) && current.startupId) {
          current.commandHistory.push({ commandId: current.commandId, status: observed, confirmedAt: stamp() });
          current.commandId = current.startupId;
          current.status = 'startup';
          current.confirmedAt = stamp();
          store.event(current.projectId, 'execution.confirmed', { taskId: current.taskId, commandId: reservation.commandId, status: observed });
          released++;
        } else if (releasable.has(observed)) {
          current.status = observed;
          current.confirmedAt = stamp();
          store.event(current.projectId, 'execution.confirmed', { taskId: current.taskId, commandId: current.commandId, status: observed });
          released++;
        } else current.status = observed === 'running' ? 'running' : 'unknown';
      });
    }
    return { inspected: batch.length, released, active: read().reservations.filter(item => active.has(item.status)).length };
  }

  return { reserve, reserveStartup, startupFor, retiredStartupFor, bindStartup, confirmStartup,bindStartupConversation, retireStartup,markShutdownStoppedUnknown,markLinuxStoppedUnknown,
    retireStoppedUnknownForHuman,dispositions,
    reservePreviewBuild, updatePreviewBuild, previewBuildFor,
    available, workflowMayContinue, activeOverlaps, bindingFor, reconcile, releaseConfirmed, state };
}
