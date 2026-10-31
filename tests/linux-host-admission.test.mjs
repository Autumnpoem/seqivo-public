import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createPlugin } from '../plugins/codex-autocontinue/host.mjs';
import { readLinuxExecutorJobRecord } from '../server/linux-executor-job.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const pluginDir = join(repo, 'plugins/codex-autocontinue');
const fakeCodexFixture = join(repo, 'tests/plugin-fake-codex.py');
const pythonPath = process.env.TASKBOARD_TEST_PYTHON || '/usr/bin/python3';
const skipLinux = process.platform !== 'linux';
const envKeys = ['TASKBOARD_FAKE_SCENARIO', 'TASKBOARD_FAKE_LOG', 'TASKBOARD_FAKE_PID',
  'TASKBOARD_FAKE_CWD', 'CODEX_CLI_PATH'];

async function setFakeEnvironment(dir, workspace, codexPath, scenario = {}) {
  const old = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const scenarioPath = join(dir, 'scenario.json');
  const logPath = join(dir, 'appserver.jsonl');
  await writeFile(scenarioPath, JSON.stringify(scenario));
  process.env.TASKBOARD_FAKE_SCENARIO = scenarioPath;
  process.env.TASKBOARD_FAKE_LOG = logPath;
  process.env.TASKBOARD_FAKE_PID = join(dir, 'appserver.pid');
  process.env.TASKBOARD_FAKE_CWD = workspace;
  process.env.CODEX_CLI_PATH = codexPath;
  return { old, logPath, scenarioPath };
}

function restoreFakeEnvironment(old) {
  for (const key of envKeys) {
    if (old[key] === undefined) delete process.env[key];
    else process.env[key] = old[key];
  }
}

async function readHostState(dataDir) {
  return JSON.parse(await readFile(join(dataDir, 'codex-autocontinue.json'), 'utf8'));
}

async function fakeRetirementReceipt({ dataDir, input }) {
  // This callback stands in only for the Core callback boundary so this test
  // can exercise the host's Linux-job branch. It does not prove Core authority,
  // project handoff, or workspace-writer quiescence.
  const state = await readHostState(dataDir);
  const marker = state.executors?.[`task:${input.taskId}`];
  assert.equal(marker?.kind, 'linux-job');
  assert.equal(marker.recordId, input.recordId);
  assert.equal(marker.pid, input.bridgePid);
  assert.equal(marker.appServerPid, input.appServerPid);
  const intent = marker.linuxStopIntent;
  assert.ok(intent, 'host persists its original stop intent before asking Core to verify retirement');
  assert.equal(intent.projectId, marker.projectId);
  for (const field of ['taskId', 'recordId', 'commandId', 'workspace', 'worktreeId',
    'expectedHandoffGeneration', 'bridgePid', 'appServerPid']) assert.equal(intent[field], input[field], field);
  const record = await readLinuxExecutorJobRecord({ recordRoot: marker.recordRoot,
    recordId: marker.recordId, taskId: marker.taskId, projectId: marker.projectId,
    workspace: marker.workspace, pythonPath });
  assert.equal(record.phase, 'retired', 'the real Linux job has stopped before the mock returns a receipt');
  assert.equal(record.attempted, true);
  assert.equal(record.authority.requestCommandId, input.commandId);
  const session = state.sessions?.[intent.commandId];
  let scope = 'linux-original-task-job-and-current-writers';
  if (session?.status === 'not_started') {
    assert.equal(session.threadId, undefined, 'a not_started session has no provider thread binding');
    assert.equal(intent.threadId, null, 'a not_started session stop intent has no thread ID');
    assert.equal(intent.turnId, null, 'a not_started session stop intent has no turn ID');
    assert.equal(state.commands?.[`${intent.taskId}:${intent.commandId}`], undefined,
      'a rejected session has no provider command/turn record');
    scope = 'linux-original-task-job-before-session-send';
  }
  const receipt = { ...intent, version: 1, scope, recordGeneration: record.generation };
  return { verified: true, retired: true, unknown: false, scope, receipt };
}

