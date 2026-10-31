import { createHash, randomUUID } from 'node:crypto';
import { BoardError } from './store.mjs';

const KEY = 'workflow.v1';
const held = new Set(['sending', 'running', 'pausing', 'unknown']);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const clock = now => { const value = now(); return value instanceof Date ? value.getTime() : Number(value); };
const iso = value => new Date(value).toISOString();
const copy = value => structuredClone(value);
const baseline = task => createHash('sha256').update(JSON.stringify({
  title: task.title, goal: task.goal, example: task.example,
  criteria: task.criteria?.map(item => ({ id: item.id, text: item.text })),
})).digest('hex');
const fail = (message, status = 400, code = 'WORKFLOW_INVALID') => { throw new BoardError(message, status, code); };
// Diagnostics explain a provider observation; they never decide whether its lease can be released.
const providerFailureLabels = Object.freeze({
  busy: '模型服务当前繁忙',
  quota: '模型使用额度或速率限制已触发',
  auth: '模型服务认证失败，请检查当前登录状态',
  unknown: '模型本轮失败，具体原因待核实',
});
function failureExplanation(result) {
  const category = result?.diagnostic?.providerFailure?.category;
  if (!Object.hasOwn(providerFailureLabels, category)) return null;
  const suffix = result.status === 'failed'
    ? '本轮已停止，未自动重试。'
    : '本轮结果尚未核实，工作区保持占用；请先核实执行状态。';
  // Ignore provider-supplied summaries and raw error text at this new boundary.
  return `${providerFailureLabels[category]}。${suffix}`;
}
const name = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) fail(`${label}格式不正确`);
  return value.trim();
};

// The provider receives a role brief, not a request to change global model settings.
function brief(member) {
  if (member.reviewOf) return `Act as an independent ${member.role} for task ${member.reviewOf}. Inspect the delivered work and submit evidence and findings on review task ${member.taskId}. Do not perform human acceptance or mark the reviewed task passed.`;
  return `Act as ${member.role} on task ${member.taskId}. Follow the task's current goal and acceptance criteria. Report progress and evidence; human acceptance is separate.`;
}

