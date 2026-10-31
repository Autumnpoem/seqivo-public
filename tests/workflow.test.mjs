import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createWorkflow } from '../server/workflow.mjs';

async function fixture(t, { onStart, onPause, onInspect, now } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-test-'));
  const store = new Store(join(dir, 'board.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const project = store.project({ name: 'Project', directory: dir });
  const calls = [];
  const executionStates = new Map();
  const executors = new Map([['fake', {
    start: async request => { calls.push({ kind: 'start', ...request }); executionStates.set(request.taskId, 'running'); return onStart ? onStart(request) : { status: 'running' }; },
    pause: async request => { calls.push({ kind: 'pause', ...request }); return onPause ? onPause(request) : { status: 'paused' }; },
    inspect: async request => { calls.push({ kind: 'inspect', ...request }); return onInspect ? onInspect(request) : { status: executionStates.get(request.taskId) || 'unknown' }; },
  }]]);
  const workflow = createWorkflow({ store, executors, now });
  const task = (title, conversationId = '') => store.createTask({ projectId: project.id, title, goal: title, criteria: ['Done'], conversationId, executionProvider: 'fake' });
  const plan = (members, options = {}) => workflow.createPlan({ projectId: project.id, members, maxConcurrent: 3, maxStarts: 10, budgetMinutes: 60, ...options });
  return { dir, store, project, calls, executors, executionStates, workflow, task, plan };
}

const member = (task, other = {}) => ({ taskId: task.id, role: 'worker', provider: 'fake', ...other });

test('dependency waits for current human acceptance; submitted means awaiting review', async t => {
  const f = await fixture(t);
  const a = f.task('Build'), b = f.task('Deploy');
  const plan = await f.plan([member(a), member(b, { dependsOn: [a.id] })]);
  await f.workflow.start(plan.id);
  assert.deepEqual(f.calls.filter(c => c.kind === 'start').map(c => c.taskId), [a.id]);
  f.store.updateTask(a.id, { status: 'submitted' }, a.revision);
  await f.workflow.tick();
  assert.equal(f.workflow.state().plans[0].members[0].status, 'running');
  assert.equal(f.calls.filter(c => c.kind === 'start').length, 1);
  f.executionStates.set(a.id, 'completed');
  await f.workflow.tick();
  assert.equal(f.workflow.state().plans[0].members[0].status, 'awaiting_review');
  const evidence = f.store.addEvidence(a.id, { summary: 'Verified', reference: 'artifact', expectedRevision: f.store.getTask(a.id).revision });
  f.store.review(a.id, { decision: 'pass', summary: 'Accepted', expectedRevision: evidence.revision });
  await f.workflow.tick();
  assert.deepEqual(f.calls.filter(c => c.kind === 'start').map(c => c.taskId), [a.id, b.id]);
  assert.equal(f.workflow.state().plans[0].members[0].status, 'complete');
});

test('different plans cannot start the same task or write one registered workspace concurrently', async t => {
  const f = await fixture(t);
  const a = f.task('A'), b = f.task('B');
  const one = await f.plan([member(a)]), two = await f.plan([member(a)]), three = await f.plan([member(b)]);
  await f.workflow.start(one.id); await f.workflow.start(two.id); await f.workflow.start(three.id);
  assert.equal(f.calls.filter(c => c.kind === 'start').length, 1);
  assert.equal(f.workflow.state().plans.find(p => p.id === two.id).members[0].status, 'pending');
});

test('unknown start consumes budget, retains lease, and never retries after restart', async t => {
  const f = await fixture(t, { onStart: async () => { throw new Error('transport broke after send'); } });
  const a = f.task('A'), b = f.task('B');
  const one = await f.plan([member(a)], { maxStarts: 1 });
  const two = await f.plan([member(b)]);
  await f.workflow.start(one.id);
  assert.equal(f.workflow.state().plans.find(p => p.id === one.id).members[0].status, 'unknown');
  assert.equal(f.workflow.state().plans.find(p => p.id === one.id).starts, 1);
  const restarted = createWorkflow({ store: f.store, executors: f.executors });
  await restarted.start(two.id); await restarted.tick();
  assert.equal(f.calls.filter(c => c.kind === 'start').length, 1);
  assert.equal(restarted.state().plans.find(p => p.id === two.id).members[0].status, 'pending');
});

test('persisted sending intent becomes unknown on restart without calling executor', async t => {
  const f = await fixture(t);
  const a = f.task('A'), plan = await f.plan([member(a)]);
  const image = f.workflow.state();
  image.plans[0].status = 'active'; image.plans[0].members[0].status = 'sending';
  image.plans[0].members[0].commandId = 'durable-command';
  image.plans[0].members[0].lease = { taskId: a.id, workspace: f.project.directory, commandId: 'durable-command' };
  f.store.transaction(() => f.store.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(image), 'workflow.v1'));
  const restarted = createWorkflow({ store: f.store, executors: f.executors });
  await restarted.tick();
  assert.equal(restarted.state().plans[0].members[0].status, 'unknown');
  assert.equal(f.calls.filter(c => c.kind === 'start').length, 0);
});

test('wall-clock deadline and maxStarts each stop new launches', async t => {
  let time = 1_800_000_000_000;
  const f = await fixture(t, { now: () => time });
  const a = f.task('A'), b = f.task('B');
  const plan = await f.plan([member(a), member(b)], { budgetMinutes: 1, maxStarts: 1 });
  await f.workflow.start(plan.id);
  assert.equal(f.calls.filter(c => c.kind === 'start').length, 1);
  f.store.updateTask(a.id, { status: 'submitted' }, a.revision);
  f.executionStates.set(a.id, 'completed');
  time += 61_000;
  await f.workflow.tick();
  assert.equal(f.calls.filter(c => c.kind === 'start').length, 1);
  assert.equal(f.workflow.state().plans[0].status, 'budget_exhausted');
  const c = f.task('C'), d = f.task('D');
  const deadlinePlan = await f.plan([member(c), member(d)], { budgetMinutes: 1, maxStarts: 2 });
  await f.workflow.start(deadlinePlan.id);
  assert.equal(f.calls.filter(c => c.kind === 'start').length, 2);
  f.store.updateTask(c.id, { status: 'submitted' }, c.revision);
  f.executionStates.set(c.id, 'completed');
  time += 61_000;
  await f.workflow.tick();
  assert.equal(f.calls.filter(c => c.kind === 'start').length, 2);
  assert.equal(f.workflow.state().plans.find(p => p.id === deadlinePlan.id).status, 'budget_exhausted');
});

test('uncertain pause stays unknown and holds workspace lease', async t => {
  const f = await fixture(t, { onPause: async () => ({ status: 'unknown' }) });
  const a = f.task('A'), b = f.task('B');
  const one = await f.plan([member(a)]), two = await f.plan([member(b)]);
  await f.workflow.start(one.id);
  const paused = await f.workflow.pause(one.id);
  assert.equal(paused.status, 'pause_pending');
  assert.equal(paused.members[0].status, 'unknown');
  await f.workflow.start(two.id);
  assert.equal(f.calls.filter(c => c.kind === 'start').length, 1);
});

test('independent review uses another task, role and session; review executor receives evidence-only brief', async t => {
  const f = await fixture(t);
  const a = f.task('Implementation', 'same-session'), b = f.task('Review', 'same-session');
  await assert.rejects(f.plan([member(a, { reviewOf: a.id })]), /另一任务/);
  await assert.rejects(f.plan([member(a), member(b, { reviewOf: a.id })]), /同一角色/);
  await assert.rejects(f.plan([member(a), member(b, { role: 'reviewer', reviewOf: a.id })]), /不同会话/);
  const c = f.task('Separate review', 'new-session');
  const plan = await f.plan([member(a), member(c, { role: 'reviewer', reviewOf: a.id })]);
  await f.workflow.start(plan.id);
  f.store.updateTask(a.id, { status: 'submitted' }, a.revision);
  f.executionStates.set(a.id, 'completed');
  await f.workflow.tick();
  const call = f.calls.find(item => item.taskId === c.id);
  assert.equal(call.evidenceOnly, true);
  assert.match(call.instructions, /Do not perform human acceptance/);
  assert.notEqual(f.store.getTask(a.id).acceptance, 'passed');
});

test('manual submission and acceptance keep the workspace leased until provider confirms completion', async t => {
  const f = await fixture(t);
  const a = f.task('External writer'), b = f.task('Next writer');
  const one = await f.plan([member(a)]), two = await f.plan([member(b)]);
  await f.workflow.start(one.id);
  const submitted = f.store.updateTask(a.id, { status: 'submitted' }, a.revision);
  const evidenced = f.store.addEvidence(a.id, { summary: 'Human note', reference: 'local', expectedRevision: submitted.revision });
  f.store.review(a.id, { decision: 'pass', summary: 'Accepted', expectedRevision: evidenced.revision });
  await f.workflow.tick();
  assert.equal(f.workflow.state().plans.find(p => p.id === one.id).members[0].status, 'running');
  await f.workflow.start(two.id);
  assert.equal(f.calls.filter(c => c.kind === 'start').length, 1);
  f.executionStates.set(a.id, 'completed');
  await f.workflow.tick();
  assert.equal(f.workflow.state().plans.find(p => p.id === one.id).members[0].status, 'complete');
  assert.equal(f.calls.filter(c => c.kind === 'start').length, 2);
});

test('changed task baseline makes a completed provider result stale, not accepted', async t => {
  const f = await fixture(t);
  const a = f.task('Original goal'), plan = await f.plan([member(a)]);
  await f.workflow.start(plan.id);
  const changed = f.store.updateTask(a.id, { goal: 'New goal' }, a.revision);
  f.store.updateTask(a.id, { status: 'submitted' }, changed.revision);
  f.executionStates.set(a.id, 'completed');
  await f.workflow.tick();
  const current = f.workflow.state().plans[0].members[0];
  assert.equal(current.status, 'stale');
  assert.equal(current.lease, null);
});

test('executor identity must match the task binding and support read-only inspection', async t => {
  const f = await fixture(t);
  const other = f.store.createTask({ projectId: f.project.id, title: 'Bound elsewhere', executionProvider: 'other' });
  await assert.rejects(f.plan([member(other)]), /其他执行器/);
  const a = f.task('Inspect required');
  f.executors.set('fake', { start: async () => ({ status: 'running' }), pause: async () => ({ status: 'paused' }) });
  await assert.rejects(f.plan([member(a)]), /执行器不可用/);
});

test('pause intent during a slow start prevents another launch', async t => {
  let releaseStart;
  const entered = new Promise(resolve => { releaseStart = { entered: resolve }; });
  const f = await fixture(t, { onStart: async () => {
    releaseStart.entered();
    return new Promise(resolve => { releaseStart.finish = resolve; });
  } });
  const a = f.task('A'), b = f.task('B');
  const plan = await f.plan([member(a), member(b)]);
  const starting = f.workflow.start(plan.id);
  await entered;
  const pausing = f.workflow.pause(plan.id);
  releaseStart.finish({ status: 'waiting_quota' });
  await starting;
  const paused = await pausing;
  assert.equal(paused.status, 'paused');
  assert.equal(f.calls.filter(c => c.kind === 'start').length, 1);
});

test('close drains the active start and prevents a subsequent dispatch or tick', async t => {
  let enter, finish;
  const entered = new Promise(resolve => { enter = resolve; });
  const f = await fixture(t, { onStart: async () => { enter(); return new Promise(resolve => { finish = resolve; }); } });
  const a = f.task('A'), b = f.task('B');
  const plan = await f.plan([member(a), member(b)]);
  const starting = f.workflow.start(plan.id);
  await entered;
  const closing = f.workflow.close();
  finish({ status: 'waiting_quota' });
  await starting; await closing;
  assert.equal(f.calls.filter(c => c.kind === 'start').length, 1);
  await assert.rejects(f.workflow.tick(), /关闭/);
});

test('restart downgrades running to unknown; reconcile requires provider confirmation', async t => {
  const f = await fixture(t);
  const a = f.task('A'), plan = await f.plan([member(a)]);
  await f.workflow.start(plan.id);
  const restarted = createWorkflow({ store: f.store, executors: f.executors });
  assert.equal(restarted.state().plans[0].members[0].status, 'unknown');
  f.executionStates.set(a.id, 'unknown');
  await assert.rejects(restarted.reconcile(plan.id, { taskId: a.id, confirm: true }), /尚未确认/);
  assert.ok(restarted.state().plans[0].members[0].lease);
  f.executionStates.set(a.id, 'running');
  const recovered = await restarted.reconcile(plan.id, { taskId: a.id, confirm: true });
  assert.equal(recovered.members[0].status, 'running');
  assert.ok(recovered.members[0].lease);
});

test('provider-confirmed not_started releases an unknown command without calling it completed or retrying', async t => {
  const f = await fixture(t);
  const a = f.task('Unsent'), b = f.task('Next');
  const first = await f.plan([member(a)]), second = await f.plan([member(b)]);
  await f.workflow.start(first.id);
  const restarted = createWorkflow({ store: f.store, executors: f.executors });
  assert.equal(restarted.state().plans.find(p => p.id === first.id).members[0].status, 'unknown');
  f.executionStates.set(a.id, 'not_started');
  await restarted.start(second.id);
  const prior = restarted.state().plans.find(p => p.id === first.id).members[0];
  assert.equal(prior.status, 'blocked');
  assert.equal(prior.lease, null);
  assert.equal(prior.completionConfirmedAt, null);
  assert.deepEqual(f.calls.filter(c => c.kind === 'start').map(c => c.taskId), [a.id, b.id]);
  await restarted.tick();
  assert.equal(f.calls.filter(c => c.kind === 'start' && c.taskId === a.id).length, 1);
});

test('workflow persists the provider-reported actual model', async t => {
  const f = await fixture(t, {
    onStart: async () => ({ status: 'running', actualModel: 'model-at-send' }),
    onInspect: async () => ({ status: 'running', actualModel: 'model-verified' }),
  });
  const a = f.task('Model evidence'), plan = await f.plan([member(a, { model: 'requested-model' })]);
  await f.workflow.start(plan.id);
  assert.equal(f.workflow.state().plans[0].members[0].actualModel, 'model-at-send');
  await f.workflow.tick();
  const recorded = f.workflow.state().plans[0].members[0];
  assert.equal(recorded.model, 'requested-model');
  assert.equal(recorded.actualModel, 'model-verified');
});

test('provider-confirmed failure and pause release leases without retrying their commands', async t => {
  const f = await fixture(t);
  const a = f.task('A'), b = f.task('B'), c = f.task('C');
  const first = await f.plan([member(a)]), second = await f.plan([member(b)]), third = await f.plan([member(c)]);
  await f.workflow.start(first.id); await f.workflow.start(second.id); await f.workflow.start(third.id);
  assert.equal(f.calls.filter(c => c.kind === 'start').length, 1);
  f.executionStates.set(a.id, 'failed');
  await f.workflow.tick();
  assert.equal(f.workflow.state().plans.find(p => p.id === first.id).members[0].status, 'failed');
  assert.deepEqual(f.calls.filter(c => c.kind === 'start').map(c => c.taskId), [a.id, b.id]);
  f.executionStates.set(b.id, 'paused');
  await f.workflow.tick();
  assert.equal(f.workflow.state().plans.find(p => p.id === second.id).members[0].status, 'paused');
  assert.deepEqual(f.calls.filter(c => c.kind === 'start').map(c => c.taskId), [a.id, b.id, c.id]);
});

test('busy diagnostic explains unknown execution without releasing its lease or retrying after restart', async t => {
  const f = await fixture(t, { onInspect: async () => ({
    status: 'unknown', error: 'PRIVATE_PROVIDER_TEXT',
    diagnostic: { providerFailure: { category: 'busy', summary: 'PRIVATE_PROVIDER_TEXT' } },
  }) });
  const a = f.task('Busy'), b = f.task('Blocked by original workspace');
  const first = await f.plan([member(a)]), second = await f.plan([member(b)]);
  await f.workflow.start(first.id);
  const original = f.workflow.state().plans.find(p => p.id === first.id).members[0];
  await f.workflow.start(second.id);
  const restarted = createWorkflow({ store: f.store, executors: f.executors });
  await restarted.tick();
  const current = restarted.state().plans.find(p => p.id === first.id).members[0];
  assert.equal(current.status, 'unknown');
  assert.deepEqual(current.lease, original.lease);
  assert.equal(current.completionConfirmedAt, null);
  assert.equal(current.lastError, '模型服务当前繁忙。本轮结果尚未核实，工作区保持占用；请先核实执行状态。');
  assert.equal(JSON.stringify(restarted.state()).includes('PRIVATE_PROVIDER_TEXT'), false);
  assert.equal(restarted.state().plans.find(p => p.id === second.id).members[0].status, 'pending');
  assert.deepEqual(f.calls.filter(c => c.kind === 'start').map(c => c.taskId), [a.id]);
});

test('confirmed provider failure displays only a fixed label and preserves normal lease release', async t => {
  let confirmed = false;
  const f = await fixture(t, { onInspect: async () => confirmed ? ({
    status: 'failed', diagnostic: { providerFailure: { category: 'auth', summary: 'PRIVATE_AUTH_TEXT' } },
  }) : ({ status: 'running' }) });
  const a = f.task('Authentication failure'), b = f.task('Next');
  const first = await f.plan([member(a)]), second = await f.plan([member(b)]);
  await f.workflow.start(first.id); await f.workflow.start(second.id);
  confirmed = true;
  await f.workflow.tick();
  const failed = f.workflow.state().plans.find(p => p.id === first.id).members[0];
  assert.equal(failed.status, 'failed');
  assert.equal(failed.lease, null);
  assert.ok(failed.completionConfirmedAt);
  assert.equal(failed.lastError, '模型服务认证失败，请检查当前登录状态。本轮已停止，未自动重试。');
  assert.equal(JSON.stringify(f.workflow.state()).includes('PRIVATE_AUTH_TEXT'), false);
  assert.deepEqual(f.calls.filter(c => c.kind === 'start').map(c => c.taskId), [a.id, b.id]);
});
