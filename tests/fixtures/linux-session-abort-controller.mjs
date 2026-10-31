import assert from 'node:assert/strict';
import { access, chmod, cp, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCore } from '../../server/core.mjs';
import { recoverLinuxExecutorJob } from '../../server/linux-executor-job.mjs';

const [root, dataDir, workspace, scenario] = process.argv.slice(2);
assert.ok(['before-initialize', 'before-admission', 'after-revalidate'].includes(scenario));
const repo = fileURLToPath(new URL('../../', import.meta.url));
const pythonPath = process.env.TASKBOARD_TEST_PYTHON || '/usr/bin/python3';
const pluginRoot = join(root, 'plugins');
const pluginDir = join(pluginRoot, 'codex-autocontinue');
const observedPath = join(root, 'first-job-observed.json');
const negativePath = join(root, 'retirement-negative-checks.json');
const logPath = join(root, 'fake-appserver.jsonl');
const statePath = join(dataDir, 'plugins', 'codex-autocontinue', 'codex-autocontinue.json');
const firstId = 'linux-session-abort-first';
const secondId = 'linux-session-abort-second';
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const originalBirthAlive = async identity => {
  const stat = await readFile(`/proc/${identity.pid}/stat`, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return false;
  const end = stat.lastIndexOf(')');
  assert.ok(end > 0, 'original bridge stat remains parseable');
  return stat.slice(end + 1).trim().split(/\s+/)[19] === identity.startTicks;
};
const requests = async () => (await readFile(logPath, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return '';
  throw error;
})).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const admissions = core => {
  const row = core.store.db.prepare('SELECT value FROM metadata WHERE key=?')
    .get('linux.executor-admissions.v1');
  return row ? JSON.parse(row.value).admissions : [];
};

await mkdir(root, { recursive: true, mode: 0o700 });
await mkdir(dataDir, { recursive: true, mode: 0o700 });
await mkdir(workspace, { recursive: true, mode: 0o700 });
await symlink(join(repo, 'server'), join(root, 'server'), 'dir');
await cp(join(repo, 'plugins', 'codex-autocontinue'), pluginDir, { recursive: true });
await rename(join(pluginDir, 'host.mjs'), join(pluginDir, 'implementation.mjs'));
await writeFile(join(pluginDir, 'host.mjs'), `
import { randomUUID } from 'node:crypto';
import { open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPlugin as createRealPlugin } from './implementation.mjs';

export function createPlugin(options) {
  const scenario = process.env.TASKBOARD_ABORT_SCENARIO;
  let injected = false;
  let retirementChecked = false;
  const statePath = join(options.dataDir, 'codex-autocontinue.json');
  const atomicState = async bytes => {
    const temporary = statePath + '.' + randomUUID();
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, statePath);
    const directory = await open(options.dataDir, 'r');
    try { await directory.sync(); }
    finally { await directory.close(); }
  };
  const authorityRows = () => {
    const db = new DatabaseSync(join(options.dataDir, '..', '..', 'board.sqlite'), { readOnly: true });
    try {
      const read = key => db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value ?? null;
      return [read('linux.executor-admissions.v1'), read('execution.leases.v1')];
    } finally { db.close(); }
  };
  const retirement = async (input, callback) => {
    if (input.commandId !== 'linux-session-abort-first' || retirementChecked) return callback(input);
    retirementChecked = true;
    if (scenario === 'before-initialize') await observe(input);
    const negatives = [];
    const rejectChangedState = async (name, change) => {
      const original = await readFile(statePath);
      const changed = JSON.parse(original.toString('utf8'));
      change(changed);
      const before = authorityRows();
      await atomicState(Buffer.from(JSON.stringify(changed)));
      let rejected = false;
      try {
        try { await callback(input); }
        catch { rejected = true; }
      } finally { await atomicState(original); }
      if (!rejected) throw new Error('fixture_retirement_negative_accepted_' + name);
      if (JSON.stringify(authorityRows()) !== JSON.stringify(before))
        throw new Error('fixture_retirement_negative_wrote_authority_' + name);
      negatives.push({ name, rejected, authorityUnchanged: true });
    };
    await rejectChangedState('session-status', state => {
      const session = state.sessions?.['linux-session-abort-first'];
      if (session?.status !== 'not_started') throw new Error('fixture_expected_not_started_session');
      session.status = 'unknown';
    });
    await rejectChangedState('worker-birth', state => {
      const owner = state.executors?.['task:' + input.taskId]?.linuxStartupOwner;
      if (!owner?.startTicks) throw new Error('fixture_expected_startup_owner');
      owner.startTicks = (BigInt(owner.startTicks) + 1n).toString();
    });
    await writeFile(process.env.TASKBOARD_ABORT_NEGATIVES, JSON.stringify(negatives), { mode: 0o600 });
    return callback(input);
  };
  const before = async (input, callback) => {
    if (process.env.TASKBOARD_ABORT_SCENARIO === 'before-admission' &&
        input.commandId === 'linux-session-abort-first' && !injected) {
      injected = true;
      await observe(input);
      throw new Error('fixture_pre_dispatch_admission_rejected');
    }
    return callback(input);
  };
  const after = async (input, callback) => {
    const result = await callback(input);
    if (process.env.TASKBOARD_ABORT_SCENARIO === 'after-revalidate' &&
        input.commandId === 'linux-session-abort-first' && !injected) {
      injected = true;
      await observe(input);
      throw new Error('fixture_pre_dispatch_revalidate_rejected');
    }
    return result;
  };
  async function observe(input) {
    const state = JSON.parse(await readFile(join(options.dataDir, 'codex-autocontinue.json'), 'utf8'));
    const marker = state.executors['task:' + input.taskId];
    if (!marker?.recordId || !marker.recordRoot || !marker.pid ||
        (scenario !== 'before-initialize' && !marker.appServerPid))
      throw new Error('fixture_original_job_marker_missing');
    if (scenario === 'before-initialize') {
      if (marker.appServerPid !== null || input.appServerPid !== null ||
          input.recordId !== marker.recordId || input.bridgePid !== marker.pid ||
          process.pid !== marker.linuxStartupOwner?.pid)
        throw new Error('fixture_pre_initialize_retirement_binding_changed');
    }
    await writeFile(process.env.TASKBOARD_ABORT_OBSERVED,
      JSON.stringify({ taskId: input.taskId, projectId: marker.projectId,
        recordId: marker.recordId, recordRoot: marker.recordRoot,
        workspace: marker.workspace, bridgePid: marker.pid, appServerPid: marker.appServerPid ?? null,
        linuxStartupOwner: marker.linuxStartupOwner }));
  }
  return createRealPlugin({ ...options,
    verifyLinuxExecutorAdmission: input => before(input, options.verifyLinuxExecutorAdmission),
    revalidateExecution: input => after(input, options.revalidateExecution),
    verifyLinuxJobRetirement: input => retirement(input, options.verifyLinuxJobRetirement) });
}
`);