async function createAdmissionFixture(t, { scenario = {}, rejectAdmission = false,
  rejectFirstRevalidation = false, rejectFirstRetirement = false } = {}) {
  try { await access(pythonPath); }
  catch { t.skip(`Linux Python runtime unavailable at ${pythonPath}`); return null; }

  const dir = await mkdtemp(join(tmpdir(), 'taskboard-linux-host-admission-'));
  const dataDir = join(dir, 'state');
  const workspace = join(dir, 'workspace');
  const fakeCodexPath = join(dir, 'fake-codex.py');
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  await copyFile(fakeCodexFixture, fakeCodexPath);
  await chmod(fakeCodexPath, 0o700);
  const { old: oldEnvironment, logPath, scenarioPath } = await setFakeEnvironment(dir, workspace, fakeCodexPath, scenario);

  let task = { id: 'linux-host-admission-task', projectId: 'linux-host-admission-project',
    title: 'Create a task conversation', goal: 'Exercise Linux task-job admission',
    conversationId: null, status: 'blocked', blockedReason: 'Codex quota exhausted',
    acceptance: 'unverified', revision: 1, contentVersion: 1 };
  const project = { id: task.projectId, directory: workspace, retirementHandoffGeneration: null };
  let executorTreeCaptureCalls = 0;
  const admissions = [];
  const retirements = [];
  let revalidationCalls = 0;
  const processProof = {
    async captureExecutorBaseline() {
      return { verified: true, baseline: Object.freeze({ fixture: 'valid-prelaunch-baseline' }) };
    },
    async captureTaskExecutorTree() {
      executorTreeCaptureCalls++;
      return { verified: false, reason: 'Native process snapshot is unconfirmed: list_changed_during_scan' };
    },
  };
  const plugin = createPlugin({ dataDir, pluginDir, processProof,
    getTask: async id => id === task.id ? task : null,
    getProject: async id => id === project.id ? project : null,
    updateTask: async (id, patch, revision) => {
      assert.equal(id, task.id);
      assert.equal(task.revision, revision);
      task = { ...task, ...patch, revision: revision + 1 };
      return task;
    },
    revalidateExecution: async () => {
      revalidationCalls++;
      return !(rejectFirstRevalidation && revalidationCalls === 1);
    },
    verifyLinuxExecutorAdmission: async input => {
      admissions.push(input);
      assert.equal(input.taskId, task.id);
      assert.equal(input.workspace, workspace);
      assert.ok(input.recordId, 'the host passes the actual prepared Linux job record ID');
      assert.ok(input.bridgePid > 1 && input.appServerPid > 1);
      if (rejectAdmission && admissions.length === 1)
        throw new Error('fixture rejected Linux admission before provider send');
      return { verified: true, scope: 'fixture-Core-admission-boundary' };
    },
    verifyLinuxJobRetirement: async input => {
      const marker = (await readHostState(dataDir)).executors?.[`task:${input.taskId}`];
      retirements.push({ ...input, recordRoot: marker?.recordRoot });
      if (rejectFirstRetirement && retirements.length === 1)
        throw new Error('fixture transiently rejected Linux retirement proof');
      const proof = await fakeRetirementReceipt({ dataDir, input });
      retirements.at(-1).receipt = proof.receipt;
      return proof;
    },
  });
  await plugin.configure({ pythonPath, codexPath: fakeCodexPath, pollSeconds: 86400 });

  let closed = false;
  return {
    dir, dataDir, workspace, fakeCodexPath, logPath, scenarioPath, task: () => task,
    admissions, retirements, plugin,
    get executorTreeCaptureCalls() { return executorTreeCaptureCalls; },
    get revalidationCalls() { return revalidationCalls; },
    async marker() { return (await readHostState(dataDir)).executors?.[`task:${task.id}`] || null; },
    async close() {
      if (closed) return;
      closed = true;
      let closeError = null;
      try { await plugin.close(); } catch (error) { closeError = error; }
      const marker = await this.marker();
      if (marker?.kind === 'linux-job') {
        const record = await readLinuxExecutorJobRecord({ recordRoot: marker.recordRoot,
          recordId: marker.recordId, taskId: marker.taskId, projectId: marker.projectId,
          workspace: marker.workspace, pythonPath });
        assert.equal(record.phase, 'retired', 'the original Linux job has a durable retired record');
        const pids = [marker.pid, marker.appServerPid, record.supervisorIdentity?.pid,
          record.bridgeIdentity?.pid].filter(Number.isSafeInteger);
        const deadline = Date.now() + 5000;
        let remaining;
        do {
          remaining = (await Promise.all([...new Set(pids)].map(async pid => {
            try { await access(`/proc/${pid}/stat`); return pid; }
            catch (error) { if (error.code === 'ENOENT') return null; throw error; }
          }))).filter(pid => pid !== null);
          if (remaining.length) await delay(25);
        } while (remaining.length && Date.now() < deadline);
        assert.deepEqual(remaining, [], 'only the fixture-owned executor identities exited');
      }
      const providerLog = await readFile(logPath, 'utf8');
      restoreFakeEnvironment(oldEnvironment);
      if (!closeError) await rm(dir, { recursive: true, force: true });
      return { closeError, marker, providerLog };
    },
  };
}

