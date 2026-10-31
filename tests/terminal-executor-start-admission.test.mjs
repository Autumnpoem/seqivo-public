import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createCore } from '../server/core.mjs';
import { prepareExecutorJob, observeExecutorJobCohort } from '../server/macos-executor-job.mjs';
import { taskJobRecordRoot } from '../plugins/codex-autocontinue/job-transport.mjs';
import { inspectWorkspaceWriters } from '../server/terminal/process-inspection.mjs';
import { nativeProcessTable } from '../server/codex-process-proof.mjs';
import { reconnectManagedTmuxSession, verifyManagedTmuxSession } from '../server/terminal/managed-pane-record.mjs';
import { readJobRecord } from '../server/macos-executor-job-record.mjs';

const exec = promisify(execFile);
const pythonPath = process.env.TASKBOARD_TEST_PYTHON;
const tmuxPath = process.env.TASKBOARD_TEST_TMUX
  ? resolve(process.env.TASKBOARD_TEST_TMUX) : resolve('.tools/terminal-build/install/bin/tmux');
const sameBirth = (a, b) => Boolean(a && b &&
  ['pid', 'euid', 'ruid', 'startSec', 'startUsec'].every(key => a[key] === b[key]));
const safeDiagnostic = value => typeof value === 'string'
  ? value.slice(0, 240).replace(/(?:file:)?\/[\S]+/g, '[path]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[id]') : null;
const wait = ms => new Promise(done => setTimeout(done, ms));
async function until(check, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await wait(50);
  }
  throw new Error('Isolated executor admission condition timed out');
}

