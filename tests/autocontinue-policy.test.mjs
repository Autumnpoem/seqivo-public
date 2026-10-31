import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlugin } from '../plugins/codex-autocontinue/host.mjs';
import * as realTaskJobBackend from '../plugins/codex-autocontinue/job-transport.mjs';
import { readJobRecord } from '../server/macos-executor-job-record.mjs';
import { nativeProcessTable } from '../server/codex-process-proof.mjs';
import { validateBudgetMinutes, deadlineFor, budgetRemainingSeconds, automaticStop } from
  '../plugins/codex-autocontinue/auto-policy.mjs';

const pythonPath = process.env.TASKBOARD_TEST_PYTHON || '';
const pluginDir = fileURLToPath(new URL('../plugins/codex-autocontinue/', import.meta.url));
const fixture = fileURLToPath(new URL('./plugin-fake-codex.py', import.meta.url));

test('automatic policy uses a fixed finite deadline and conservative legacy state', () => {
  assert.throws(() => validateBudgetMinutes(0), /budgetMinutes/);
  assert.throws(() => validateBudgetMinutes(10081), /budgetMinutes/);
  const startedAt = '2026-01-01T00:00:00.000Z';
  const policy = { startedAt, deadlineAt: deadlineFor(startedAt, 1), budgetMinutes: 1,
    attempts: 0, maxAttempts: 2 };
  assert.equal(budgetRemainingSeconds(policy, Date.parse(startedAt)), 60);
  assert.equal(automaticStop(policy, Date.parse(startedAt) + 60_000)?.stopReason, 'budget_expired');
  assert.equal(automaticStop({ ...policy, attempts: 2 }, Date.parse(startedAt))?.stopReason, 'attempt_limit');
  assert.equal(automaticStop({ ...policy, attempts: -1 }, Date.parse(startedAt))?.stopReason, 'attempt_limit');
  assert.equal(automaticStop({ ...policy, maxAttempts: 0 }, Date.parse(startedAt))?.stopReason, 'attempt_limit');
  assert.equal(automaticStop({ ...policy, deadlineAt: null }, Date.parse(startedAt))?.stopReason,
    'legacy_plan_missing_deadline');
});

async function setup({ authorizeExecution, revalidateExecution, beforeStateWrite, now, scenario = {},
  onGetTask, onGetProject, onUpdateTask, secondTask = false, verifyRetired, nativeJob = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'taskboard-auto-policy-'));
  const secondDirectory = secondTask ? await mkdtemp(join(tmpdir(), 'taskboard-auto-other-')) : null;
  const executable = join(dir, 'fake-codex.py');
  const logPath = join(dir, 'appserver.log');
  await copyFile(fixture, executable);
  await chmod(executable, 0o700);
  await writeFile(logPath, '');
  const scenarioPath = join(dir, 'scenario.json');
  await writeFile(scenarioPath, JSON.stringify(secondTask ? {
    ...scenario, threadCwds: { ...scenario.threadCwds, 'thread-2': secondDirectory },
  } : scenario));
  process.env.TASKBOARD_FAKE_SCENARIO = scenarioPath;
  process.env.TASKBOARD_FAKE_LOG = logPath;
  process.env.TASKBOARD_FAKE_PID = join(dir, 'appserver.pid');
  process.env.TASKBOARD_FAKE_CWD = dir;
  process.env.TASKBOARD_FAKE_CHILD_PID = join(dir, 'late-child.pid');
  process.env.TASKBOARD_FAKE_LATE_WRITE = join(dir, 'late-write.txt');
  process.env.TASKBOARD_FAKE_CHILD_SCRIPT = join(dir, 'late-child.py');
  await writeFile(process.env.TASKBOARD_FAKE_CHILD_SCRIPT, '');
  let task = { id: 't1', projectId: 'p1', title: 'Task', goal: 'Finish', criteria: [],
    conversationId: 'thread-1', status: 'blocked', blockedReason: 'Codex quota exhausted',
    acceptance: 'unverified', revision: 1, contentVersion: 1 };
  const otherTask = secondTask ? { ...task, id: 't2', projectId: 'p2', conversationId: 'thread-2' } : null;
  let projectDirectory = dir;
  const stateDir = join(dir, 'state');
  await mkdir(stateDir);
  // These are policy tests, not ancestry tests. Keep the real fake app-server
  // lifecycle and require its observed OS exit, while isolating unrelated
  // all-system snapshot churn from this fixture's retirement result.
  const processProof = {
    captureExecutorBaseline: async () => ({ verified: true, baseline: { fixture: true } }),
    captureTaskExecutorTree: async ({ bridgePid, appServerPid }) => ({ verified: true,
      capture: { bridgePid, appServerPid } }),
    verifyTaskExecutorRetired: async ({ bridgePid, appServerPid }) => {
      if (verifyRetired) return verifyRetired({ bridgePid, appServerPid });
      await waitPidGone(bridgePid);
      if (appServerPid && appServerPid !== bridgePid) await waitPidGone(appServerPid);
      return { verified: true, retired: true };
    },
  };
  const options = { taskJobBackend: nativeJob ? realTaskJobBackend : null, dataDir: stateDir, pluginDir, now,
    authorizeExecution, revalidateExecution, beforeStateWrite,
    ...(nativeJob ? {} : { processProof }),
    getTask: async id => { onGetTask?.(id, task); return id === task.id ? task : id === otherTask?.id ? otherTask : null; },
    getProject: async id => { await onGetProject?.(id, projectDirectory); return id === 'p1' ? { id, directory: projectDirectory }
      : id === 'p2' && secondTask ? { id, directory: secondDirectory } : null; },
    updateTask: async (id, patch, revision) => {
      assert.equal(id, task.id); assert.equal(revision, task.revision);
      task = { ...task, ...patch, revision: revision + 1 };
      await onUpdateTask?.(task,patch,scenarioPath);
      return task;
    } };
  const plugin = createPlugin(options);
  await plugin.configure({ pythonPath, codexPath: executable, pollSeconds: 86400 });
  const calls = async method => (await readFile(logPath, 'utf8')).trim().split('\n')
    .filter(Boolean).map(JSON.parse).filter(row => row.method === method);
  const persisted = async () => JSON.parse(await readFile(join(stateDir, 'codex-autocontinue.json'), 'utf8'));
  return { plugin, options, calls, persisted, task: () => task, otherTask,
    changeTask: patch => { task = { ...task, ...patch }; },
    changeProjectDirectory: directory => { projectDirectory = directory; }, directory: dir,
    secondDirectory, extraPlugins: [],
    pidPath: process.env.TASKBOARD_FAKE_PID };
}