test('Linux task-job session admission bypasses redundant whole-tree capture and reaches Core admission callback',
  { concurrency: false, skip: skipLinux, timeout: 90000 }, async t => {
    try { await access(pythonPath); }
    catch { t.skip(`Linux Python runtime unavailable at ${pythonPath}`); return; }

    const dir = await mkdtemp(join(tmpdir(), 'taskboard-linux-host-admission-'));
    const dataDir = join(dir, 'state');
    const workspace = join(dir, 'workspace');
    const fakeCodexPath = join(dir, 'fake-codex.py');
    await mkdir(dataDir, { mode: 0o700 });
    await mkdir(workspace, { mode: 0o700 });
    await copyFile(fakeCodexFixture, fakeCodexPath);
    await chmod(fakeCodexPath, 0o700);
    const { old: oldEnvironment, logPath } = await setFakeEnvironment(dir, workspace, fakeCodexPath);

    let task = { id: 'linux-host-admission-task', projectId: 'linux-host-admission-project',
      title: 'Create a task conversation', goal: 'Exercise Linux task-job admission',
      conversationId: null, status: 'blocked', blockedReason: 'Codex quota exhausted',
      acceptance: 'unverified', revision: 1, contentVersion: 1 };
    const project = { id: task.projectId, directory: workspace, retirementHandoffGeneration: null };
    let executorTreeCaptureCalls = 0;
    const admissions = [];
    let retirementCallbackCalls = 0;
    const processProof = {
      async captureExecutorBaseline() {
        return { verified: true, baseline: Object.freeze({ fixture: 'valid-prelaunch-baseline' }) };
      },
      async captureTaskExecutorTree() {
        executorTreeCaptureCalls++;
        return { verified: false, reason: 'Native process snapshot is unconfirmed: list_changed_during_scan' };
      },
    };
    const plugin = createPlugin({ dataDir, pluginDir, processProof,
      getTask: async id => id === task.id ? task : null,
      getProject: async id => id === project.id ? project : null,
      updateTask: async (id, patch, revision) => {
        assert.equal(id, task.id);
        assert.equal(task.revision, revision);
        task = { ...task, ...patch, revision: revision + 1 };
        return task;
      },
      verifyLinuxExecutorAdmission: async input => {
        admissions.push(input);
        assert.equal(input.taskId, task.id);
        assert.equal(input.workspace, workspace);
        assert.ok(input.recordId, 'the host passes the actual prepared Linux job record ID');
        assert.ok(input.bridgePid > 1 && input.appServerPid > 1);
        return { verified: true, scope: 'fixture-Core-admission-boundary' };
      },
      verifyLinuxJobRetirement: async input => {
        retirementCallbackCalls++;
        return fakeRetirementReceipt({ dataDir, input });
      },
    });

    let sessionResult = null;
    let primaryFailure = null;
    let cleanupFailure = null;
    let closeError = null;
    let markerBeforeClose = null;
    try {
      await plugin.configure({ pythonPath, codexPath: fakeCodexPath, pollSeconds: 86400 });
      sessionResult = await plugin.createSession({ taskId: task.id, expectedRevision: task.revision,
        commandId: 'linux-host-admission-session', workspaceWrite: true });
      assert.equal(sessionResult.status, 'created', sessionResult.error);
      assert.equal(sessionResult.threadId, 'new-thread');
      assert.equal(task.conversationId, sessionResult.threadId);
      assert.equal(executorTreeCaptureCalls, 0,
        'real Linux-job admission must not reject on a redundant whole-tree process snapshot');
      assert.equal(admissions.length, 1, 'successful createSession crosses the Core Linux admission callback');
      assert.equal(admissions[0].commandId, 'linux-host-admission-session');
      assert.equal((await readFile(logPath, 'utf8')).includes('"method": "thread/start"'), true,
        'the fake provider created the requested thread after admission');
      const state = await readHostState(dataDir);
      markerBeforeClose = state.executors?.[`task:${task.id}`];
      assert.equal(markerBeforeClose?.kind, 'linux-job');
      assert.equal(markerBeforeClose?.recordId, admissions[0].recordId);
    } catch (error) { primaryFailure = error; }
    finally {
      try { await plugin.close(); }
      catch (error) { closeError = error; }

      try {
        const state = await readHostState(dataDir).catch(() => null);
        markerBeforeClose ||= state?.executors?.[`task:${task.id}`] || null;
        if (markerBeforeClose?.kind === 'linux-job') {
          const record = await readLinuxExecutorJobRecord({ recordRoot: markerBeforeClose.recordRoot,
            recordId: markerBeforeClose.recordId, taskId: markerBeforeClose.taskId,
            projectId: markerBeforeClose.projectId, workspace: markerBeforeClose.workspace, pythonPath });
          assert.equal(record.phase, 'retired', 'cleanup asks the original Linux job to stop and confirms its durable record');
          const pids = [markerBeforeClose.pid, markerBeforeClose.appServerPid,
            record.supervisorIdentity?.pid, record.bridgeIdentity?.pid].filter(Number.isSafeInteger);
          // nativeSelectedIdentities requires live PIDs; absence is an error,
          // not an empty map. Wait only for these fixture-owned /proc entries.
          const deadline = Date.now() + 5000;
          let remaining;
          do {
            remaining = (await Promise.all([...new Set(pids)].map(async pid => {
              try { await access(`/proc/${pid}/stat`); return pid; }
              catch (error) { if (error.code === 'ENOENT') return null; throw error; }
            }))).filter(pid => pid !== null);
            if (remaining.length) await delay(25);
          } while (remaining.length && Date.now() < deadline);
          assert.deepEqual(remaining, [], 'the real job, bridge and provider child exited after cleanup');
        }
        if (closeError && sessionResult?.status === 'created') throw closeError;
        if (closeError && sessionResult?.status !== 'created' && markerBeforeClose?.kind === 'linux-job') {
          // Pre-fix admission returns not_started. Host close must still stop
          // the original job, but correctly refuses to call that an idle,
          // created session. Keep the main admission assertion as the failure.
          assert.equal(markerBeforeClose.status === 'retirement_unknown' || markerBeforeClose.status === 'stopped_unknown', true,
            'fail-closed cleanup may retain its unknown host marker after stopping the job');
        }
        if (sessionResult?.status === 'created')
          assert.equal(retirementCallbackCalls, 1, 'the narrow host retirement callback verified the original retired record');
      } catch (error) { cleanupFailure = error; }

      restoreFakeEnvironment(oldEnvironment);
      if (!cleanupFailure) await rm(dir, { recursive: true, force: true });
    }

    if (primaryFailure) {
      if (cleanupFailure) { primaryFailure.cause = cleanupFailure; t.diagnostic(`Fixture cleanup: ${cleanupFailure.message}`); }
      throw primaryFailure;
    }
    if (cleanupFailure) throw cleanupFailure;
  });

