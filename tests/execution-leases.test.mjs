import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createExecutionLeases } from '../server/execution-leases.mjs';
import { createWorkflow } from '../server/workflow.mjs';

async function fixture(t, inspect = async () => ({ status: 'unknown' })) {
  const dir = await mkdtemp(join(tmpdir(), 'execution-lease-test-'));
  const store = new Store(join(dir, 'board.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const project = store.project({ name: 'Workspace', directory: dir });
  const task = title => store.createTask({ projectId: project.id, title, conversationId: `thread-${title}`, executionProvider: 'fake' });
  return { dir, store, project, task, leases: createExecutionLeases({ store, inspect }) };
}

test('reservation is durable, idempotent without permission to resend, and serializes a workspace', async t => {
  const f = await fixture(t);
  const a = f.task('A'), b = f.task('B');
  const requests = [
    { taskId: a.id, commandId: 'first', provider: 'fake' },
    { taskId: b.id, commandId: 'second', provider: 'fake' },
  ];
  const outcomes = await Promise.allSettled(requests.map(request => Promise.resolve().then(() => f.leases.reserve(request))));
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(item => item.status === 'rejected')[0].reason.code, 'EXECUTION_BUSY');
  const winner = requests[outcomes.findIndex(item => item.status === 'fulfilled')];
  assert.equal(f.leases.reserve(winner).maySend, false);
  assert.equal(f.leases.reserve(winner).duplicate, true);
  assert.throws(() => f.leases.reserve({ ...winner, commandId: 'new-command' }), { code: 'EXECUTION_BUSY' });
  assert.throws(() => f.leases.releaseConfirmed({ taskId: winner.taskId, commandId: 'wrong', status: 'completed' }), { code: 'EXECUTION_NOT_FOUND' });
  assert.throws(() => f.leases.releaseConfirmed({ taskId: winner.taskId, commandId: winner.commandId, status: 'unknown' }), { code: 'EXECUTION_UNCONFIRMED' });
  assert.equal(f.leases.state().active.length, 1);
  assert.equal(f.leases.state().active[0].workspace, undefined);
  f.leases.releaseConfirmed({ taskId: winner.taskId, commandId: winner.commandId, status: 'completed' });
  assert.equal(f.leases.state().active.length, 0);
  assert.equal(f.leases.reserve(winner).maySend, false);
  assert.equal(f.leases.reserve(requests[1 - requests.indexOf(winner)]).maySend, true);
});

test('unknown survives registry restart; only an inspected terminal result releases it', async t => {
  let providerStatus = 'unknown';
  const f = await fixture(t, async () => ({ status: providerStatus, actualModel: 'verified-model' }));
  const a = f.task('A'), b = f.task('B');
  f.leases.reserve({ taskId: a.id, commandId: 'cmd', provider: 'fake' });
  const restarted = createExecutionLeases({ store: f.store, inspect: async () => ({ status: providerStatus, actualModel: 'verified-model' }) });
  assert.equal(restarted.available({ taskId: b.id, workspace: f.dir }), false);
  assert.deepEqual(await restarted.reconcile(), { inspected: 1, released: 0, active: 1 });
  assert.equal(restarted.state().active[0].status, 'unknown');
  providerStatus = 'completed';
  assert.deepEqual(await restarted.reconcile(), { inspected: 1, released: 1, active: 0 });
  assert.equal(restarted.state().recent[0].actualModel, 'verified-model');
  assert.equal(restarted.available({ taskId: b.id, workspace: f.dir }), true);
});

test('Linux process-stop receipt keeps an unknown command fenced across reconciliation and restart', async t => {
  const f = await fixture(t, async () => ({ status: 'completed' }));
  const task = f.store.createTask({ projectId: f.project.id, title: 'Linux unknown result',
    conversationId: 'original-thread', executionProvider: 'codex-autocontinue' });
  const input = { taskId: task.id, commandId: 'original-command', provider: 'codex-autocontinue' };
  const receipt = { version: 1, scope: 'linux-original-task-job-and-current-writers',
    taskId: task.id, projectId: f.project.id, commandId: input.commandId,
    workspace: realpathSync(f.dir), worktreeId: null, threadId: 'original-thread', turnId: 'original-turn',
    recordId: 'a'.repeat(32), recordGeneration: 4, expectedHandoffGeneration: null, bridgePid: 123, appServerPid: 124 };
  assert.throws(() => f.leases.markLinuxStoppedUnknown({ ...input, receipt }), { code: 'EXECUTION_UNCONFIRMED' });
  f.leases.reserve(input);
  assert.throws(() => f.leases.markLinuxStoppedUnknown({ ...input, receipt: { ...receipt, turnId: null } }),
    { code: 'EXECUTION_UNCONFIRMED' });
  f.leases.markLinuxStoppedUnknown({ ...input, receipt });
  const restarted = createExecutionLeases({ store: f.store, inspect: async () => ({ status: 'completed' }) });
  assert.deepEqual(await restarted.reconcile(), { inspected: 0, released: 0, active: 1 });
  assert.equal(restarted.state().active[0].status, 'unknown');
  assert.equal(restarted.state().active[0].shutdownStoppedReceipt, undefined);
  assert.throws(() => restarted.reserve({ ...input, commandId: 'do-not-replay' }), { code: 'EXECUTION_BUSY' });
  assert.throws(() => restarted.releaseConfirmed({ ...input, status: 'completed' }), { code: 'EXECUTION_UNCONFIRMED' });
  assert.throws(() => restarted.markLinuxStoppedUnknown({ ...input, receipt: { ...receipt, turnId: 'another-turn' } }),
    { code: 'EXECUTION_UNCONFIRMED' });
  const events = f.store.db.prepare("SELECT type FROM events WHERE type='execution.confirmed'").all();
  assert.equal(events.length, 0);
});

test('symlink aliases resolve to the registered directory and cannot bypass an active lease', async t => {
  const f = await fixture(t);
  const a = f.task('A'), b = f.task('B');
  const alias = join(f.dir, 'alias');
  await symlink(f.dir, alias, 'dir');
  f.leases.reserve({ taskId: a.id, commandId: 'cmd', provider: 'fake' });
  assert.equal(f.leases.available({ taskId: b.id, workspace: alias }), false);
  f.leases.releaseConfirmed({ taskId: a.id, commandId: 'cmd', status: 'not_started' });
  assert.equal(f.leases.available({ taskId: b.id, workspace: alias }), true);
  const unbound = f.store.createTask({ projectId: f.project.id, title: 'Unbound', executionProvider: 'fake' });
  assert.equal(f.leases.available({ taskId: unbound.id, workspace: f.dir }), true);
  assert.throws(() => f.leases.reserve({ taskId: unbound.id, commandId: 'no-thread', provider: 'fake' }), { code: 'EXECUTION_UNBOUND' });
});

test('ancestor and nested projects cannot reserve overlapping original workspaces', async t => {
  const f = await fixture(t);
  const nested = join(f.dir, 'nested');
  const sibling = join(f.dir, 'sibling');
  await mkdir(nested); await mkdir(sibling);
  const child = f.store.project({ name: 'Nested', directory: nested });
  const other = f.store.project({ name: 'Sibling', directory: sibling });
  const parentTask = f.task('Parent');
  const childTask = f.store.createTask({ projectId: child.id, title: 'Child', conversationId: 'thread-child', executionProvider: 'fake' });
  const siblingTask = f.store.createTask({ projectId: other.id, title: 'Sibling', conversationId: 'thread-sibling', executionProvider: 'fake' });
  f.leases.reserve({ taskId: parentTask.id, commandId: 'parent', provider: 'fake' });
  assert.equal(f.leases.available({ taskId: childTask.id, workspace: nested }), false);
  assert.throws(() => f.leases.reserve({ taskId: childTask.id, commandId: 'child', provider: 'fake' }), { code: 'EXECUTION_BUSY' });
  assert.equal(f.leases.activeOverlaps(child.id).length, 1);
  assert.equal(f.leases.activeOverlaps(child.id)[0].projectId, f.project.id);
  assert.equal(f.leases.activeOverlaps(child.id)[0].workspace, undefined);
  assert.equal(f.leases.available({ taskId: siblingTask.id, workspace: sibling }), false); // parent contains both children
  f.leases.releaseConfirmed({ taskId: parentTask.id, commandId: 'parent', status: 'paused' });
  f.leases.reserve({ taskId: childTask.id, commandId: 'child', provider: 'fake' });
  assert.equal(f.leases.available({ taskId: siblingTask.id, workspace: sibling }), true);
  assert.equal(f.leases.available({ taskId: parentTask.id, workspace: f.dir }), false);
  assert.throws(() => f.leases.reserve({ taskId: parentTask.id, commandId: 'parent-new', provider: 'fake' }), { code: 'EXECUTION_BUSY' });
});

test('changed project binding does not erase an active reservation original workspace', async t => {
  const f = await fixture(t);
  const original = join(f.dir, 'original'), elsewhere = join(f.dir, 'elsewhere');
  await mkdir(original); await mkdir(elsewhere);
  const owner = f.store.project({ name: 'Owner', directory: original });
  const task = f.store.createTask({ projectId: owner.id, title: 'Writer', conversationId: 'thread-writer', executionProvider: 'fake' });
  f.leases.reserve({ taskId: task.id, commandId: 'writer', provider: 'fake' });
  // Simulate stale/corrupted binding; public bindDirectory correctly refuses a bound task.
  const changed = { ...owner, directory: realpathSync(elsewhere) };
  f.store.db.prepare('UPDATE projects SET directory=?,data=? WHERE id=?').run(changed.directory, JSON.stringify(changed), owner.id);
  const nested = join(original, 'nested'); await mkdir(nested);
  const nestedProject = f.store.project({ name: 'Nested', directory: nested });
  assert.equal(f.leases.activeOverlaps(nestedProject.id)[0].projectId, owner.id);
  assert.equal(f.leases.activeOverlaps(owner.id)[0].projectId, owner.id);
  const nestedTask = f.store.createTask({ projectId: nestedProject.id, title: 'Nested writer', conversationId: 'thread-nested', executionProvider: 'fake' });
  assert.equal(f.leases.available({ taskId: nestedTask.id, workspace: nested }), false);
  assert.throws(() => f.leases.reserve({ taskId: nestedTask.id, commandId: 'nested', provider: 'fake' }), { code: 'EXECUTION_BUSY' });
});

test('workflow waits for an unrelated automatic execution in the same workspace', async t => {
  const f = await fixture(t);
  const auto = f.task('Auto'), queued = f.task('Queued');
  f.leases.reserve({ taskId: auto.id, commandId: 'auto-command', provider: 'fake' });
  let starts = 0;
  const executors = new Map([['fake', {
    canStart: request => f.leases.available(request),
    start: async () => { starts++; return { status: 'running' }; },
    pause: async () => ({ status: 'paused' }),
    inspect: async () => ({ status: 'running' }),
  }]]);
  const workflow = createWorkflow({ store: f.store, executors });
  const plan = await workflow.createPlan({ projectId: f.project.id, members: [{ taskId: queued.id, role: 'worker', provider: 'fake' }], maxConcurrent: 1, maxStarts: 2, budgetMinutes: 60 });
  await workflow.start(plan.id);
  assert.equal(starts, 0);
  assert.equal(workflow.state().plans[0].members[0].status, 'pending');
  f.leases.releaseConfirmed({ taskId: auto.id, commandId: 'auto-command', status: 'not_started' });
  await workflow.tick();
  assert.equal(starts, 1);
  assert.equal(workflow.state().plans[0].members[0].status, 'running');
  await workflow.close();
});

test('reconcile inspects at most ten active reservations per tick and rotates', async t => {
  const seen = [];
  const f = await fixture(t, async request => { seen.push(request.commandId); return { status: 'unknown' }; });
  for (let i = 0; i < 11; i++) {
    const directory = join(f.dir, `workspace-${i}`);
    await mkdir(directory);
    const project = f.store.project({ name: `Project ${i}`, directory });
    const task = f.store.createTask({ projectId: project.id, title: `Task ${i}`, conversationId: `thread-${i}`, executionProvider: 'fake' });
    f.leases.reserve({ taskId: task.id, commandId: `cmd-${i}`, provider: 'fake' });
  }
  assert.equal((await f.leases.reconcile()).inspected, 10);
  assert.equal(seen.length, 10);
  assert.equal(seen.includes('cmd-10'), false);
  assert.equal((await f.leases.reconcile()).inspected, 10);
  assert.equal(seen.includes('cmd-10'), true);
  assert.equal(f.leases.state().active.length, 11);
});