test('the original job cohort may hold cwd after startup admission while a foreign writer remains blocked', async t => {
  if (process.platform !== 'darwin') return t.skip('macOS job and managed pane proof required');
  assert.ok(isAbsolute(pythonPath || ''), 'Set absolute TASKBOARD_TEST_PYTHON');
  await access(pythonPath, constants.X_OK);
  await access(tmuxPath, constants.X_OK);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seqivo-executor-admission-')));
  const dataDir = join(root, 'data'), workspace = join(root, 'workspace');
  await mkdir(dataDir); await mkdir(workspace);
  // The isolated plugin worker inherits environment only at Core startup.
  // Establish the fake protocol fixture before creating that worker.
  const fakeCodex = join(root, 'fake-codex.py');
  await copyFile(fileURLToPath(new URL('./plugin-fake-codex.py', import.meta.url)), fakeCodex);
  // Keep the shared fake provider unchanged. This fixture alone can hold its
  // initialize reply while Core edits the task bound to the opening job.
  const fakeSource = await readFile(fakeCodex, 'utf8');
  assert.ok(fakeSource.includes('    if method == "initialize":\n'));
  await writeFile(fakeCodex, fakeSource.replace('    if method == "initialize":\n',
    '    if method == "initialize":\n' +
    '        if scenario.get("holdInitialize") and os.path.exists(os.environ["TASKBOARD_FAKE_GATE_REQUEST"]):\n' +
    '            with open(os.environ["TASKBOARD_FAKE_GATE_ENTERED"], "w") as gate: gate.write(str(os.getpid()))\n' +
    '            deadline = time.monotonic() + 8\n' +
    '            while not os.path.exists(os.environ["TASKBOARD_FAKE_GATE_RELEASE"]):\n' +
    '                if time.monotonic() > deadline: raise RuntimeError("fixture initialize gate timed out")\n' +
    '                time.sleep(0.02)\n'));
  await chmod(fakeCodex, 0o700);
  const fakeScenario = join(root, 'scenario.json');
  await writeFile(fakeScenario, JSON.stringify({ notifyInterrupted: true }));
  const fakeEnvKeys = ['TASKBOARD_FAKE_SCENARIO', 'TASKBOARD_FAKE_LOG',
    'TASKBOARD_FAKE_PID', 'TASKBOARD_FAKE_CWD', 'TASKBOARD_FAKE_GATE_REQUEST',
    'TASKBOARD_FAKE_GATE_ENTERED', 'TASKBOARD_FAKE_GATE_RELEASE'];
  const previousFakeEnv = Object.fromEntries(fakeEnvKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    TASKBOARD_FAKE_SCENARIO: fakeScenario,
    TASKBOARD_FAKE_LOG: join(root, 'fake-appserver.log'),
    TASKBOARD_FAKE_PID: join(root, 'fake-appserver.pid'),
    TASKBOARD_FAKE_CWD: workspace,
    TASKBOARD_FAKE_GATE_REQUEST: join(root, 'open-gate-request'),
    TASKBOARD_FAKE_GATE_ENTERED: join(root, 'open-gate-entered'),
    TASKBOARD_FAKE_GATE_RELEASE: join(root, 'open-gate-release'),
  });
  await writeFile(process.env.TASKBOARD_FAKE_LOG, '');
  const serverName = `seqivo_admission_${randomBytes(6).toString('hex')}`;
  const run = (...args) => exec(tmuxPath, ['-L', serverName, ...args], { timeout: 5000 });
  let core, job, foreign, foreignIdentity, pane;
  const failures = [];
  t.after(async () => {
    if (foreign) {
      try {
        const rows = await nativeProcessTable(pythonPath, 15_000);
        if (rows.has(foreign.pid)) {
          if (!sameBirth(rows.get(foreign.pid), foreignIdentity)) throw Error('Foreign fixture process identity changed');
          const exited = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('Foreign fixture process did not exit')), 5000);
            foreign.once('exit', () => { clearTimeout(timer); resolve(); });
          });
          foreign.kill('SIGTERM');
          await exited;
        }
      } catch (error) { failures.push(new Error('Foreign fixture cleanup unconfirmed', { cause: error })); }
    }
    if (job) {
      try {
        const stopped = await job.stop();
        if (!stopped.retired && !(await job.recheck()).retired) throw Error('Original task job retirement unknown');
        await job.dispose();
      } catch (error) { failures.push(new Error('Original task job cleanup unconfirmed', { cause: error })); }
    }
    if (core) {
      try { await core.close(); }
      catch (error) { failures.push(new Error('Core shutdown unconfirmed', { cause: error })); }
    }
    try {
      const recordsRoot = join(dataDir, 'terminal-managed-records');
      const directories = await readdir(recordsRoot);
      if (directories.length !== 1) throw Error('Expected one exact managed pane record');
      const recordPath = join(recordsRoot, directories[0], 'record.json');
      const proof = await verifyManagedTmuxSession({ recordRoot: recordsRoot, recordPath });
      const original = proof.identities;
      const subject = await reconnectManagedTmuxSession({ recordRoot: recordsRoot, recordPath });
      pane = subject.pane;
      const state = await pane.status();
      if (state.state !== 'exited') {
        if (state.state === 'stopped' || state.inputFrozen) await pane.resume();
        await run('send-keys', '-t', proof.relayPaneId, 'exit', 'Enter');
        await until(async () => (await pane.status()).state === 'exited', 5000);
      }
      await pane.shutdown();
      await until(async () => {
        const rows = await nativeProcessTable(pythonPath, 15_000);
        return [original.supervisor, original.shell, original.relay]
          .every(identity => !sameBirth(rows.get(identity.pid), identity));
      }, 8000);
      await until(async () => {
        try { await run('has-session', '-t', proof.sessionRef.sessionId); return false; }
        catch (error) { if (error.code === 1) return true; throw error; }
      }, 5000);
      const record = JSON.parse(await readFile(recordPath, 'utf8'));
      await rm(record.pane.directory, { recursive: true, force: true });
      try { await run('kill-server'); }
      catch (error) {
        if (error.code !== 1 || !/^no server running on /i.test(String(error.stderr || '').trim())) throw error;
      }
      try { await run('list-sessions'); throw Error('Isolated tmux server still exists'); }
      catch (error) {
        if (error.code !== 1 || !/^no server running on /i.test(String(error.stderr || '').trim())) throw error;
      }
    } catch (error) { failures.push(new Error('Managed fixture cleanup unconfirmed', { cause: error })); }
    finally { pane?.close(); }
    for (const key of fakeEnvKeys) {
      if (previousFakeEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousFakeEnv[key];
    }
    if (failures.length) {
      t.diagnostic(`Retained isolated executor admission fixture: ${root}`);
      throw new AggregateError(failures, 'Isolated executor admission cleanup unconfirmed');
    }
    await rm(root, { recursive: true, force: true });
  });

  core = await createCore({ dataDir,
    pluginDir: fileURLToPath(new URL('../plugins/', import.meta.url)), files: false,
    managedPythonPath: pythonPath });
  const project = core.store.project({ name: 'Disposable executor admission', directory: workspace });
  await core.request('POST', '/api/terminal/profiles', { id: 'managed', label: 'Isolated managed',
    projectId: project.id, enabled: true, shell: '/bin/sh', serverName,
    allowSharedServer: true, tmuxExecutable: tmuxPath });
  const frames = [], ctx = { local: true, profileId: 'managed', connectionId: 'isolated-owner' };
  const send = frame => frames.push(frame);
  await core.terminal.frame(ctx, { v: 1, type: 'open', mode: 'tmux', cols: 80, rows: 24 }, send);
  await core.terminal.frame(ctx, { v: 1, type: 'takeover' }, send);
  await core.terminal.frame(ctx, { v: 1, type: 'create', epoch: 0, name: 'original' }, send);
  assert.ok(frames.some(frame => frame.type === 'ready' && frame.sessionRef));
  await core.terminal.frame(ctx, { v: 1, type: 'return' }, send);
  const initialReturn = frames.filter(frame => frame.type === 'control').at(-1);
  assert.equal(initialReturn?.phase, 'ai_ready',
    safeDiagnostic(initialReturn?.reason) || 'Initial managed return was not confirmed');

  await core.terminal.verifyManagedForExecution(project.id);
  const task = core.store.createTask({ projectId: project.id, title: 'Isolated executor',
    executionProvider: 'codex-autocontinue', conversationId: 'isolated-thread' });
  const jobDataDir = join(dataDir, 'plugins', 'codex-autocontinue');
  await mkdir(jobDataDir, { recursive: true, mode: 0o700 });
  const recordRoot = await taskJobRecordRoot(jobDataDir);
  job = await prepareExecutorJob({ taskId: task.id, command: '/bin/cat', cwd: workspace,
    pythonPath, recordRoot });
  await job.spawn();
  const rows = await nativeProcessTable(pythonPath, 15_000);
  assert.ok(sameBirth(rows.get(job.identity.pid), job.identity), 'Original task job birth changed');
  const writers = await inspectWorkspaceWriters({ workspace });
  assert.equal(writers.verified, true, writers.reason);
  assert.ok(writers.writers.some(row => row.pid === job.identity.pid && row.reason === 'cwd'),
    'The exact newly started task job must be visible as a cwd writer');
  t.diagnostic(`Original task job cwd writer matched PID ${job.identity.pid} and birth ${job.identity.startSec}.${job.identity.startUsec}`);
  await assert.rejects(core.terminal.verifyManagedForExecution(project.id),
    { code: 'MANAGED_PANE_UNKNOWN' });
  const admitted = await observeExecutorJobCohort({ recordRoot, recordId: job.recordId,
    taskId: task.id, workspace, pythonPath });
  assert.equal(admitted.verified,true,admitted.reason);
  assert.ok(admitted.members.some(row=>sameBirth(row,job.identity)));
  await core.terminal.verifyManagedForExecution(project.id,admitted);
  foreign = spawn('/bin/sleep', ['120'], { cwd: workspace, stdio: 'ignore' });
  await new Promise((resolveSpawn, rejectSpawn) => {
    foreign.once('spawn', resolveSpawn); foreign.once('error', rejectSpawn);
  });
  const foreignRows = await nativeProcessTable(pythonPath, 15_000);
  foreignIdentity = foreignRows.get(foreign.pid);
  assert.ok(foreignIdentity && foreignIdentity.pid === foreign.pid &&
    Number.isSafeInteger(foreignIdentity.startSec) && Number.isSafeInteger(foreignIdentity.startUsec),
  'Foreign fixture birth unavailable');
  const external = await inspectWorkspaceWriters({ workspace });
  assert.ok(external.writers?.some(row => row.pid === foreign.pid && row.reason === 'cwd'));
  t.diagnostic(`Separate unowned cwd writer matched PID ${foreignIdentity.pid} and birth ${foreignIdentity.startSec}.${foreignIdentity.startUsec}`);
  await assert.rejects(core.terminal.verifyManagedForExecution(project.id),
    { code: 'MANAGED_PANE_UNKNOWN' });
  // Even an otherwise valid original job cohort cannot cover another writer.
  await assert.rejects(core.terminal.verifyManagedForExecution(project.id,admitted),
    { code: 'MANAGED_PANE_UNKNOWN' });
  const foreignExited=new Promise((resolveExit,rejectExit)=>{
    const timer=setTimeout(()=>rejectExit(Error('Foreign fixture failed to retire')),5000);
    foreign.once('exit',()=>{clearTimeout(timer);resolveExit();});
  });
  foreign.kill('SIGTERM');
  await foreignExited;
  foreign=null;
  const stopped = await job.stop();
  assert.equal(stopped.retired || (await job.recheck()).retired, true);
  await job.dispose();
  job = null;
  await core.terminal.verifyManagedForExecution(project.id);

  // Exercise the actual Core -> isolated built-in worker -> macOS job path.
  // This protocol fixture has no Codex binary, model request, or real AI turn.
  await core.plugin.configure({ pythonPath, codexPath: fakeCodex, pollSeconds: 86400 });
  const result = await core.plugin.resume({ taskId: task.id, expectedRevision: task.revision,
    commandId: 'isolated-startup-turn' });
  assert.equal(result.status, 'running');
  assert.equal(core.leases.state().active.length, 1);
  assert.equal(core.leases.state().active[0].taskId, task.id);
  const fakeRequests = (await readFile(process.env.TASKBOARD_FAKE_LOG, 'utf8')).trim()
    .split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(fakeRequests.filter(row => row.method === 'turn/start').length, 1);
  const pauseDiagnostic = async (result, error) => {
    try {
      const saved = JSON.parse(await readFile(join(jobDataDir, 'codex-autocontinue.json'), 'utf8'));
      const marker = saved.executors?.[`task:${task.id}`];
      const command = saved.commands?.[`${task.id}:isolated-startup-turn`];
      const leaseRow = core.store.db.prepare('SELECT value FROM metadata WHERE key=?')
        .get('execution.leases.v1');
      const lease = leaseRow && JSON.parse(leaseRow.value).reservations
        .find(row => row.taskId === task.id && row.provider === 'codex-autocontinue');
      let recordPhase = null, recordReadCode = null;
      if (marker?.recordId) {
        try { recordPhase = (await readJobRecord(recordRoot, marker.recordId, task.id, workspace)).phase; }
        catch (readError) { recordReadCode = safeDiagnostic(readError.code) || 'unavailable'; }
      }
      t.diagnostic(`Pause retirement snapshot: ${JSON.stringify({
        pauseStatus: result?.status ?? null, pauseReason: safeDiagnostic(result?.reason),
        pauseCode: safeDiagnostic(result?.code), errorCode: safeDiagnostic(error?.code),
        errorReason: safeDiagnostic(error?.message), causeCode: safeDiagnostic(error?.cause?.code),
        causeReason: safeDiagnostic(error?.cause?.message), markerStatus: marker?.status ?? null,
        markerReason: safeDiagnostic(marker?.reason), recordPhase, recordReadCode,
        commandStatus: command?.status ?? null,
        commandStopProofStatus: command?.stopProof?.status ?? null,
        commandStopProofReason: safeDiagnostic(command?.stopProof?.reason),
        markerCommandIsTest: marker?.lastCommandId === 'isolated-startup-turn',
        leaseStatus: lease?.status ?? null, leaseCurrentIsStartup: lease
          ? lease.commandId === lease.startupId : null,
        leaseHasRecord: Boolean(lease?.recordId), leaseCommandIsTest: lease
          ? lease.commandId === 'isolated-startup-turn' : null,
      })}`);
    } catch (snapshotError) {
      t.diagnostic(`Pause retirement snapshot unavailable: ${safeDiagnostic(snapshotError.code) || 'unavailable'}`);
    }
  };
  let paused;
  try { paused = await core.plugin.pause({ taskId: task.id,
    expectedRevision: core.store.getTask(task.id).revision }); }
  catch (error) { await pauseDiagnostic(null, error); throw error; }
  if (paused.status !== 'paused') await pauseDiagnostic(paused, null);
  assert.equal(paused.status, 'paused');
  assert.equal(core.leases.state().active.length, 0);
  await core.terminal.verifyManagedForExecution(project.id);

  // A second real fake-provider turn is stopped by the managed takeover's
  // stopping -> quiesce path, where ai_ready is intentionally no longer true.
  const takeoverTask = core.store.createTask({ projectId: project.id, title: 'Separate takeover turn',
    conversationId: 'isolated-takeover-thread', executionProvider: 'codex-autocontinue' });
  assert.equal((await core.plugin.resume({ taskId: takeoverTask.id, expectedRevision: takeoverTask.revision,
    commandId: 'isolated-takeover-turn' })).status, 'running');
  await core.terminal.frame(ctx, { v: 1, type: 'takeover' }, send);
  assert.equal(frames.filter(frame => frame.type === 'control').at(-1).phase, 'human');
  assert.equal(core.leases.state().active.length, 0,
    'the stopped original job lease must retire before human takeover');
  assert.equal((await readFile(process.env.TASKBOARD_FAKE_LOG, 'utf8')).trim().split('\n')
    .filter(Boolean).map(JSON.parse).filter(row => row.method === 'turn/start').length, 2);

  // First-conversation creation has no conversationId at startup. The same
  // admitted lease must bind the provider's new thread before a turn exists.
  await core.terminal.frame(ctx, { v: 1, type: 'return' }, send);
  assert.equal(frames.filter(frame => frame.type === 'control').at(-1).phase, 'ai_ready');
  const firstSessionTask = core.store.createTask({ projectId: project.id,
    title: 'Unbound first conversation', executionProvider: 'codex-autocontinue' });
  const firstSession = await core.request('POST', `/api/tasks/${firstSessionTask.id}/session`, {
    expectedRevision: firstSessionTask.revision, commandId: 'isolated-first-session',
    workspaceWrite: false,
  });
  assert.equal(firstSession.status, 'created', firstSession.error);
  assert.equal(firstSession.threadId, 'new-thread');
  assert.equal(core.store.getTask(firstSessionTask.id).conversationId, firstSession.threadId);
  assert.equal(core.leases.state().active.length, 1);
  assert.equal(core.leases.state().active[0].taskId, firstSessionTask.id);
  const afterSession = (await readFile(process.env.TASKBOARD_FAKE_LOG, 'utf8')).trim()
    .split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(afterSession.filter(row => row.method === 'thread/start').length, 1);
  assert.equal(afterSession.filter(row => row.method === 'turn/start').length, 2,
    'creating the first conversation must not send a turn');
  await core.plugin.disable();
  assert.equal(core.leases.state().active.length, 0);

  await core.plugin.enable();
  const changingTask = core.store.createTask({ projectId: project.id,
    title: 'Open barrier revision change', conversationId: 'isolated-changing-thread',
    executionProvider: 'codex-autocontinue' });
  await writeFile(fakeScenario, JSON.stringify({ notifyInterrupted: true, holdInitialize: true }));
  await writeFile(process.env.TASKBOARD_FAKE_GATE_REQUEST, 'ready');
  const opening = core.plugin.resume({ taskId: changingTask.id,
    expectedRevision: changingTask.revision, commandId: 'isolated-open-barrier' });
  await until(async () => access(process.env.TASKBOARD_FAKE_GATE_ENTERED).then(() => true, () => false));
  const gatePid = Number(await readFile(process.env.TASKBOARD_FAKE_GATE_ENTERED, 'utf8'));
  const openingSaved = JSON.parse(await readFile(join(jobDataDir, 'codex-autocontinue.json'), 'utf8'));
  const openingMarker = openingSaved.executors?.[`task:${changingTask.id}`];
  assert.ok(openingMarker?.recordId, 'the held initialize belongs to an admitted task job');
  const openingRecord = await readJobRecord(recordRoot, openingMarker.recordId, changingTask.id, workspace);
  const openingRows = await nativeProcessTable(pythonPath, 15_000);
  assert.ok(sameBirth(openingRows.get(openingRecord.identity.pid), openingRecord.identity));
  let ancestor = openingRows.get(gatePid), originalJobAncestor = false;
  for (let depth = 0; ancestor && depth < 12; depth++) {
    if (sameBirth(ancestor, openingRecord.identity)) { originalJobAncestor = true; break; }
    ancestor = openingRows.get(ancestor.ppid);
  }
  assert.equal(originalJobAncestor, true,
    'the held app-server initialize must descend from this task’s original job');
  core.store.updateTask(changingTask.id, { summary: 'Edited while original job opens' }, changingTask.revision);
  await writeFile(process.env.TASKBOARD_FAKE_GATE_RELEASE, 'continue');
  const changed = await opening.then(value => value, error => ({ status: 'rejected', error }));
  assert.notEqual(changed.status, 'running', 'an edited task cannot confirm its old startup');
  const afterEdit = (await readFile(process.env.TASKBOARD_FAKE_LOG, 'utf8')).trim()
    .split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(afterEdit.filter(row => row.method === 'turn/start').length, 2,
    'the stale startup must not send a provider turn');
  const staleLease = core.store.db.prepare('SELECT value FROM metadata WHERE key=?')
    .get('execution.leases.v1');
  const staleRow = JSON.parse(staleLease.value).reservations.find(row => row.taskId === changingTask.id);
  assert.equal(staleRow?.ready, false, 'the old job must never become ready after the edit');
});