test('Linux session revalidation rejection retires the admitted job before retrying with a new command ID',
  { concurrency: false, skip: skipLinux, timeout: 90000 }, async t => {
    const fixture = await createAdmissionFixture(t, { rejectFirstRevalidation: true });
    if (!fixture) return;
    try {
      const first = await fixture.plugin.createSession({ taskId: fixture.task().id,
        expectedRevision: fixture.task().revision, commandId: 'linux-session-revalidate-denied', workspaceWrite: true });
      assert.equal(first.status, 'not_started');
      assert.equal(fixture.admissions.length, 1);
      assert.equal(fixture.revalidationCalls, 1);
      assert.equal(fixture.executorTreeCaptureCalls, 0);
      assert.equal((await readFile(fixture.logPath, 'utf8')).includes('"method": "thread/start"'), false);
      assert.equal(fixture.retirements.length, 1, 'the same createSession call retires its just-admitted job');
      const markerAfterFailure = await fixture.marker();
      assert.equal(markerAfterFailure, null, 'Core retirement callback clears the matching stopped marker');
      const sameId = await fixture.plugin.createSession({ taskId: fixture.task().id,
        expectedRevision: fixture.task().revision, commandId: 'linux-session-revalidate-denied', workspaceWrite: true });
      assert.deepEqual(sameId, first, 'retrying the same command ID returns its saved not_started result');
      assert.equal((await readFile(fixture.logPath, 'utf8')).includes('"method": "thread/start"'), false,
        'the old command ID is never resent');
      assert.equal(await fixture.plugin.createSession({ taskId: fixture.task().id,
        expectedRevision: fixture.task().revision, commandId: 'linux-session-retry-explicit', workspaceWrite: true })
        .then(result => result.status), 'created', 'a new explicit command ID can retry after retirement');
      const log = await readFile(fixture.logPath, 'utf8');
      assert.equal((log.match(/"method": "thread\/start"/g) || []).length, 1,
        'only the explicit retry sends thread/start; the rejected command is never replayed');
      assert.equal(fixture.admissions.length, 2);
      const { closeError } = await fixture.close();
      assert.equal(closeError, null, 'normal close succeeds after the retried session is created');
    } catch (error) {
      await fixture.close().catch(() => {});
      throw error;
    }
  });

