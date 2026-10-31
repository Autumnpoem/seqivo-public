import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlugin } from '../plugins/codex-autocontinue/host.mjs';

const pythonPath = process.env.TASKBOARD_TEST_PYTHON;
const pluginDir = fileURLToPath(new URL('../plugins/codex-autocontinue/', import.meta.url));
const fakeSource = fileURLToPath(new URL('./plugin-fake-codex.py', import.meta.url));
const envNames = ['TASKBOARD_FAKE_SCENARIO', 'TASKBOARD_FAKE_LOG', 'TASKBOARD_FAKE_PID',
  'TASKBOARD_FAKE_CWD', 'TASKBOARD_FAKE_CHILD_PID', 'TASKBOARD_FAKE_LATE_WRITE',
  'TASKBOARD_FAKE_CHILD_SCRIPT'];

async function fixture(t, scenario = {}, { duplicateCompletion = false, onRevalidate = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'seqivo-m5-intent-'));
  const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const executable = join(root, 'fake-codex.py');
  await copyFile(fakeSource, executable);
  if (duplicateCompletion) {
    const original = await readFile(executable, 'utf8');
    const event = 'reply({"method": "turn/completed", "params": {"threadId": request["params"]["threadId"], "turn": current_turn}})';
    const completion = original.indexOf('if scenario.get("completeStatus"):');
    const eventAt = original.indexOf(event, completion);
    assert.ok(completion >= 0 && eventAt > completion, 'fake completion site changed');
    await writeFile(executable, original.slice(0, eventAt) + `${event}\n            ${event}` +
      original.slice(eventAt + event.length));
  }
  await chmod(executable, 0o700);
  const dataDir = join(root, 'state');
  await mkdir(dataDir);
  const scenarioPath = join(root, 'scenario.json');
  const logPath = join(root, 'calls.jsonl');
  const pidPath = join(root, 'fake.pid');
  await writeFile(scenarioPath, JSON.stringify(scenario));
  await writeFile(logPath, '');
  Object.assign(process.env, {
    TASKBOARD_FAKE_SCENARIO: scenarioPath, TASKBOARD_FAKE_LOG: logPath,
    TASKBOARD_FAKE_PID: pidPath, TASKBOARD_FAKE_CWD: root,
    TASKBOARD_FAKE_CHILD_PID: join(root, 'child.pid'),
    TASKBOARD_FAKE_LATE_WRITE: join(root, 'late.txt'),
    TASKBOARD_FAKE_CHILD_SCRIPT: join(root, 'child.py'),
  });
  await writeFile(process.env.TASKBOARD_FAKE_CHILD_SCRIPT, '');
  let task = { id: 't1', projectId: 'p1', title: 'Scoped task', goal: 'Original goal',
    nextStep: 'Original next step', criteria: [], conversationId: 'thread-1',
    status: 'blocked', blockedReason: 'Quota exhausted', acceptance: 'unverified',
    revision: 1, contentVersion: 1 };
  const plugins = [];
  const options = { dataDir, pluginDir, taskJobBackend: null,
    revalidateExecution: async input => onRevalidate ? onRevalidate(input, patch => {
      task = { ...task, ...patch };
    }) : true,
    processProof: {
      captureExecutorBaseline: async () => ({ verified: true, baseline: { fixture: true } }),
      captureTaskExecutorTree: async ({ bridgePid, appServerPid }) =>
        ({ verified: true, capture: { bridgePid, appServerPid } }),
      verifyTaskExecutorRetired: async ({ bridgePid, appServerPid }) => {
        await pidGone(bridgePid);
        if (appServerPid && appServerPid !== bridgePid) await pidGone(appServerPid);
        return { verified: true, retired: true };
      },
    },
    getTask: async id => id === task.id ? task : null,
    getProject: async id => id === 'p1' ? { id, directory: root } : null,
    updateTask: async (id, patch, revision) => {
      assert.equal(id, task.id);
      assert.equal(revision, task.revision);
      task = { ...task, ...patch, revision: revision + 1 };
      return task;
    },
  };
  const makePlugin = async () => {
    const plugin = createPlugin(options);
    plugins.push(plugin);
    await plugin.configure({ pythonPath, codexPath: executable, pollSeconds: 86400 });
    return plugin;
  };
  let cleanupSucceeded = false;
  t.after(async () => {
    const errors = [];
    for (const plugin of plugins.reverse()) {
      try { await plugin.close(); }
      catch (error) { errors.push(error); }
    }
    try {
      const pid = Number(await readFile(pidPath, 'utf8'));
      if (Number.isInteger(pid) && pid > 1) await pidGone(pid);
    } catch (error) { if (error.code !== 'ENOENT') errors.push(error); }
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    if (!errors.length) { await rm(root, { recursive: true, force: true }); cleanupSucceeded = true; }
    if (errors.length) throw new AggregateError(errors, `Fixture retained at ${root}`);
  });
  const calls = async method => (await readFile(logPath, 'utf8')).trim().split('\n')
    .filter(Boolean).map(JSON.parse).filter(row => row.method === method);
  const saved = async () => JSON.parse(await readFile(join(dataDir, 'codex-autocontinue.json'), 'utf8'));
  return { makePlugin, calls, saved, task: () => task, edit: patch => { task = { ...task, ...patch }; },
    scenarioPath, executable, root, cleanupSucceeded: () => cleanupSucceeded };
}