const codexPath = join(workspace, 'fake-codex.py');
await cp(join(repo, 'tests', 'plugin-fake-codex.py'), codexPath);
await chmod(codexPath, 0o700);
await writeFile(join(root, 'fake-scenario.json'), '{}');
Object.assign(process.env, {
  TASKBOARD_ABORT_SCENARIO: scenario,
  TASKBOARD_ABORT_OBSERVED: observedPath,
  TASKBOARD_ABORT_NEGATIVES: negativePath,
  TASKBOARD_FAKE_SCENARIO: join(root, 'fake-scenario.json'),
  TASKBOARD_FAKE_LOG: logPath,
  TASKBOARD_FAKE_PID: join(root, 'fake-appserver.pid'),
  TASKBOARD_FAKE_CWD: workspace,
  CODEX_CLI_PATH: codexPath,
});

let core = null;
let firstJob = null;
let secondJob = null;
let failure = null;
try {
  core = await createCore({ dataDir, pluginDir: pluginRoot, files: false,
    managedPythonPath: pythonPath });
  const project = core.store.project({ name: 'Linux pre-dispatch session abort', directory: workspace });
  await core.request('PATCH', '/api/plugins/codex-autocontinue/config', {
    pythonPath, codexPath, pollSeconds: 86400,
  });
  const quota = await core.request('POST', '/api/plugin/check');
  assert.equal(quota.available, true, quota.lastError);
  const task = core.store.createTask({ projectId: project.id, title: 'Never sent first session',
    executionProvider: 'codex-autocontinue' });
  const sessionInput = commandId => ({ expectedRevision: task.revision, commandId, workspaceWrite: true });
  if (scenario === 'before-initialize')
    await writeFile(join(root, 'fake-scenario.json'), JSON.stringify({ initializeError: true }));
  const first = await core.request('POST', `/api/tasks/${task.id}/session`, sessionInput(firstId));
  assert.equal(first.status, 'not_started', first.error);
  assert.equal(first.threadId, undefined, 'a failed pre-send session has no provider thread');
  assert.equal(first.turnId, undefined, 'a failed pre-send session has no provider turn');
  if (scenario !== 'before-initialize')
    assert.match(first.error || '', /fixture_pre_dispatch_(?:admission|revalidate)_rejected/);
  else {
    assert.match(first.error || '', /fixture initialize failed/i);
    const initCount = (await requests()).filter(row => row.method === 'initialize').length;
    assert.equal(initCount, 2, 'quota initialization succeeded first, then the task provider initialization failed');
    await writeFile(join(root, 'fake-scenario.json'), '{}');
  }
  firstJob = await readJson(observedPath);
  if (scenario === 'before-initialize')
    assert.equal(firstJob.appServerPid, null, 'no provider app-server PID was returned from failed initialize');
  assert.ok(firstJob.linuxStartupOwner?.pid > 1 && firstJob.linuxStartupOwner?.startTicks,
    'the observed original job carries its exact Linux startup-worker birth');
  const negatives = await readJson(negativePath);
  assert.deepEqual(negatives, [
    { name: 'session-status', rejected: true, authorityUnchanged: true },
    { name: 'worker-birth', rejected: true, authorityUnchanged: true },
  ], 'Core rejects both changed private Host proofs without writing admission or lease metadata');
  assert.equal(firstJob.taskId, task.id);
  assert.equal(firstJob.projectId, project.id);
  assert.equal((await requests()).filter(row => row.method === 'thread/start').length, 0,
    'the injected rejection precedes the first provider session request');
  assert.equal((await requests()).filter(row => row.method === 'turn/start').length, 0);
  const firstRecord = await readJson(join(firstJob.recordRoot, firstJob.recordId, 'record.json'));
  assert.equal(firstRecord.phase, 'retired', 'the original real Linux job retired');
  assert.equal(firstRecord.bridgeIdentity?.pid, firstJob.bridgePid);
  assert.ok(firstRecord.bridgeIdentity?.startTicks, 'the observed record retains the original bridge birth');
  if (scenario === 'before-initialize') {
    assert.equal(firstJob.appServerPid, null, 'the failing provider initialize never returned a verified app-server PID');
    assert.equal(firstRecord.authority.requestCommandId, firstId);
  }
  assert.equal(await originalBirthAlive(firstRecord.bridgeIdentity), false,
    'the original bridge birth is no longer present');
  const oldMarker = (await readJson(statePath)).executors?.[`task:${task.id}`];
  assert.equal(oldMarker, undefined, 'Core retirement receipt allows Host to clear only the old job');
  assert.equal(core.store.getTask(task.id).conversationId || null, null,
    'a rejected pre-dispatch session never binds a conversation');
  const leaseRow = core.store.db.prepare('SELECT value FROM metadata WHERE key=?')
    .get('execution.leases.v1');
  const oldLease = leaseRow && JSON.parse(leaseRow.value).reservations?.find(item =>
    item.taskId === task.id && item.commandId === firstId);
  assert.equal(oldLease, undefined, 'a session rejected before provider dispatch has no ordinary command lease');
  const oldAdmission = admissions(core).find(item => item.recordId === firstJob.recordId);
  if (scenario === 'before-admission' || scenario === 'before-initialize') {
    assert.equal(oldAdmission, undefined, 'Core never durably admitted the rejected first job');
  } else {
    assert.ok(oldAdmission, 'revalidate rejection follows a durable Core admission');
    assert.equal(oldAdmission.receipt?.scope, 'linux-original-task-job-before-session-send',
      'the old admission is retired before a new job can be admitted');
  }

  const replay = await core.request('POST', `/api/tasks/${task.id}/session`, sessionInput(firstId));
  assert.equal(replay.status, 'not_started', 'the original command ID stays idempotent');
  assert.equal((await requests()).filter(row => row.method === 'thread/start').length, 0);
  const second = await core.request('POST', `/api/tasks/${task.id}/session`, sessionInput(secondId));
  assert.equal(second.status, 'created', second.error);
  assert.equal((await requests()).filter(row => row.method === 'thread/start').length, 1,
    'only the new explicit command starts a provider session');
  assert.equal((await requests()).filter(row => row.method === 'turn/start').length, 0);
  const secondMarker = (await readJson(statePath)).executors?.[`task:${task.id}`];
  assert.ok(secondMarker?.recordId && secondMarker.recordId !== firstJob.recordId);
  secondJob = { recordId: secondMarker.recordId, recordRoot: secondMarker.recordRoot };
  await core.close();
  core = null;
  assert.equal((await readJson(join(firstJob.recordRoot, firstJob.recordId, 'record.json'))).phase, 'retired');
  assert.equal((await readJson(join(secondJob.recordRoot, secondJob.recordId, 'record.json'))).phase, 'retired');
  await assert.rejects(access(join(dataDir, 'core.lock')), { code: 'ENOENT' },
    'safe Core close removes only its own lock');
  process.stdout.write(`${JSON.stringify({ scenario, phase: 'retired-and-recreated',
    originalRecordId: firstJob.recordId, newRecordId: secondJob.recordId,
    providerSessionStarts: 1, rejectedRetirements: negatives.length, cleanupConfirmed: true })}\n`);
} catch (error) {
  failure = error;
} finally {
  if (core) {
    try { await core.close(); }
    catch (error) { process.stderr.write(`Fixture Core close unconfirmed: ${error.message}\n`); }
  }
  if (failure && firstJob) {
    // Only the exact private test-owned job may be stopped on a failed assertion.
    const recovered = await recoverLinuxExecutorJob({ recordRoot: firstJob.recordRoot,
      recordId: firstJob.recordId, taskId: firstJob.taskId,
      projectId: firstJob.projectId, workspace: firstJob.workspace, pythonPath });
    if (recovered.verified && recovered.job) await recovered.job.stop();
  }
}
if (failure) throw failure;