test('Linux admission rejection retires its unsent job and permits only an explicit new command ID retry',
  { concurrency: false, skip: skipLinux, timeout: 90000 }, async t => {
    const fixture = await createAdmissionFixture(t, { rejectAdmission: true });
    if (!fixture) return;
    try {
      const first = await fixture.plugin.createSession({ taskId: fixture.task().id,
        expectedRevision: fixture.task().revision, commandId: 'linux-session-admission-denied', workspaceWrite: true });
      assert.equal(first.status, 'not_started');
      assert.equal(fixture.admissions.length, 1);
      assert.equal(fixture.retirements.length, 1, 'the rejected admission job is stopped and verified before return');
      assert.equal(fixture.retirements[0].commandId, 'linux-session-admission-denied');
      assert.equal(await fixture.marker(), null, 'the matching stopped job marker is cleared');
      assert.equal((await readFile(fixture.logPath, 'utf8')).includes('"method": "thread/start"'), false);
      const sameId = await fixture.plugin.createSession({ taskId: fixture.task().id,
        expectedRevision: fixture.task().revision, commandId: 'linux-session-admission-denied', workspaceWrite: true });
      assert.deepEqual(sameId, first);
      assert.equal((await readFile(fixture.logPath, 'utf8')).includes('"method": "thread/start"'), false,
        'the rejected command ID is idempotent and never automatically resent');
      const retry = await fixture.plugin.createSession({ taskId: fixture.task().id,
        expectedRevision: fixture.task().revision, commandId: 'linux-session-admission-retry', workspaceWrite: true });
      assert.equal(retry.status, 'created', retry.error);
      assert.equal(fixture.admissions.length, 2, 'the explicit retry runs admission under a new command ID');
      assert.equal((await readFile(fixture.logPath, 'utf8')).split('"method": "thread/start"').length - 1, 1);
      const { closeError } = await fixture.close();
      assert.equal(closeError, null);
    } catch (error) {
      await fixture.close().catch(() => {});
      throw error;
    }
  });