export function createWorkflow({ store, executors, worktrees, now = Date.now, emit = () => {} }) {
  if (!store?.db || typeof store.transaction !== 'function' || !(executors instanceof Map)) throw new TypeError('Workflow requires a Store and executor Map');
  let serial = Promise.resolve();
  let closing = false;
  const pauseRequested = new Map();
  const pausePending = id => (pauseRequested.get(id) || 0) > 0;
  const enqueue = fn => {
    if (closing) return Promise.reject(new BoardError('工作流已经关闭', 503, 'WORKFLOW_CLOSED'));
    const next = serial.then(() => { if (closing) fail('工作流已经关闭', 503, 'WORKFLOW_CLOSED'); return fn(); });
    serial = next.catch(() => {});
    return next;
  };
  const read = () => {
    const row = store.db.prepare('SELECT value FROM metadata WHERE key=?').get(KEY);
    return row ? JSON.parse(row.value) : { version: 1, plans: [] };
  };
  const write = image => {
    store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, JSON.stringify(image));
  };
  const mutate = fn => {
    let changed = false;
    const result = store.transaction(() => {
      const image = read(), before = JSON.stringify(image), value = fn(image);
      if (JSON.stringify(image) !== before) { write(image); changed = true; }
      return value;
    });
    if (changed) { try { emit(); } catch { /* notification cannot roll back committed workflow state */ } }
    return result;
  };
  const get = (image, id) => {
    const plan = image.plans.find(item => item.id === id);
    if (!plan) fail('工作流计划不存在', 404, 'WORKFLOW_NOT_FOUND');
    return plan;
  };
  const findMember = (plan, taskId) => {
    const member = plan.members.find(item => item.taskId === taskId);
    if (!member) fail('任务不属于该工作流计划', 404, 'WORKFLOW_MEMBER_NOT_FOUND');
    return member;
  };
  const leaseConflict = (image, candidate) => image.plans.some(plan => plan.members.some(member =>
    member !== candidate && held.has(member.status) && (member.taskId === candidate.taskId || member.workspace === candidate.workspace ||
      store.getTask(member.taskId).projectId === store.getTask(candidate.taskId).projectId && (!member.worktreeId || !candidate.worktreeId))));

  function state() { return copy(read()); }

  async function createPlan(input) { return enqueue(() => {
    if (!record(input)) fail('计划格式不正确');
    const projectId = name(input.projectId, '项目 ID');
    const project = store.getProject(projectId);
    if (!project.directory) fail('项目尚未绑定目录', 409, 'WORKSPACE_REQUIRED');
    const workspaceMode = input.workspaceMode === undefined ? 'project' : input.workspaceMode;
    if (!['project', 'worktree'].includes(workspaceMode)) fail('工作区模式无效');
    if (workspaceMode === 'worktree' && !worktrees) fail('工作树功能未接线', 409, 'WORKTREE_UNAVAILABLE');
    if (!Number.isInteger(input.maxConcurrent) || input.maxConcurrent < 1 || input.maxConcurrent > 3 ||
        !Number.isInteger(input.maxStarts) || input.maxStarts < 1 || input.maxStarts > 20 ||
        !Number.isInteger(input.budgetMinutes) || input.budgetMinutes < 1 || input.budgetMinutes > 120) fail('并发、启动次数或时间预算超出范围');
    if (!Array.isArray(input.members) || !input.members.length || input.members.length > 100) fail('计划需包含 1–100 个成员');
    const ids = new Set();
    const members = input.members.map(raw => {
      if (!record(raw)) fail('成员格式不正确');
      const taskId = name(raw.taskId, '任务 ID');
      if (ids.has(taskId)) fail('计划内不能重复分配同一任务'); ids.add(taskId);
      const task = store.getTask(taskId);
      if (task.projectId !== projectId) fail('成员任务不属于计划项目');
      const provider = name(raw.provider, '执行器');
      if (task.executionProvider && task.executionProvider !== provider) fail('任务已绑定其他执行器', 409, 'EXECUTOR_MISMATCH');
      if (!executors.has(provider) || typeof executors.get(provider)?.start !== 'function' || typeof executors.get(provider)?.pause !== 'function' || typeof executors.get(provider)?.inspect !== 'function') fail('执行器不可用', 409, 'EXECUTOR_UNAVAILABLE');
      const role = name(raw.role, '角色');
      const worktreeId = workspaceMode === 'worktree' ? name(raw.worktreeId, '工作树 ID') : null;
      if (workspaceMode === 'project' && raw.worktreeId !== undefined) fail('普通计划不能指定工作树');
      const binding = worktreeId ? worktrees.binding({ id: worktreeId, taskId, role }) : null;
      const model = raw.model === undefined ? undefined : name(raw.model, '模型');
      if (raw.dependsOn !== undefined && (!Array.isArray(raw.dependsOn) || raw.dependsOn.length > 100)) fail('依赖格式不正确');
      const dependsOn = [...new Set((raw.dependsOn || []).map(id => name(id, '依赖任务 ID')))];
      if (dependsOn.includes(taskId)) fail('任务不能依赖自身');
      const reviewOf = raw.reviewOf === undefined ? null : name(raw.reviewOf, '审查目标');
      if (reviewOf === taskId) fail('独立审查必须使用另一任务');
      return { taskId, role, provider, ...(model ? { model } : {}), dependsOn, reviewOf,
        worktreeId, workspace: binding?.path || project.directory, expectedRevision: task.revision, status: 'pending', attempts: 0,
        commandId: null, lease: null, baselineHash: null, completionConfirmedAt: null, actualModel: null,
        startedAt: null, endedAt: null, lastError: null };
    });
    if (workspaceMode === 'worktree' && new Set(members.map(member => member.worktreeId)).size !== members.length)
      fail('同一计划不能让多个角色共用工作树', 409, 'WORKTREE_BUSY');
    for (const member of members) {
      for (const depId of member.dependsOn) if (store.getTask(depId).projectId !== projectId) fail('依赖任务不属于计划项目');
      if (!member.reviewOf) continue;
      const target = store.getTask(member.reviewOf);
      if (target.projectId !== projectId) fail('审查目标不属于计划项目');
      const assigned = members.find(item => item.taskId === member.reviewOf);
      if (!assigned) fail('独立审查目标必须由同一计划的另一成员执行');
      if (assigned.role === member.role) fail('审查者不能与执行者使用同一角色');
      const reviewed = store.getTask(assigned.taskId), reviewer = store.getTask(member.taskId);
      if (assigned.provider === member.provider && (!reviewed.conversationId || !reviewer.conversationId || reviewed.conversationId === reviewer.conversationId)) fail('同一执行器的审查者必须使用已绑定的不同会话');
    }
    const edges = new Map(members.map(member => [member.taskId, member.dependsOn.filter(id => ids.has(id))]));
    const visited = new Set(), stack = new Set();
    const visit = id => { if (stack.has(id)) fail('计划依赖存在循环'); if (visited.has(id)) return; stack.add(id); for (const dep of edges.get(id)) visit(dep); stack.delete(id); visited.add(id); };
    for (const id of ids) visit(id);
    const createdAt = iso(clock(now));
    const plan = { id: randomUUID(), projectId, workspaceMode, status: 'draft', members, maxConcurrent: input.maxConcurrent,
      maxStarts: input.maxStarts, budgetMinutes: input.budgetMinutes, starts: 0, createdAt,
      startedAt: null, deadlineAt: null, updatedAt: createdAt };
    mutate(image => { image.plans.push(plan); store.event(projectId, 'workflow.created', { planId: plan.id }); });
    return copy(plan);
  }); }

  async function refreshWork() {
    // Inspect is read-only and deliberately outside the SQLite transaction.
    const observations = [];
    for (const plan of read().plans) for (const member of plan.members) {
      if (!['running', 'unknown'].includes(member.status) || !member.commandId) continue;
      let result;
      try { result = await executors.get(member.provider)?.inspect({ taskId: member.taskId, commandId: member.commandId }); }
      catch (error) { result = { status: 'unknown', error: error instanceof Error ? error.message : String(error) }; }
      observations.push({ planId: plan.id, taskId: member.taskId, commandId: member.commandId, result });
    }
    mutate(image => {
      const timestamp = clock(now);
      for (const observation of observations) {
        const plan = image.plans.find(item => item.id === observation.planId);
        const member = plan?.members.find(item => item.taskId === observation.taskId);
        if (!member || member.commandId !== observation.commandId || !['running', 'unknown'].includes(member.status)) continue;
        let task;
        try { task = store.getTask(member.taskId); } catch { continue; }
        const currentBaseline = baseline(task);
        const stale = !member.baselineHash || member.baselineHash !== currentBaseline;
        const result = observation.result;
        if (typeof result?.actualModel === 'string' && result.actualModel.trim() && result.actualModel.length <= 240) member.actualModel = result.actualModel;
        if (result?.status === 'completed' || result?.status === 'failed' || result?.status === 'paused') {
          member.completionConfirmedAt = iso(timestamp);
          member.lease = null;
          member.endedAt = iso(timestamp);
          if (stale) { member.status = 'stale'; member.lastError = 'Task baseline changed during the provider execution'; }
          else if (result.status === 'failed') { member.status = 'failed'; member.lastError = failureExplanation(result) || 'Provider confirmed execution failure'; }
          else if (result.status === 'paused') { member.status = 'paused'; member.lastError = null; }
          else if (task.status === 'submitted') { member.status = 'awaiting_review'; member.lastError = null; }
          else { member.status = 'failed'; member.lastError = 'Provider completed without a submitted task'; }
        } else if (result?.status === 'not_started' || result?.status === 'waiting_quota') {
          // A provider-confirmed no-send outcome can release the workspace, but never counts as completed work.
          member.status = 'blocked';
          member.lease = null;
          member.endedAt = iso(timestamp);
          member.lastError = result.status === 'waiting_quota' ? 'Executor confirmed quota wait without starting' : 'Executor confirmed the command was not started';
        } else if (result?.status === 'running') {
          member.status = 'running';
          member.lastError = stale ? 'Task baseline changed while provider is still running' : null;
        } else {
          member.status = 'unknown';
          member.lastError = failureExplanation(result) || result?.error || 'Provider execution state could not be confirmed';
        }
        plan.updatedAt = iso(timestamp);
      }
      for (const plan of image.plans) {
        for (const member of plan.members) {
          if (member.status !== 'awaiting_review' || !member.completionConfirmedAt) continue;
          const task = store.getTask(member.taskId);
          if (member.baselineHash !== baseline(task)) { member.status = 'stale'; member.lastError = 'Task baseline changed after provider completion'; }
          else if (task.acceptance === 'passed' && task.review?.source === 'human' && task.review.contentVersion === task.contentVersion) member.status = 'complete';
          else continue;
          plan.updatedAt = iso(timestamp);
        }
        if (plan.status === 'active' && plan.deadlineAt && timestamp >= Date.parse(plan.deadlineAt)) plan.status = 'budget_exhausted';
        if (plan.status === 'active' && plan.starts >= plan.maxStarts && plan.members.some(member => member.status === 'pending')) plan.status = 'budget_exhausted';
        if (plan.status === 'pause_pending' && !plan.members.some(member => held.has(member.status))) plan.status = 'paused';
        if (plan.members.every(member => member.status === 'complete')) plan.status = 'complete';
      }
    });
  }

  function ready(plan, member) {
    if (member.status !== 'pending') return false;
    const task = store.getTask(member.taskId);
    let workspaceValid = store.getProject(plan.projectId).directory === member.workspace;
    if (plan.workspaceMode === 'worktree') {
      try { workspaceValid = worktrees.binding({ id: member.worktreeId, taskId: member.taskId, role: member.role }).path === member.workspace; }
      catch { workspaceValid = false; }
    }
    if (!workspaceValid || task.projectId !== plan.projectId || task.revision !== member.expectedRevision ||
        task.executionProvider && task.executionProvider !== member.provider || ['paused', 'cancelled', 'running', 'submitted'].includes(task.status)) return false;
    try {
      const canStart = executors.get(member.provider)?.canStart;
      if (typeof canStart === 'function') {
        const allowed = canStart({ taskId: member.taskId, workspace: member.workspace, worktreeId: member.worktreeId });
        if (allowed === false || allowed?.then) return false;
      }
    } catch { return false; }
    for (const depId of member.dependsOn) {
      const dep = store.getTask(depId);
      if (depId === member.reviewOf) { if (dep.status !== 'submitted' && dep.acceptance !== 'passed') return false; }
      else if (dep.acceptance !== 'passed' || dep.review?.source !== 'human' || dep.review.contentVersion !== dep.contentVersion) return false;
    }
    if (member.reviewOf) {
      const target = store.getTask(member.reviewOf);
      if (target.status !== 'submitted' && target.acceptance !== 'passed') return false;
      if (!['awaiting_review', 'complete'].includes(plan.members.find(item => item.taskId === member.reviewOf)?.status)) return false;
    }
    return true;
  }

  async function tickWork() {
    if (closing) return { plans: state().plans, launches: [] };
    await refreshWork();
    const result = [];
    for (;;) {
      if (closing) break;
      const launch = mutate(image => {
        const timestamp = clock(now);
        for (const plan of image.plans) {
          if (closing || pausePending(plan.id) || plan.status !== 'active' || timestamp >= Date.parse(plan.deadlineAt) || plan.starts >= plan.maxStarts) continue;
          const concurrent = plan.members.filter(member => held.has(member.status)).length;
          if (concurrent >= plan.maxConcurrent) continue;
          for (const member of plan.members) {
            if (!ready(plan, member) || leaseConflict(image, member)) continue;
            const commandId = randomUUID();
            member.status = 'sending'; member.commandId = commandId; member.attempts++;
            member.baselineHash = baseline(store.getTask(member.taskId));
            member.startedAt = iso(timestamp); member.lease = { taskId: member.taskId, workspace: member.workspace, commandId, acquiredAt: iso(timestamp) };
            plan.starts++; plan.updatedAt = iso(timestamp);
            store.event(plan.projectId, 'workflow.sending', { planId: plan.id, taskId: member.taskId, commandId });
            return { planId: plan.id, member: copy(member) };
          }
        }
        return null;
      });
      if (!launch) break;
      const { planId, member } = launch;
      const executor = executors.get(member.provider);
      let outcome, error;
      try {
        outcome = await executor.start({ taskId: member.taskId, expectedRevision: member.expectedRevision,
          commandId: member.commandId, role: member.role, ...(member.model ? { model: member.model } : {}),
          workspace: member.workspace, worktreeId: member.worktreeId,
          instructions: brief(member), evidenceOnly: Boolean(member.reviewOf), reviewOf: member.reviewOf });
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        try { const inspected = await executor.inspect({taskId:member.taskId,commandId:member.commandId});
          if(inspected?.status==='not_started') outcome={status:'not_started'};
        } catch { /* An unconfirmed send keeps the durable unknown fence. */ }
      }
      mutate(image => {
        const plan = get(image, planId), current = findMember(plan, member.taskId);
        if (current.commandId !== member.commandId || current.status !== 'sending') return;
        if (typeof outcome?.actualModel === 'string' && outcome.actualModel.trim() && outcome.actualModel.length <= 240) current.actualModel = outcome.actualModel;
        if (outcome?.status === 'running') current.status = 'running';
        else if (outcome?.status === 'waiting_quota'||outcome?.status==='not_started') { current.status = 'blocked'; current.lease = null; current.lastError = error || 'Executor confirmed no send'; }
        else { current.status = 'unknown'; current.lastError = error || 'Executor start outcome was not confirmed'; }
        plan.updatedAt = iso(clock(now));
        store.event(plan.projectId, 'workflow.start_result', { planId, taskId: member.taskId, status: current.status });
      });
      result.push({ planId, taskId: member.taskId, status: outcome?.status === 'running' ? 'running' : ['waiting_quota','not_started'].includes(outcome?.status) ? 'blocked' : 'unknown' });
    }
    return { plans: state().plans, launches: result };
  }

  function tick() { return enqueue(tickWork); }
  function start(planId) { return enqueue(async () => {
    mutate(image => {
      const plan = get(image, planId);
      if (!['draft', 'paused'].includes(plan.status)) fail('计划当前不可启动', 409, 'WORKFLOW_STATE');
      const timestamp = clock(now);
      if (!plan.startedAt) { plan.startedAt = iso(timestamp); plan.deadlineAt = iso(timestamp + plan.budgetMinutes * 60000); }
      if (timestamp >= Date.parse(plan.deadlineAt) || plan.starts >= plan.maxStarts) fail('计划预算已经耗尽', 409, 'WORKFLOW_BUDGET');
      plan.status = 'active'; plan.updatedAt = iso(timestamp);
      store.event(plan.projectId, 'workflow.started', { planId });
    });
    await tickWork();
    return state().plans.find(plan => plan.id === planId);
  }); }

  function pause(planId) {
    pauseRequested.set(planId, (pauseRequested.get(planId) || 0) + 1);
    return enqueue(async () => {
    const targets = mutate(image => {
      const plan = get(image, planId);
      if (plan.status === 'complete') fail('已完成的计划不能暂停', 409, 'WORKFLOW_STATE');
      plan.status = 'pause_pending'; plan.updatedAt = iso(clock(now));
      const pending = [];
      for (const member of plan.members) if (member.status === 'running') {
        member.status = 'pausing';
        pending.push(copy(member));
      }
      store.event(plan.projectId, 'workflow.pause_requested', { planId });
      return pending;
    });
    for (const member of targets) {
      let outcome, error;
      try {
        const task = store.getTask(member.taskId);
        outcome = await executors.get(member.provider).pause({ taskId: member.taskId, expectedRevision: task.revision,
          commandId: member.commandId, workspace: member.workspace });
      } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
      mutate(image => {
        const plan = get(image, planId), current = findMember(plan, member.taskId);
        if (current.status !== 'pausing' || current.commandId !== member.commandId) return;
        if (outcome?.status === 'paused') { current.status = 'paused'; current.lease = null; current.endedAt = iso(clock(now)); }
        else { current.status = 'unknown'; current.lastError = error || 'Pause outcome was not confirmed'; }
        plan.updatedAt = iso(clock(now));
        store.event(plan.projectId, 'workflow.pause_result', { planId, taskId: member.taskId, status: current.status });
      });
    }
    mutate(image => { const plan = get(image, planId); if (!plan.members.some(member => held.has(member.status))) plan.status = 'paused'; });
    return state().plans.find(plan => plan.id === planId);
    }).finally(() => {
      const count = (pauseRequested.get(planId) || 1) - 1;
      if (count) pauseRequested.set(planId, count); else pauseRequested.delete(planId);
    });
  }

  function reconcile(planId, input) { return enqueue(async () => {
    if (!record(input)) fail('核对结论格式不正确');
    const taskId = name(input.taskId, '任务 ID');
    if (input.confirm !== true) fail('需要明确确认核对操作');
    const before = get(read(), planId), member = findMember(before, taskId);
    if (member.status !== 'unknown') fail('仅能核对未知结果', 409, 'WORKFLOW_STATE');
    await refreshWork();
    const plan = get(read(), planId), current = findMember(plan, taskId);
    if (current.status === 'unknown') fail('执行器尚未确认该命令的结果', 409, 'UNKNOWN_RESULT');
    return copy(plan);
  }); }

  // A process restart cannot prove that a formerly running provider turn ended.
  if (read().plans.some(plan => plan.members.some(member => ['sending', 'pausing', 'running'].includes(member.status)))) mutate(image => {
    for (const plan of image.plans) for (const member of plan.members) if (['sending', 'pausing', 'running'].includes(member.status)) {
      const wasPausing = member.status === 'pausing';
      member.status = 'unknown'; member.lastError = 'Workflow restarted before the external outcome was confirmed';
      if (wasPausing && plan.status === 'active') plan.status = 'pause_pending';
    }
  });

  function close() {
    closing = true;
    return serial;
  }

  return { state, createPlan, start, tick, pause, reconcile, close };
}