async function waitPidGone(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  for (let attempt = 0; attempt < 30; attempt++) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('fixture app-server identity remains alive after plugin close');
}

async function closeChecked(x) {
  await x.plugin.close();
  let pid;
  try { pid = Number(await readFile(x.pidPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await waitPidGone(pid);
}

async function withFixture(x, body) {
  const failures = [];
  try { await body(); } catch (error) { failures.push(error); }
  for (const plugin of [...x.extraPlugins].reverse()) {
    try { await closeChecked({ ...x, plugin }); }
    catch (error) { failures.push(new Error('Restarted fixture close or OS process retirement failed', { cause: error })); }
  }
  try { await closeChecked(x); }
  catch (error) { failures.push(new Error('Fixture close or OS process retirement failed', { cause: error })); }
  if (failures.length) throw new AggregateError(failures, 'Automatic policy body or cleanup failed');
}

async function assertOriginalNativeJobRetired(marker, rows) {
  assert.equal(marker?.kind, 'macos-job');
  assert.match(marker.recordId, /^[a-f0-9]{32}$/);
  const record = await readJobRecord(marker.recordRoot, marker.recordId,
    marker.taskId, marker.canonicalWorkspace);
  assert.equal(record.phase, 'retired');
  assert.equal(record.attempted, true);
  const original = record.identity;
  assert.ok(Number.isSafeInteger(original?.pid) && original.pid > 1);
  assert.ok(Number.isSafeInteger(original?.startSec) && Number.isSafeInteger(original?.startUsec));
  const coalition = original.coalition?.resource;
  assert.ok(coalition !== null && coalition !== undefined && String(coalition) !== '0');
  const current = rows.get(original.pid);
  assert.equal(Boolean(current && ['pid', 'startSec', 'startUsec']
    .every(key => current[key] === original[key])), false, 'original job birth identity is still live');
  assert.deepEqual([...rows.values()].filter(row => String(row.coalition?.resource) === String(coalition))
    .map(row => row.pid), [], 'original resource coalition still has a visible member');
  return record;
}

async function reached(gate, description) {
  let timer;
  try {
    await Promise.race([gate, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} was not reached`)), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitFirstQuotaResult(x) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const saved = await x.persisted();
    const commands = Object.values(saved.commands).filter(command => command.taskId === 't1');
    if (commands.length === 1 && commands[0].status === 'failed' &&
        commands[0].stopProof?.status === 'verified' && x.task().status === 'blocked')
      return saved;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('first quota turn did not reach a durable failed result with verified process exit');
}

test('failed automatic preflight reserves one durable ID and never retries on check',
  { concurrency: false }, async () => {
    const x = await setup({ authorizeExecution: async () => { throw new Error('approval changed'); } });
    await withFixture(x, async () => {
      await x.plugin.setPolicy({ taskId: 't1', enabled: true, maxAttempts: 3 });
      await x.plugin.enable();
      await x.plugin.check(); await x.plugin.check();
      const saved = await x.persisted();
      assert.equal(saved.policies[0].attempts, 1);
      assert.match(saved.policies[0].pendingAutoCommandId, /^auto-/);
      assert.equal(saved.policies[0].status, 'retry_stopped');
      assert.equal(saved.policies[0].stopReason, 'retry_failed');
      assert.equal((await x.calls('turn/start')).length, 0);
      await closeChecked(x);
      const restart = createPlugin(x.options);
      x.extraPlugins.push(restart);
      await restart.check();
      assert.equal(restart.state().policies[0].status, 'retry_stopped');
      assert.equal(restart.state().policies[0].attempts, 1);
      assert.equal((await x.calls('turn/start')).length, 0);
    });
  });

test('a stopped preflight restarts by retiring only its own idle executor',
  { concurrency: false }, async () => {
    let authorized = false;
    const x = await setup({ authorizeExecution: async () => {
      if (!authorized) throw new Error('injected authorization failure');
      return true;
    } });
    await withFixture(x, async () => {
      await x.plugin.setPolicy({ taskId: 't1', enabled: true });
      await x.plugin.enable(); await x.plugin.check();
      assert.equal(x.plugin.state().policies[0].status, 'retry_stopped');
      const originalPid = Number(await readFile(x.pidPath, 'utf8'));
      authorized = true;
      const restarted = await x.plugin.setPolicy({ taskId: 't1', enabled: true, restart: true });
      await waitPidGone(originalPid);
      assert.equal((await x.persisted()).executors['task:t1'], undefined);
      assert.equal(restarted.policies[0].attempts, 0);
      assert.equal(restarted.policies[0].stopReason, null);
      await x.plugin.check();
      assert.equal((await x.calls('turn/start')).length, 1);
      const first = (await x.persisted()).policies.find(item => item.taskId === 't1');
      assert.equal(first.restartBinding, null, 'first observed running turn clears the one-turn binding');
      x.changeTask({ revision: x.task().revision + 1, contentVersion: x.task().contentVersion + 1 });
      await x.plugin.check();
      assert.notEqual(x.plugin.state().policies.find(item => item.taskId === 't1').stopReason,
        'restart_binding_changed', 'later task edits do not inherit the first-turn guard');
    });
  });

test('restart continues a changed task into a second real fake-provider turn without carrying its first-turn binding',
  { concurrency: false }, async () => {
    let authorized = false;
    const x = await setup({ scenario: { completeStatus: 'failed', turnError: 'quota exhausted' },
      authorizeExecution: async () => { if (!authorized) throw new Error('injected preflight failure'); return true; } });
    await withFixture(x, async () => {
      await x.plugin.setPolicy({ taskId: 't1', enabled: true, maxAttempts: 2, budgetMinutes: 1 });
      await x.plugin.enable(); await x.plugin.check();
      assert.equal(x.plugin.state().policies[0].status, 'retry_stopped');
      authorized = true;
      const restarted = await x.plugin.setPolicy({ taskId: 't1', enabled: true, restart: true });
      const deadlineAt = restarted.policies[0].deadlineAt;
      const afterFirst = await waitFirstQuotaResult(x);
      assert.equal(afterFirst.policies[0].restartBinding, null);
      assert.equal(afterFirst.policies[0].attempts, 1);
      assert.equal(x.task().status, 'blocked');
      assert.ok(x.task().revision > 1, 'the first turn advanced the real host task revision');
      assert.equal((await x.calls('turn/start')).length, 1);
      // The same fixture provider reads its scenario on each request. Keep the
      // second turn in progress so completion evidence cannot reuse its static
      // test turn ID; the assertion here is the second actual turn/start.
      await writeFile(join(x.directory, 'scenario.json'), JSON.stringify({}));
      await x.plugin.check();
      const turns = await x.calls('turn/start');
      assert.equal(turns.length, 2);
      const afterSecond = await x.persisted();
      assert.equal(afterSecond.policies[0].attempts, 2);
      assert.equal(afterSecond.policies[0].deadlineAt, deadlineAt);
      assert.notEqual(afterSecond.policies[0].stopReason, 'restart_binding_changed');
      assert.equal(Object.values(afterSecond.commands).filter(command => command.taskId === 't1').length, 2);
    });
  });

for (const limit of ['attempts', 'deadline']) {
  test(`restart quota completion respects the fixed ${limit} limit before a second provider turn`,
    { concurrency: false }, async () => {
      let authorized = false, clock = Date.parse('2026-01-01T00:00:00.000Z');
      const x = await setup({ now: () => clock,
        scenario: { completeStatus: 'failed', turnError: 'quota exhausted' },
        authorizeExecution: async () => { if (!authorized) throw new Error('injected preflight failure'); return true; } });
      await withFixture(x, async () => {
        await x.plugin.setPolicy({ taskId: 't1', enabled: true, maxAttempts: limit === 'attempts' ? 1 : 2,
          budgetMinutes: 1 });
        await x.plugin.enable(); await x.plugin.check();
        authorized = true;
        const restarted = await x.plugin.setPolicy({ taskId: 't1', enabled: true, restart: true });
        const deadlineAt = restarted.policies[0].deadlineAt;
        await waitFirstQuotaResult(x);
        if (limit === 'deadline') clock += 61_000;
        await x.plugin.check();
        const policy = x.plugin.state().policies[0];
        assert.equal(policy.status, limit === 'attempts' ? 'attempts_exhausted' : 'budget_exhausted');
        assert.equal(policy.deadlineAt, deadlineAt);
        assert.equal(policy.attempts, 1);
        assert.equal((await x.calls('turn/start')).length, 1);
      });
    });
}

test('manual pause after the restarted first turn forbids a second provider turn',
  { concurrency: false }, async () => {
    let authorized = false;
    const x = await setup({ scenario: { notifyInterrupted: true },
      authorizeExecution: async () => { if (!authorized) throw new Error('injected preflight failure'); return true; } });
    await withFixture(x, async () => {
      await x.plugin.setPolicy({ taskId: 't1', enabled: true, maxAttempts: 2 });
      await x.plugin.enable(); await x.plugin.check();
      authorized = true;
      await x.plugin.setPolicy({ taskId: 't1', enabled: true, restart: true });
      await x.plugin.check();
      assert.equal((await x.calls('turn/start')).length, 1);
      const paused = await x.plugin.pause({ taskId: 't1', expectedRevision: x.task().revision });
      assert.equal(paused.status, 'paused');
      await x.plugin.check();
      assert.equal(x.plugin.state().policies[0].status, 'paused');
      assert.equal((await x.calls('turn/start')).length, 1);
    });
  });

test('restarting one stopped task leaves another task executor and policy untouched',
  { concurrency: false }, async () => {
    const x = await setup({ secondTask: true,
      authorizeExecution: async ({ taskId }) => { if (taskId === 't1') throw new Error('injected preflight failure'); return true; } });
    await withFixture(x, async () => {
      await x.plugin.setPolicy({ taskId: 't1', enabled: true });
      await x.plugin.enable(); await x.plugin.check();
      assert.equal(x.plugin.state().policies[0].status, 'retry_stopped');
      await x.plugin.setPolicy({ taskId: 't2', enabled: false });
      await x.plugin.conversation({ taskId: 't2' });
      const before = await x.persisted();
      const other = before.executors['task:t2'];
      assert.ok(other?.pid > 1);
      const restarted = await x.plugin.setPolicy({ taskId: 't1', enabled: true, restart: true });
      const after = await x.persisted();
      assert.equal(after.executors['task:t1'], undefined);
      assert.deepEqual(after.executors['task:t2'], other);
      assert.deepEqual(after.policies.find(item => item.taskId === 't2'),
        before.policies.find(item => item.taskId === 't2'));
      assert.doesNotThrow(() => process.kill(other.pid, 0));
      assert.equal(restarted.enabled, true);
    });
  });

test('macOS production job restart retires only its original task cohort',
  { concurrency: false, skip: process.platform !== 'darwin' }, async () => {
    const x = await setup({ nativeJob: true, secondTask: true,
      authorizeExecution: async ({ taskId }) => { if (taskId === 't1') throw new Error('injected preflight failure'); return true; } });
    const failures = [], markers = [];
    try {
      await x.plugin.setPolicy({ taskId: 't1', enabled: true });
      await x.plugin.enable(); await x.plugin.check();
      assert.equal(x.plugin.state().policies.find(item => item.taskId === 't1').status, 'retry_stopped');
      await x.plugin.setPolicy({ taskId: 't2', enabled: false });
      await x.plugin.conversation({ taskId: 't2' });
      const before = await x.persisted();
      const first = before.executors['task:t1'], second = before.executors['task:t2'];
      assert.equal(first?.kind, 'macos-job');
      assert.equal(second?.kind, 'macos-job');
      markers.push(first, second);
      const beforeOtherPolicy = before.policies.find(item => item.taskId === 't2');
      const result = await x.plugin.setPolicy({ taskId: 't1', enabled: true, restart: true });
      assert.equal(result.policies.find(item => item.taskId === 't1').attempts, 0);
      const after = await x.persisted();
      assert.equal(after.executors['task:t1'], undefined);
      assert.deepEqual(after.executors['task:t2'], second);
      assert.deepEqual(after.policies.find(item => item.taskId === 't2'), beforeOtherPolicy);
      const rows = await nativeProcessTable(pythonPath, 15000, { allVisible: true });
      await assertOriginalNativeJobRetired(first, rows);
      const otherRecord = await readJobRecord(second.recordRoot, second.recordId,
        second.taskId, second.canonicalWorkspace);
      assert.notEqual(otherRecord.phase, 'retired');
      assert.ok(['pid', 'startSec', 'startUsec'].every(key =>
        rows.get(otherRecord.identity.pid)?.[key] === otherRecord.identity[key]),
      'another task original job must remain live with its exact birth identity');
    } catch (error) { failures.push(new Error('Production restart or other-task isolation failed', { cause: error })); }
    try { await closeChecked(x); }
    catch (error) { failures.push(new Error('Production job fixture close failed', { cause: error })); }
    try {
      const rows = await nativeProcessTable(pythonPath, 15000, { allVisible: true });
      for (const marker of markers) await assertOriginalNativeJobRetired(marker, rows);
    } catch (error) { failures.push(new Error('Original job record or cohort retirement failed', { cause: error })); }
    if (failures.length) throw new AggregateError(failures,
      'Production restart body, close, and original cohort retirement must all pass');
  });

test('restart refuses a task revision change after the original thread read',
  { concurrency: false }, async () => {
    let armed = false, reads = 0;
    const x = await setup({ authorizeExecution: async () => { throw new Error('injected preflight failure'); },
      onGetTask: (id, task) => { if (armed && id === 't1' && ++reads === 3) task.revision += 1; } });
    await withFixture(x, async () => {
      await x.plugin.setPolicy({ taskId: 't1', enabled: true });
      await x.plugin.enable(); await x.plugin.check();
      const before = await x.persisted();
      const pending = before.policies[0].pendingAutoCommandId;
      armed = true;
      await assert.rejects(x.plugin.setPolicy({ taskId: 't1', enabled: true, restart: true }),
        /not confirmed idle/i);
      armed = false;
      const after = await x.persisted();
      assert.deepEqual(after.executors['task:t1'], before.executors['task:t1']);
      assert.equal(after.policies[0].pendingAutoCommandId, pending);
      assert.equal(after.policies[0].status, 'retry_stopped');
      assert.doesNotThrow(() => process.kill(before.executors['task:t1'].pid, 0));
    });
  });

test('restart refuses a changed project binding without retiring the original executor',
  { concurrency: false }, async () => {
    let armed = false, reads = 0, x;
    x = await setup({ authorizeExecution: async () => { throw new Error('injected preflight failure'); },
      onGetProject: id => {
        if (armed && id === 'p1' && ++reads === 3) x.changeProjectDirectory(join(x.directory, 'other'));
      } });
    await withFixture(x, async () => {
      await x.plugin.setPolicy({ taskId: 't1', enabled: true });
      await x.plugin.enable(); await x.plugin.check();
      const before = await x.persisted();
      armed = true;
      await assert.rejects(x.plugin.setPolicy({ taskId: 't1', enabled: true, restart: true }),
        /not confirmed idle/i);
      armed = false;
      assert.deepEqual((await x.persisted()).executors['task:t1'], before.executors['task:t1']);
      assert.doesNotThrow(() => process.kill(before.executors['task:t1'].pid, 0));
      x.changeProjectDirectory(x.directory);
    });
  });

test('restart refuses a task edit during the final post-retirement project read',
  { concurrency: false }, async () => {
    let armed = false, changed = false, x;
    x = await setup({ authorizeExecution: async () => { throw new Error('injected preflight failure'); },
      onGetProject: async id => {
        if (!armed || changed || id !== 'p1') return;
        const image = await x.persisted();
        if (!image.executors['task:t1']) {
          changed = true;
          x.changeTask({ revision: x.task().revision + 1, contentVersion: x.task().contentVersion + 1 });
        }
      } });
    await withFixture(x, async () => {
      await x.plugin.setPolicy({ taskId: 't1', enabled: true });
      await x.plugin.enable(); await x.plugin.check();
      const before = await x.persisted(), oldPlan = before.policies.find(item => item.taskId === 't1');
      armed = true;
      await assert.rejects(x.plugin.setPolicy({ taskId: 't1', enabled: true, restart: true }),
        /not confirmed idle|restart_binding_changed/i);
      armed = false;
      assert.equal(changed, true);
      const after = await x.persisted();
      assert.equal(after.executors['task:t1'], undefined);
      assert.deepEqual(after.policies.find(item => item.taskId === 't1'), oldPlan);
      assert.equal((await x.calls('turn/start')).length, 0);
    });
  });

test('failed original executor retirement preserves the stopped plan and its fence',
  { concurrency: false }, async () => {
    let failOnce = true;
    const x = await setup({ authorizeExecution: async () => { throw new Error('injected preflight failure'); },
      verifyRetired: async ({ bridgePid, appServerPid }) => {
        await waitPidGone(bridgePid);
        if (appServerPid && appServerPid !== bridgePid) await waitPidGone(appServerPid);
        if (failOnce) { failOnce = false; return { verified: false, retired: false, reason: 'injected uncertain retirement' }; }
        return { verified: true, retired: true };
      } });
    await withFixture(x, async () => {
      await x.plugin.setPolicy({ taskId: 't1', enabled: true });
      await x.plugin.enable(); await x.plugin.check();
      const before = await x.persisted();
      await assert.rejects(x.plugin.setPolicy({ taskId: 't1', enabled: true, restart: true }),
        /injected uncertain retirement/);
      const after = await x.persisted();
      assert.equal(after.executors['task:t1'].status, 'retirement_unknown');
      assert.equal(after.policies[0].pendingAutoCommandId, before.policies[0].pendingAutoCommandId);
      assert.equal(after.policies[0].attempts, before.policies[0].attempts);
      assert.equal(after.policies[0].status, 'retry_stopped');
      assert.equal((await x.calls('turn/start')).length, 0);
      const proof = await x.plugin.reconcile({ taskId: 't1', expectedRevision: x.task().revision });
      assert.notEqual(proof.status, 'unknown');
      assert.equal((await x.persisted()).executors['task:t1'], undefined);
    });
  });

test('restart final persistence failure keeps the complete old plan and does not send',
  { concurrency: false }, async () => {
    let armFailure = false, failures = 0, authorized = false;
    const x = await setup({
      authorizeExecution: async () => { if (!authorized) throw new Error('injected preflight failure'); return true; },
      beforeStateWrite: image => {
        const next = JSON.parse(image), policy = next.policies.find(item => item.taskId === 't1');
        if (armFailure && policy?.enabled && policy.attempts === 0 && policy.pendingAutoCommandId === null &&
            !next.executors['task:t1']) {
          armFailure = false; failures++; throw new Error('fixture_restart_final_write_failed');
        }
      },
    });
    await withFixture(x, async () => {
      await x.plugin.setPolicy({ taskId: 't1', enabled: true });
      await x.plugin.enable(); await x.plugin.check();
      const before = await x.persisted(), oldPlan = before.policies.find(item => item.taskId === 't1');
      assert.equal(oldPlan.status, 'retry_stopped');
      assert.match(oldPlan.pendingAutoCommandId, /^auto-/);
      armFailure = true;
      await assert.rejects(x.plugin.setPolicy({ taskId: 't1', enabled: true, restart: true }),
        /fixture_restart_final_write_failed/);
      assert.equal(failures, 1);
      const saved = await x.persisted(), current = x.plugin.state().policies.find(item => item.taskId === 't1');
      assert.deepEqual(saved.policies.find(item => item.taskId === 't1'), oldPlan);
      assert.equal(saved.executors['task:t1'], undefined);
      assert.equal(current.enabled, false);
      for (const key of ['status', 'attempts', 'startedAt', 'deadlineAt', 'stopReason'])
        assert.equal(current[key], oldPlan[key]);
      assert.equal((await x.calls('turn/start')).length, 0);
      authorized = true;
      const restarted = await x.plugin.setPolicy({ taskId: 't1', enabled: true, restart: true });
      assert.equal(restarted.policies.find(item => item.taskId === 't1').attempts, 0);
      await x.plugin.check();
      assert.equal((await x.calls('turn/start')).length, 1);
    });
  });

test('an edit during restart persistence stops the first automatic turn before reservation',
  { concurrency: false }, async () => {
    let armEdit = false, edits = 0, x;
    x = await setup({ authorizeExecution: async () => { throw new Error('injected preflight failure'); },
      beforeStateWrite: image => {
        const next = JSON.parse(image), policy = next.policies.find(item => item.taskId === 't1');
        if (armEdit && policy?.enabled && policy.restartBinding && policy.attempts === 0 &&
            !next.executors['task:t1']) {
          armEdit = false; edits++;
          x.changeTask({ revision: x.task().revision + 1, contentVersion: x.task().contentVersion + 1 });
        }
      } });
    await withFixture(x, async () => {
      await x.plugin.setPolicy({ taskId: 't1', enabled: true });
      await x.plugin.enable(); await x.plugin.check();
      armEdit = true;
      const restart = await x.plugin.setPolicy({ taskId: 't1', enabled: true, restart: true });
      assert.equal(edits, 1);
      assert.equal(restart.policies[0].attempts, 0);
      await x.plugin.check();
      const policy = (await x.persisted()).policies.find(item => item.taskId === 't1');
      assert.equal(policy.enabled, false);
      assert.equal(policy.status, 'retry_stopped');
      assert.equal(policy.stopReason, 'restart_binding_changed');
      assert.equal(policy.attempts, 0);
      assert.equal((await x.calls('turn/start')).length, 0);
    });
  });

test('a binding edit after authorization persists a no-send receipt for the reserved command',
  { concurrency: false }, async () => {
    let restartAuthorized = false, x, reservedCommandId = null;
    x = await setup({ authorizeExecution: async input => {
      if (!restartAuthorized) throw new Error('injected preflight failure');
      assert.equal(input.expectedRevision, 1);
      reservedCommandId = input.commandId;
      x.changeTask({ revision: 2, contentVersion: 2 });
      return { maySend: true };
    } });
    await withFixture(x, async () => {
      await x.plugin.setPolicy({ taskId: 't1', enabled: true });
      await x.plugin.enable(); await x.plugin.check();
      restartAuthorized = true;
      await x.plugin.setPolicy({ taskId: 't1', enabled: true, restart: true });
      await x.plugin.check();
      assert.match(reservedCommandId, /^auto-/);
      const saved = await x.persisted();
      const receipt = saved.commands[`t1:${reservedCommandId}`];
      assert.equal(receipt.status, 'cancelled');
      assert.equal((await x.plugin.getExecution({ taskId: 't1', commandId: reservedCommandId })).status, 'not_started');
      assert.equal(saved.policies.find(item => item.taskId === 't1').stopReason, 'restart_binding_changed');
      assert.equal((await x.calls('turn/start')).length, 0);
    });
  });

test('deadline is not extended by enable and blocks a send after authorization awaits',
  { concurrency: false }, async () => {
    let clock = Date.parse('2026-01-01T00:00:00.000Z');
    const x = await setup({ now: () => clock, authorizeExecution: async () => { clock += 61_000; } });
    await withFixture(x, async () => {
      const first = await x.plugin.setPolicy({ taskId: 't1', enabled: true, budgetMinutes: 1 });
      const deadlineAt = first.policies[0].deadlineAt;
      assert.equal((await x.plugin.setPolicy({ taskId: 't1', enabled: true, budgetMinutes: 1 }))
        .policies[0].deadlineAt, deadlineAt);
      await x.plugin.enable(); await x.plugin.check();
      assert.equal((await x.calls('turn/start')).length, 0);
      assert.equal(x.plugin.state().policies[0].status, 'budget_exhausted');
      assert.equal(x.plugin.state().policies[0].deadlineAt, deadlineAt);
    });
  });

test('quota polling consumes no attempt and expiry remains fixed across restart',
  { concurrency: false }, async () => {
    let clock = Date.parse('2026-01-01T00:00:00.000Z');
    const x = await setup({ now: () => clock, scenario: { allowed: false } });
    await withFixture(x, async () => {
      const first = await x.plugin.setPolicy({ taskId: 't1', enabled: true, budgetMinutes: 1 });
      const deadlineAt = first.policies[0].deadlineAt;
      await x.plugin.enable(); await x.plugin.check();
      assert.equal(x.plugin.state().policies[0].attempts, 0);
      clock += 61_000;
      await x.plugin.check();
      assert.equal(x.plugin.state().policies[0].status, 'budget_exhausted');
      assert.equal((await x.calls('turn/start')).length, 0);
      await closeChecked(x);
      const restart = createPlugin(x.options);
      x.extraPlugins.push(restart);
      await restart.check();
      assert.equal(restart.state().policies[0].deadlineAt, deadlineAt);
      assert.equal(restart.state().policies[0].remainingSeconds, 0);
      await assert.rejects(restart.setPolicy({ taskId: 't1', enabled: true }), /restart/i);
    });
  });

test('first enable durably binds the task while quota waits and a repeat enable never refreshes it',
  { concurrency: false }, async () => {
    const x = await setup({ scenario: { allowed: false } });
    await withFixture(x, async () => {
      const first = await x.plugin.setPolicy({ taskId: 't1', enabled: true });
      const saved = await x.persisted();
      assert.equal(saved.policies[0].restartBinding?.revision, 1);
      assert.equal(saved.policies[0].restartBinding?.threadId, 'thread-1');
      assert.equal(first.policies[0].attempts, 0);
      await x.plugin.setPolicy({ taskId: 't1', enabled: true });
      assert.deepEqual((await x.persisted()).policies[0].restartBinding, saved.policies[0].restartBinding);
      x.changeTask({ revision: 2, contentVersion: 2 });
      await x.plugin.enable();
      await x.plugin.check();
      const after = await x.persisted();
      assert.equal(after.policies[0].enabled, false);
      assert.equal(after.policies[0].stopReason, 'restart_binding_changed');
      assert.equal(after.policies[0].attempts, 0);
      assert.equal((await x.calls('turn/start')).length, 0);
    });
  });

test('an enabled legacy first plan without a proven first turn stops rather than rebinding on reload',
  { concurrency: false }, async () => {
    const x = await setup({ scenario: { allowed: false } });
    await withFixture(x, async () => {
      await x.plugin.setPolicy({ taskId: 't1', enabled: true });
      await closeChecked(x);
      const image = await x.persisted();
      image.enabled = true;
      delete image.policies[0].restartBinding;
      delete image.policies[0].initialTurnConfirmed;
      await writeFile(join(x.options.dataDir, 'codex-autocontinue.json'), JSON.stringify(image));
      const recovered = createPlugin(x.options);
      x.extraPlugins.push(recovered);
      await recovered.check();
      assert.equal(recovered.state().policies[0].enabled, false);
      assert.equal(recovered.state().policies[0].stopReason, 'restart_binding_changed');
      assert.equal((await x.calls('turn/start')).length, 0);
      await writeFile(join(x.directory, 'scenario.json'), JSON.stringify({}));
      const manual=await recovered.resume({taskId:'t1',expectedRevision:1,commandId:'manual-after-legacy-stop'});
      assert.equal(manual.status,'running','the legacy automatic fence must not disable explicit manual resume');
      assert.equal((await x.calls('turn/start')).length,1);
    });
  });

test('a manual auto-looking command cannot prove an old automatic plan first turn',
  { concurrency: false }, async () => {
    let authorizeManual=false;
    const x=await setup({scenario:{completeStatus:'failed',turnError:'quota exhausted'},
      authorizeExecution:async()=>{
        if(!authorizeManual)throw new Error('injected first automatic preflight failure');
        return true;
      }});
    await withFixture(x,async()=>{
      await x.plugin.setPolicy({taskId:'t1',enabled:true,maxAttempts:3});
      await x.plugin.enable();await x.plugin.check();
      let image=await x.persisted();
      assert.equal(image.policies[0].attempts,1);
      assert.equal(image.policies[0].status,'retry_stopped');
      assert.equal((await x.calls('turn/start')).length,0);
      authorizeManual=true;
      const manual=await x.plugin.resume({taskId:'t1',expectedRevision:1,commandId:'auto-forged-manual'});
      assert.equal(manual.status,'running');
      let observed;
      for(let attempt=0;attempt<80;attempt++){
        image=await x.persisted();
        observed=image.commands['t1:auto-forged-manual'];
        if(observed?.status==='failed'&&observed.stopProof?.status==='verified')break;
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      assert.equal(observed?.status,'failed');
      assert.equal(observed.stopProof?.status,'verified');
      assert.equal(image.policies[0].threadId,'thread-1',
        'the actual manual send wrote the policy thread field');
      assert.equal((await x.calls('turn/start')).length,1);
      const manualReceipt=structuredClone(observed);
      await closeChecked(x);
      image=await x.persisted();
      image.enabled=true;
      image.commands['t1:auto-forged-manual']=manualReceipt;
      Object.assign(image.policies[0],{enabled:true,status:'waiting_quota',attempts:1,
        pendingAutoCommandId:null,threadId:'thread-1'});
      delete image.policies[0].restartBinding;
      delete image.policies[0].initialTurnConfirmed;
      await writeFile(join(x.options.dataDir,'codex-autocontinue.json'),JSON.stringify(image));
      const recovered=createPlugin(x.options);
      x.extraPlugins.push(recovered);
      assert.equal(recovered.state().policies[0].enabled,false);
      assert.equal(recovered.state().policies[0].stopReason,'restart_binding_changed');
      await recovered.check();
      assert.equal((await x.calls('turn/start')).length,1,'no second provider request is allowed');
    });
  });

test('first enabled plan keeps its original workspace during quota wait',
  { concurrency: false }, async () => {
    const x=await setup({scenario:{allowed:false},secondTask:true});
    await withFixture(x,async()=>{
      await x.plugin.setPolicy({taskId:'t1',enabled:true});
      x.changeProjectDirectory(x.secondDirectory);
      await x.plugin.enable();await x.plugin.check();
      const saved=await x.persisted();
      assert.equal(saved.policies.find(policy=>policy.taskId==='t1').stopReason,'restart_binding_changed');
      assert.equal(saved.policies.find(policy=>policy.taskId==='t1').attempts,0);
      assert.equal((await x.calls('turn/start')).length,0);
    });
  });

test('first enabled plan releases its binding only after a durable started turn, then uses later task revisions',
  { concurrency: false }, async () => {
    const x=await setup({scenario:{completeStatus:'failed',turnError:'quota exhausted'},
      onUpdateTask:async(_task,patch,scenarioPath)=>{
        if(patch.status==='blocked')await writeFile(scenarioPath,JSON.stringify({allowed:false}));
      }});
    await withFixture(x,async()=>{
      const first=await x.plugin.setPolicy({taskId:'t1',enabled:true,maxAttempts:2,budgetMinutes:1});
      await x.plugin.enable();await x.plugin.check();
      const afterFirst=await waitFirstQuotaResult(x);
      assert.equal(afterFirst.policies[0].restartBinding,null);
      assert.equal(afterFirst.policies[0].initialTurnConfirmed,true);
      assert.equal(afterFirst.policies[0].attempts,1);
      assert.ok(x.task().revision>1,'normal quota bookkeeping advanced the task revision');
      await writeFile(join(x.directory,'scenario.json'),JSON.stringify({}));
      await x.plugin.check();
      const afterSecond=await x.persisted();
      assert.equal((await x.calls('turn/start')).length,2);
      assert.equal(afterSecond.policies[0].attempts,2);
      assert.equal(afterSecond.policies[0].deadlineAt,first.policies[0].deadlineAt);
      assert.notEqual(afterSecond.policies[0].stopReason,'restart_binding_changed');
    });
  });

test('first enabled plan rejects a task edit after authorization without sending a turn',
  { concurrency: false }, async () => {
    let x;
    x=await setup({authorizeExecution:async()=>{x.changeTask({revision:x.task().revision+1,contentVersion:x.task().contentVersion+1});return true;}});
    await withFixture(x,async()=>{
      await x.plugin.setPolicy({taskId:'t1',enabled:true});
      await x.plugin.enable();await x.plugin.check();
      const saved=await x.persisted();
      assert.equal((await x.calls('turn/start')).length,0);
      assert.equal(saved.policies[0].stopReason,'restart_binding_changed');
      assert.equal(saved.policies[0].enabled,false);
      assert.equal(Object.values(saved.commands).filter(command=>command.taskId==='t1').length,1);
      assert.equal(Object.values(saved.commands).find(command=>command.taskId==='t1')?.status,'cancelled');
    });
  });

test('first enable persistence cannot authorize a task edited during its local write',
  { concurrency: false }, async () => {
    let x,edited=false;
    x=await setup({scenario:{allowed:false},beforeStateWrite:async image=>{
      const policy=JSON.parse(image).policies[0];
      if(!edited&&policy?.enabled&&policy.restartBinding&&policy.attempts===0){
        edited=true;x.changeTask({revision:x.task().revision+1,contentVersion:x.task().contentVersion+1});
      }
    }});
    await withFixture(x,async()=>{
      await x.plugin.setPolicy({taskId:'t1',enabled:true});
      assert.equal(edited,true);
      await x.plugin.enable();await x.plugin.check();
      const saved=await x.persisted();
      assert.equal(saved.policies[0].enabled,false);
      assert.equal(saved.policies[0].stopReason,'restart_binding_changed');
      assert.equal(saved.policies[0].attempts,0);
      assert.equal((await x.calls('turn/start')).length,0);
    });
  });

test('final execution revalidation cannot send a turn after the deadline',
  { concurrency: false }, async () => {
    let clock = Date.parse('2026-01-01T00:00:00.000Z');
    let revalidations = 0;
    const x = await setup({ now: () => clock, revalidateExecution: async () => {
      if (++revalidations === 2) clock += 61_000;
      return true;
    } });
    await withFixture(x, async () => {
      await x.plugin.setPolicy({ taskId: 't1', enabled: true, budgetMinutes: 1 });
      await x.plugin.enable(); await x.plugin.check();
      assert.equal(revalidations, 2);
      assert.equal((await x.calls('turn/start')).length, 0);
      assert.equal(x.plugin.state().policies[0].status, 'budget_exhausted');
    });
  });

test('explicit restart refuses a still-running task and its active executor',
  { concurrency: false }, async () => {
    const x = await setup();
    await withFixture(x, async () => {
      await x.plugin.setPolicy({ taskId: 't1', enabled: false });
      const result = await x.plugin.resume({ taskId: 't1', expectedRevision: 1,
        commandId: 'manual-active-before-restart' });
      assert.equal(result.status, 'running');
      await assert.rejects(x.plugin.setPolicy({ taskId: 't1', enabled: true, restart: true }),
        /not confirmed idle/i);
      assert.equal((await x.calls('turn/start')).length, 1);
    });
  });

test('explicit policy restart cannot clear an unknown original command',
  { concurrency: false }, async () => {
    const x = await setup();
    await withFixture(x, async () => {
      await x.plugin.setPolicy({ taskId: 't1', enabled: false });
      await closeChecked(x);
      const saved = await x.persisted();
      saved.commands['t1:original-unknown'] = { taskId: 't1', commandId: 'original-unknown',
        threadId: 'thread-1', status: 'unknown' };
      await writeFile(join(x.options.dataDir, 'codex-autocontinue.json'), JSON.stringify(saved));
      const restart = createPlugin(x.options);
      x.extraPlugins.push(restart);
      await assert.rejects(restart.setPolicy({ taskId: 't1', enabled: true, restart: true }),
        /unknown|approval|executor/i);
      assert.equal((await x.calls('turn/start')).length, 0);
    });
  });

test('an enabled legacy plan without a durable deadline stops on restart',
  { concurrency: false }, async () => {
    const x = await setup();
    await withFixture(x, async () => {
      await x.plugin.setPolicy({ taskId: 't1', enabled: true });
      await closeChecked(x);
      const saved = await x.persisted();
      saved.enabled = true;
      delete saved.policies[0].startedAt;
      delete saved.policies[0].deadlineAt;
      await writeFile(join(x.options.dataDir, 'codex-autocontinue.json'), JSON.stringify(saved));
      const restart = createPlugin(x.options);
      x.extraPlugins.push(restart);
      await restart.check();
      assert.equal(restart.state().policies[0].enabled, false);
      assert.equal(restart.state().policies[0].stopReason, 'legacy_plan_missing_deadline');
      assert.equal((await x.calls('turn/start')).length, 0);
    });
  });

test('failed reservation write cannot send and manual resume never consumes auto attempts',
  { concurrency: false }, async () => {
    let failReservation = true;
    const x = await setup({ beforeStateWrite: async image => {
      if (failReservation && JSON.parse(image).policies[0]?.pendingAutoCommandId)
        throw new Error('injected reservation write failure');
    } });
    await withFixture(x, async () => {
      await x.plugin.setPolicy({ taskId: 't1', enabled: true });
      await x.plugin.enable(); await x.plugin.check();
      assert.equal((await x.calls('turn/start')).length, 0);
      assert.equal(x.plugin.state().policies[0].status, 'retry_stopped');
      failReservation = false;
      const result = await x.plugin.resume({ taskId: 't1', expectedRevision: 1,
        commandId: 'manual-after-auto-failure' });
      assert.equal(result.status, 'running');
      assert.equal(x.plugin.state().policies[0].attempts, 1);
      assert.equal((await x.calls('turn/start')).length, 1);
    });
  });

for (const action of ['pause', 'disable']) {
  test(`human ${action} during automatic authorization keeps the human stop state`,
    { concurrency: false }, async () => {
      let entered;
      let release;
      const enteredGate = new Promise(resolve => { entered = resolve; });
      const blocked = new Promise(resolve => { release = resolve; });
      const x = await setup({ authorizeExecution: async () => { entered(); await blocked; return true; } });
      await withFixture(x, async () => {
        try {
          await x.plugin.setPolicy({ taskId: 't1', enabled: true });
          await x.plugin.enable();
          const checking = x.plugin.check();
          await reached(enteredGate, 'authorization barrier');
          const stopping = action === 'pause'
            ? x.plugin.pause({ taskId: 't1', expectedRevision: 1 })
            : x.plugin.disable();
          release();
          await checking;
          await stopping;
          const policy = x.plugin.state().policies[0];
          assert.equal(policy.status, action === 'pause' ? 'paused' : 'disabled');
          assert.equal(policy.stopReason, null);
          assert.equal(policy.enabled, false);
          assert.equal(policy.attempts, 1);
          assert.equal((await x.calls('turn/start')).length, 0);
        } finally { release(); }
      });
    });
}

test('pause while the sending marker persists reaches cancelBeforeSend without retry_stopped',
  { concurrency: false }, async () => {
    let entered;
    let release;
    let held = false;
    const enteredGate = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const x = await setup({ beforeStateWrite: async image => {
      const commands = Object.values(JSON.parse(image).commands);
      if (!held && commands.some(command => command.status === 'sending' && command.commandId?.startsWith('auto-'))) {
        held = true;
        entered();
        await blocked;
      }
    } });
    await withFixture(x, async () => {
      try {
        await x.plugin.setPolicy({ taskId: 't1', enabled: true });
        await x.plugin.enable();
        const checking = x.plugin.check();
        await reached(enteredGate, 'sending marker barrier');
        const stopping = x.plugin.pause({ taskId: 't1', expectedRevision: 1 });
        release();
        await checking;
        await stopping;
        const saved = await x.persisted();
        assert.equal(saved.policies[0].status, 'paused');
        assert.equal(saved.policies[0].stopReason, null);
        assert.equal(Object.values(saved.commands).find(command => command.commandId?.startsWith('auto-'))?.status,
          'cancelled');
        assert.equal((await x.calls('turn/start')).length, 0);
      } finally { release(); }
    });
  });