test('Linux initialize failure retires its unsent job and permits only a new session command ID',
  { concurrency: false, skip: skipLinux, timeout: 90000 }, async t => {
    const fixture = await createAdmissionFixture(t, { scenario: { initializeError: true } });
    if (!fixture) return;
    const firstId = 'linux-session-initialize-failed';
    const secondId = 'linux-session-after-initialize-failed';
    const request = commandId => ({ taskId: fixture.task().id,
      expectedRevision: fixture.task().revision, commandId, workspaceWrite: true });
    try {
      let first = null;
      try { first = await fixture.plugin.createSession(request(firstId)); }
      catch { /* The durable not_started result is required even if this API rejects. */ }
      if (first) assert.equal(first.status, 'not_started');
      const state = await readHostState(fixture.dataDir);
      const saved = state.sessions?.[firstId];
      assert.equal(saved?.status, 'not_started', 'the failed pre-initialize request is durably idempotent');
      assert.equal(saved.taskId, fixture.task().id);
      assert.equal(saved.commandId, firstId);
      assert.equal(saved.threadId, undefined);
      assert.equal(saved.turnId, undefined);
      assert.equal(fixture.task().conversationId, null);
      assert.equal(fixture.admissions.length, 0, 'initialize failed before Core admission');
      assert.equal(fixture.retirements.length, 1, 'the same original job receives one retirement callback');
      const retirement = fixture.retirements[0];
      assert.ok(retirement.recordRoot && retirement.recordId && retirement.bridgePid > 1);
      assert.equal(retirement.commandId, firstId);
      assert.equal(retirement.receipt?.scope, 'linux-original-task-job-before-session-send');
      const original = await readLinuxExecutorJobRecord({ recordRoot: retirement.recordRoot,
        recordId: retirement.recordId, taskId: fixture.task().id,
        projectId: fixture.task().projectId, workspace: fixture.workspace, pythonPath });
      assert.equal(original.phase, 'retired', 'the exact original job is durably stopped');
      assert.equal(original.bridgeIdentity?.pid, retirement.bridgePid);
      assert.equal(original.authority.requestCommandId, firstId);
      assert.equal(await fixture.marker(), null, 'the matching retirement receipt clears the old marker');
      const firstLog = await readFile(fixture.logPath, 'utf8');
      assert.equal(firstLog.includes('"method": "thread/start"'), false);
      assert.equal(firstLog.includes('"method": "turn/start"'), false);

      try { await fixture.plugin.createSession(request(firstId)); }
      catch { /* A duplicate may reject, but it may not create a new job or provider request. */ }
      assert.equal(await readFile(fixture.logPath, 'utf8'), firstLog,
        'retrying the first command ID does not initialize or send to the provider again');
      assert.equal(fixture.retirements.length, 1);
      assert.equal(fixture.admissions.length, 0);
      assert.equal((await readHostState(fixture.dataDir)).sessions[firstId].status, 'not_started');

      await writeFile(fixture.scenarioPath, '{}');
      const retry = await fixture.plugin.createSession(request(secondId));
      assert.equal(retry.status, 'created', retry.error);
      assert.equal(fixture.admissions.length, 1, 'only the explicit new command is admitted');
      const finalLog = await readFile(fixture.logPath, 'utf8');
      assert.equal(finalLog.split('"method": "thread/start"').length - 1, 1);
      assert.equal(finalLog.includes('"method": "turn/start"'), false);
      const { closeError } = await fixture.close();
      assert.equal(closeError, null);
    } catch (error) {
      await fixture.close().catch(() => {});
      throw error;
    }
  });