async function pidGone(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  for (let attempt = 0; attempt < 60; attempt++) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('fake provider remains alive');
}

async function until(check, description) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(description);
}

test('first enable exposes exact durable intent; changed nextStep without version bump stops before a turn',
  { skip: !pythonPath, concurrency: false }, async t => {
    const x = await fixture(t);
    const plugin = await x.makePlugin();
    const first = await plugin.setPolicy({ taskId: 't1', enabled: true, maxAttempts: 3 });
    assert.deepEqual(first.policies[0].planIntent,
      { version: 1, goal: 'Original goal', nextStep: 'Original next step' });
    x.edit({ nextStep: 'Changed without a contentVersion or revision bump' });
    await plugin.enable();
    await plugin.check();
    const policy = (await x.saved()).policies[0];
    assert.equal(policy.status, 'retry_stopped');
    assert.equal(policy.stopReason, 'plan_intent_changed');
    assert.equal(policy.attempts, 0);
    assert.equal((await x.calls('turn/start')).length, 0);
  });

test('a changed nextStep stops a proven plan during quota wait without another turn',
  { skip: !pythonPath, concurrency: false }, async t => {
    const x = await fixture(t, { completeStatus: 'failed', turnError: 'quota exhausted' });
    const plugin = await x.makePlugin();
    await plugin.setPolicy({ taskId: 't1', enabled: true, maxAttempts: 3 });
    await plugin.enable();
    const first = await until(async () => {
      const image = await x.saved();
      return image.policies[0].recoveryFailureCount === 1 &&
        Object.values(image.commands)[0]?.stopProof?.status === 'verified' ? image : null;
    }, 'first automatic quota outcome was not verified');
    assert.equal(first.policies[0].initialTurnConfirmed, true);
    assert.equal(first.policies[0].restartBinding, null);
    assert.equal((await x.calls('turn/start')).length, 1);
    await writeFile(x.scenarioPath, JSON.stringify({ allowed: false, used: [100, 0] }));
    await plugin.check();
    assert.equal(plugin.state().policies[0].status, 'waiting_quota');
    assert.ok(Date.parse(plugin.state().policies[0].wakeAt) > Date.now());
    const { revision, contentVersion } = x.task();
    x.edit({ nextStep: 'Changed during quota wait' });
    assert.equal(x.task().revision, revision);
    assert.equal(x.task().contentVersion, contentVersion);
    await plugin.check();
    const policy = (await x.saved()).policies[0];
    assert.equal(policy.enabled, false);
    assert.equal(policy.status, 'retry_stopped');
    assert.equal(policy.stopReason, 'plan_intent_changed');
    assert.equal(policy.recoveryFailureCount, 1);
    assert.equal((await x.calls('turn/start')).length, 1);
  });

test('nextStep edit inside the late execution check cannot reach provider turn/start',
  { skip: !pythonPath, concurrency: false }, async t => {
    let checks = 0;
    const x = await fixture(t, {}, { onRevalidate: (_input, edit) => {
      checks++;
      if (checks === 2) edit({ nextStep: 'Edited after authorization with the same revision' });
      return true;
    } });
    const plugin = await x.makePlugin();
    await plugin.setPolicy({ taskId: 't1', enabled: true });
    await plugin.enable();
    await plugin.check();
    assert.ok(checks >= 2, 'late revalidation gate was not reached');
    const policy = plugin.state().policies[0];
    assert.equal(policy.status, 'retry_stopped');
    assert.equal(policy.stopReason, 'plan_intent_changed');
    assert.equal((await x.calls('turn/start')).length, 0);
  });

test('enabled legacy policy without intent fails closed on reload and needs explicit restart',
  { skip: !pythonPath, concurrency: false }, async t => {
    const x = await fixture(t);
    const first = await x.makePlugin();
    await first.setPolicy({ taskId: 't1', enabled: true });
    await first.close();
    const image = await x.saved();
    delete image.policies[0].planIntent;
    await writeFile(join(x.root, 'state', 'codex-autocontinue.json'), JSON.stringify(image));
    const restored = await x.makePlugin();
    const policy = restored.state().policies[0];
    assert.equal(policy.enabled, false);
    assert.equal(policy.stopReason, 'plan_intent_missing');
    await assert.rejects(restored.setPolicy({ taskId: 't1', enabled: true }), /restart/i);
    assert.equal((await x.calls('turn/start')).length, 0);
    const restarted = await restored.setPolicy({ taskId: 't1', enabled: true, restart: true });
    assert.deepEqual(restarted.policies[0].planIntent,
      { version: 1, goal: 'Original goal', nextStep: 'Original next step' });
    assert.equal(restarted.policies[0].recoveryFailureCount, 0);
  });

test('an enabled image with two recorded quota failures cannot dispatch after reload',
  { skip: !pythonPath, concurrency: false }, async t => {
    const x = await fixture(t);
    const first = await x.makePlugin();
    await first.setPolicy({ taskId: 't1', enabled: true, maxAttempts: 3 });
    await first.close();
    const image = await x.saved();
    image.policies[0].recoveryFailureCount = 2;
    image.policies[0].enabled = true;
    await writeFile(join(x.root, 'state', 'codex-autocontinue.json'), JSON.stringify(image));
    const restored = await x.makePlugin();
    assert.equal(restored.state().policies[0].enabled, false);
    assert.equal(restored.state().policies[0].stopReason, 'repeated_quota_failure');
    await restored.enable();
    await restored.check();
    assert.equal((await x.calls('turn/start')).length, 0);
  });