test('Linux initialize failure keeps the original retirement fence until same-worker close verifies it',
  { concurrency: false, skip: skipLinux, timeout: 90000 }, async t => {
    const fixture = await createAdmissionFixture(t, {
      scenario: { initializeError: true }, rejectFirstRetirement: true,
    });
    if (!fixture) return;
    const firstId = 'linux-initialize-retirement-pending';
    const secondId = 'linux-initialize-blocked-new-command';
    const request = commandId => ({ taskId: fixture.task().id,
      expectedRevision: fixture.task().revision, commandId, workspaceWrite: true });
    try {
      const first = await fixture.plugin.createSession(request(firstId));
      assert.equal(first.status, 'not_started');
      assert.equal((await readHostState(fixture.dataDir)).sessions[firstId]?.status, 'not_started');
      assert.equal(fixture.retirements.length, 1, 'the first Core retirement callback rejected the original job');
      assert.equal(fixture.retirements[0].commandId, firstId);
      const originalMarker = await fixture.marker();
      assert.equal(originalMarker?.kind, 'linux-job');
      assert.equal(originalMarker.status, 'retirement_unknown');
      assert.equal(originalMarker.recordId, fixture.retirements[0].recordId);
      assert.equal(originalMarker.recordRoot, fixture.retirements[0].recordRoot);
      assert.equal(originalMarker.pid, fixture.retirements[0].bridgePid);
      assert.equal(originalMarker.requestCommandId, firstId);
      const originalRecord = await readLinuxExecutorJobRecord({ recordRoot: originalMarker.recordRoot,
        recordId: originalMarker.recordId, taskId: originalMarker.taskId,
        projectId: originalMarker.projectId, workspace: originalMarker.workspace, pythonPath });
      assert.equal(originalRecord.phase, 'retired', 'the rejected callback does not undo the real process stop');
      assert.equal(originalRecord.bridgeIdentity?.pid, originalMarker.pid);
      const firstLog = await readFile(fixture.logPath, 'utf8');
      assert.equal(firstLog.includes('"method": "thread/start"'), false);
      assert.equal(firstLog.includes('"method": "turn/start"'), false);

      await writeFile(fixture.scenarioPath, '{}');
      const blocked = await fixture.plugin.createSession(request(secondId));
      assert.equal(blocked.status, 'not_started', 'a new command cannot bypass the old retirement fence');
      assert.equal((await readHostState(fixture.dataDir)).sessions[secondId]?.status, 'not_started');
      assert.equal(await readFile(fixture.logPath, 'utf8'), firstLog,
        'the blocked command never starts a second provider process or sends a thread');
      assert.equal(fixture.admissions.length, 0);
      assert.equal(fixture.retirements.length, 1);
      const afterBlocked = await fixture.marker();
      assert.equal(afterBlocked?.status, 'retirement_unknown');
      assert.equal(afterBlocked.recordId, originalMarker.recordId);
      assert.equal(afterBlocked.recordRoot, originalMarker.recordRoot);
      assert.equal(afterBlocked.pid, originalMarker.pid);
      assert.equal(afterBlocked.requestCommandId, firstId);

      const same = await fixture.plugin.createSession(request(firstId));
      assert.deepEqual(same, first, 'the first command ID returns its saved not_started result');
      assert.equal(await readFile(fixture.logPath, 'utf8'), firstLog,
        'same-ID retry does not reinitialize the provider');
      const { closeError, marker, providerLog } = await fixture.close();
      assert.equal(closeError, null, 'same-worker close retries the exact original retirement callback');
      assert.equal(fixture.retirements.length, 2);
      assert.equal(fixture.retirements[1].recordId, originalMarker.recordId);
      assert.equal(fixture.retirements[1].recordRoot, originalMarker.recordRoot);
      assert.equal(fixture.retirements[1].commandId, firstId);
      assert.equal(fixture.retirements[1].receipt?.scope, 'linux-original-task-job-before-session-send');
      assert.equal(marker, null, 'only the verified original retirement clears the marker');
      assert.equal(providerLog, firstLog, 'close never retries provider initialization or thread creation');
    } catch (error) {
      await fixture.close().catch(() => {});
      throw error;
    }
  });