test('verified automatic quota failures count once per command, stop at two, and restart resets',
  { skip: !pythonPath, concurrency: false }, async t => {
    const x = await fixture(t, { completeStatus: 'failed', turnError: 'quota exhausted' },
      { duplicateCompletion: true });
    const plugin = await x.makePlugin();
    await plugin.setPolicy({ taskId: 't1', enabled: true, maxAttempts: 3 });
    await plugin.enable();
    const first = await until(async () => {
      const image = await x.saved();
      return image.policies[0].recoveryFailureCount === 1 &&
        Object.values(image.commands)[0]?.stopProof?.status === 'verified' ? image : null;
    }, 'first exact quota failure was not persisted');
    assert.equal(first.policies[0].attempts, 1);
    assert.equal((await x.calls('turn/start')).length, 1);
    const original = await readFile(x.executable, 'utf8');
    await writeFile(x.executable, original.replaceAll('fake-turn-1', 'fake-turn-2'));
    await plugin.check();
    const stopped = await until(async () => {
      const image = await x.saved();
      return image.policies[0].stopReason === 'repeated_quota_failure' ? image : null;
    }, 'second exact quota failure did not stop the plan');
    assert.equal(stopped.policies[0].recoveryFailureCount, 2);
    assert.equal(stopped.policies[0].attempts, 2);
    assert.equal(stopped.policies[0].enabled, false);
    assert.equal((await x.calls('turn/start')).length, 2);
    await plugin.check();
    assert.equal((await x.calls('turn/start')).length, 2);
    const restarted = await plugin.setPolicy({ taskId: 't1', enabled: true, restart: true, maxAttempts: 3 });
    assert.equal(restarted.policies[0].recoveryFailureCount, 0);
    assert.notEqual((await x.saved()).policies[0].planId, stopped.policies[0].planId);
  });

test('manual quota failure does not count toward an automatic recovery plan',
  { skip: !pythonPath, concurrency: false }, async t => {
    const manual = await fixture(t, { completeStatus: 'failed', turnError: 'quota exhausted' });
    const manualPlugin = await manual.makePlugin();
    await manualPlugin.setPolicy({ taskId: 't1', enabled: false });
    await manualPlugin.resume({ taskId: 't1', expectedRevision: 1, commandId: 'manual-1' });
    await until(async () => {
      const image = await manual.saved();
      return Object.values(image.commands)[0]?.stopProof?.status === 'verified' ? image : null;
    }, 'manual quota outcome was not verified');
    assert.equal(manualPlugin.state().policies[0].recoveryFailureCount, 0);
  });

test('a manual failure on the same task does not consume or reset the enabled plan count',
  { skip: !pythonPath, concurrency: false }, async t => {
    const x = await fixture(t, { completeStatus: 'failed', turnError: 'quota exhausted' });
    const plugin = await x.makePlugin();
    await plugin.setPolicy({ taskId: 't1', enabled: true, maxAttempts: 3 });
    await plugin.enable();
    const first = await until(async () => {
      const image = await x.saved();
      return image.policies[0].recoveryFailureCount === 1 &&
        Object.values(image.commands)[0]?.stopProof?.status === 'verified' ? image : null;
    }, 'first automatic quota failure was not verified');
    const planId = first.policies[0].planId;
    const original = await readFile(x.executable, 'utf8');
    await writeFile(x.executable, original.replaceAll('fake-turn-1', 'fake-turn-2'));
    await plugin.resume({ taskId: 't1', expectedRevision: x.task().revision, commandId: 'manual-after-auto' });
    const afterManual = await until(async () => {
      const image = await x.saved();
      return image.commands['t1:manual-after-auto']?.stopProof?.status === 'verified' ? image : null;
    }, 'manual outcome was not verified');
    assert.equal(afterManual.policies[0].planId, planId);
    assert.equal(afterManual.policies[0].recoveryFailureCount, 1);
    assert.equal(afterManual.policies[0].enabled, true);
    assert.equal(afterManual.commands['t1:manual-after-auto'].automaticPlanId, undefined);
    assert.equal((await x.calls('turn/start')).length, 2);
  });

test('successful automatic turn still submits for human review and disables the plan',
  { skip: !pythonPath, concurrency: false }, async t => {
    const success = await fixture(t, { completeStatus: 'completed' });
    const successPlugin = await success.makePlugin();
    await successPlugin.setPolicy({ taskId: 't1', enabled: true });
    await successPlugin.enable();
    await until(async () => success.task().status === 'submitted' ? true : null,
      'completed automatic turn did not submit');
    const policy = successPlugin.state().policies[0];
    assert.equal(policy.enabled, false);
    assert.equal(policy.status, 'turn_completed');
    assert.equal(policy.recoveryFailureCount, 0);
    assert.equal((await success.calls('turn/start')).length, 1);
  });