test('Linux createThread crash remains unknown and fenced after the real job stops',
  { concurrency: false, skip: skipLinux, timeout: 90000 }, async t => {
    const fixture = await createAdmissionFixture(t, { scenario: { createCrash: true } });
    if (!fixture) return;
    try {
      const first = await fixture.plugin.createSession({ taskId: fixture.task().id,
        expectedRevision: fixture.task().revision, commandId: 'linux-session-create-crash', workspaceWrite: true });
      assert.equal(first.status, 'unknown');
      assert.equal(fixture.admissions.length, 1);
      assert.equal(fixture.task().conversationId, null);
      assert.equal((await readFile(fixture.logPath, 'utf8')).split('"method": "thread/start"').length - 1, 1,
        'the fake provider logs thread/start before crashing without a reply');
      const sameId = await fixture.plugin.createSession({ taskId: fixture.task().id,
        expectedRevision: fixture.task().revision, commandId: 'linux-session-create-crash', workspaceWrite: true });
      assert.deepEqual(sameId, first, 'the original unknown command ID does not resend');
      await assert.rejects(fixture.plugin.createSession({ taskId: fixture.task().id,
        expectedRevision: fixture.task().revision, commandId: 'linux-session-create-crash-retry', workspaceWrite: true }),
      /结果未知/);
      assert.equal((await readFile(fixture.logPath, 'utf8')).split('"method": "thread\/start"').length - 1, 1,
        'a new command ID is fenced until explicit reconciliation');
      const { closeError, marker } = await fixture.close();
      assert.ok(closeError, 'unknown outcome must keep shutdown fail-closed');
      assert.equal(marker?.kind, 'linux-job');
      assert.equal(marker?.linuxStoppedReceipt?.scope, undefined,
        'unknown thread creation never receives the special pre-send retirement receipt');
      assert.equal(fixture.retirements.length, 0,
        'a stopped process alone cannot turn an ambiguous provider send into success');
    } catch (error) {
      await fixture.close().catch(() => {});
      throw error;
    }
  });

test('Linux pre-send retirement callback failure is retried by same-instance plugin.close',
  { concurrency: false, skip: skipLinux, timeout: 90000 }, async t => {
    const fixture = await createAdmissionFixture(t, {
      rejectFirstRevalidation: true,
      rejectFirstRetirement: true,
    });
    if (!fixture) return;
    try {
      const result = await fixture.plugin.createSession({ taskId: fixture.task().id,
        expectedRevision: fixture.task().revision, commandId: 'linux-session-retirement-retry', workspaceWrite: true });
      assert.equal(result.status, 'not_started');
      assert.equal(fixture.admissions.length, 1);
      assert.equal(fixture.revalidationCalls, 1);
      assert.equal(fixture.retirements.length, 1, 'the first immediate retirement callback failed');
      assert.equal((await readFile(fixture.logPath, 'utf8')).includes('"method": "thread/start"'), false);

      const markerBeforeClose = await fixture.marker();
      assert.equal(markerBeforeClose?.kind, 'linux-job');
      assert.equal(markerBeforeClose?.status, 'retirement_unknown');
      const originalRecord = await readLinuxExecutorJobRecord({ recordRoot: markerBeforeClose.recordRoot,
        recordId: markerBeforeClose.recordId, taskId: markerBeforeClose.taskId,
        projectId: markerBeforeClose.projectId, workspace: markerBeforeClose.workspace, pythonPath });
      assert.equal(originalRecord.phase, 'retired', 'the callback failure does not undo actual job retirement');
      assert.equal(originalRecord.authority.requestCommandId, 'linux-session-retirement-retry');

      const { closeError, marker, providerLog } = await fixture.close();
      assert.equal(closeError, null, 'same-instance close retries and completes the exact original retirement proof');
      assert.equal(fixture.retirements.length, 2);
      assert.equal(fixture.retirements[1].recordId, fixture.retirements[0].recordId);
      assert.equal(marker, null, 'only the matching callback retry clears the fence');
      assert.equal(fixture.task().conversationId, null);
      assert.equal(providerLog.includes('"method": "thread/start"'), false,
        'neither initial failure nor close retries provider thread creation');
    } catch (error) {
      await fixture.close().catch(() => {});
      throw error;
    }
  });
