// Opt-in integration acceptance. Uses an existing Codex login, not a test double.
// All writes and process cleanup are scoped to new disposable workspaces.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCore } from '../server/core.mjs';
import { inspectWorkspaceWriters } from '../server/terminal/process-inspection.mjs';

if (process.env.SEQIVO_REAL_PAUSE_TEST !== '1') throw new Error('Set SEQIVO_REAL_PAUSE_TEST=1 to run a real isolated Codex pause test');
const codexPath = process.env.SEQIVO_TEST_CODEX, pythonPath = process.env.SEQIVO_TEST_PYTHON;
const recheckUnknown = process.env.SEQIVO_TEST_RECHECK_UNKNOWN === '1';
if (![codexPath, pythonPath].every(path => typeof path === 'string' && isAbsolute(path)))
  throw new Error('Provide absolute Codex and Python executable paths, never credentials');
for (const path of [codexPath, pythonPath]) {
  try { await access(path, constants.X_OK); }
  catch { throw new Error('A required executable is unavailable; no acceptance job was started'); }
}
const root = await realpath(await mkdtemp(join(tmpdir(), 'seqivo-real-pause-')));
const workspace = join(root, 'project-A'), otherWorkspace = join(root, 'project-B');
const qa = resolve(process.env.QA_DIR || '.runtime/qa-real-pause');
await mkdir(qa, { recursive: true }); await mkdir(workspace); await mkdir(otherWorkspace);
const script = join(workspace, 'controlled.py'), readyPath = join(workspace, 'ready.json'), latePath = join(workspace, 'late.txt');
await writeFile(script, `import os,json,time\nfrom pathlib import Path\nroot=Path(__file__).parent\n(root/'ready.json').write_text(json.dumps({'pid':os.getpid(),'startedAt':time.time()}))\nprint('CONTROLLED_PAUSE_READY',flush=True)\ntime.sleep(45)\n(root/'late.txt').write_text('UNEXPECTED_LATE_WRITE')\n`);
execFileSync('git', ['init', '-q', workspace]);
const evidence = { startedAt: new Date().toISOString(), passed: false, realProvider: true, physicalPhone: false,
  entryPoint: 'real Core conversation and pause APIs',
  mode: recheckUnknown ? 'pause-and-explicit-retirement-recheck' : 'immediate-pause',
  controlledCommandStarted: false,
  recheckExercised: false,
  scope: 'one controlled long-running command; not short-command or arbitrary-descendant acceptance' };
evidence.sourceHashes = {};
for (const path of ['server/codex-process-proof.mjs', 'server/executor-process-proof.mjs',
  'plugins/codex-autocontinue/process_snapshot.py', 'server/terminal/process-inspection.mjs',
  'plugins/codex-autocontinue/host.mjs', 'plugins/codex-autocontinue/auto-policy.mjs',
  'plugins/codex-autocontinue/bridge.py', 'server/core.mjs',
  'server/execution-leases.mjs', 'server/plugin-loader.mjs',
  'server/plugin-process.mjs', 'server/plugin-worker.mjs',
  'server/terminal/manager.mjs', 'server/terminal/managed-pane-registry.mjs',
  'plugins/codex-autocontinue/job-transport.mjs', 'plugins/codex-autocontinue/executor_job.py',
  'server/macos-executor-job.mjs', 'server/macos-executor-job-record.mjs',
  'scripts/verify-real-pause.mjs']) {
  evidence.sourceHashes[path] = createHash('sha256').update(await readFile(resolve(path))).digest('hex');
}
let core, other, ready, taskId, executionId;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const safe = message => String(message || '').replaceAll(root, '[fixture]').replace(/https?:\/\/\S+/g, '[endpoint]').slice(0,1200);
async function progress(stage) {
  evidence.stage = stage;
  await writeFile(join(qa, 'progress.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ stage, taskStatus: evidence.taskStatus, pauseStatus: evidence.pauseStatus }));
}
async function until(fn, milliseconds, label) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { if (await fn()) return; await delay(200); }
  throw new Error(label);
}
try {
  core = await createCore({ dataDir: join(root, 'data'), pluginDir: resolve('plugins'), files: false });
  await core.plugin.configure({ codexPath, pythonPath });
  const project = core.store.project({ name: 'Real pause acceptance A (disposable)', directory: workspace });
  core.store.project({ name: 'Independent process B (disposable)', directory: otherWorkspace });
  other = spawn(pythonPath, ['-c', 'import time;time.sleep(240)'], { cwd: otherWorkspace, detached: true, stdio: 'ignore' });
  await new Promise((done, fail) => { other.once('spawn', done); other.once('error', fail); });
  const commandId = randomUUID(); executionId = `${commandId}:turn`;
  // Observe only this disposable creation/send before the conversation API
  // replaces adapter errors with an unknown receipt. Do not retry the call.
  for (const method of ['createSession', 'resume']) {
    const original = core.plugin[method].bind(core.plugin);
    core.plugin[method] = async input => {
      try { return await original(input); }
      catch (error) {
        if ([`${commandId}:session`, executionId].includes(input.commandId))
          evidence.adapterFailure = { method,
            code: /^[A-Z_]{1,64}$/.test(error?.code || '') ? error.code : 'UNCLASSIFIED',
            message: safe(error?.message)
              .replace(/(?:\/Users\/|\/private\/|\/tmp\/|\/var\/)[^\s'"<>]+/g, '[path]')
              .replace(/[A-Za-z0-9_-]{32,}/g, '[opaque]').slice(0, 300) };
        throw error;
      }
    };
  }
  const result = await core.request('POST', '/api/conversations', { projectId: project.id, commandId,
    title: 'Verify actual command termination',
    message: `Controlled local integration test. Run exactly this foreground command with exec_command yield_time_ms 1000 and then wait for it to finish: ${pythonPath} ${script}\nThe script writes only ready.json and late.txt in this disposable workspace. Do not run other commands, edit files, use network, change configuration or spawn agents. If interrupted, do not restart the command.` });
  taskId = result.taskId; evidence.startStatus = result.status;
  if (result.status === 'waiting_quota') {
    const state = await core.plugin.state();
    evidence.startWakeAt = result.wakeAt || null;
    const quota = state?.quota;
    evidence.quota = quota ? {
      blocked: quota.blocked === true,
      checkedAt: quota.checkedAt || null,
      windows: (Array.isArray(quota.windows) ? quota.windows : []).map(window => ({
        name: typeof window.name === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(window.name) ? window.name : 'unspecified',
        usedPercent: Number.isFinite(window.usedPercent) ? window.usedPercent : null,
        windowDurationMins: Number.isFinite(window.windowDurationMins) ? window.windowDurationMins : null,
        resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt : null,
      })),
    } : null;
    throw Object.assign(new Error('Provider quota unavailable; controlled command was not started'), { code: 'QUOTA_WAIT' });
  }
  assert.ok(taskId && ['running','completed','submitted'].includes(result.status), `Unexpected start result ${result.status}`);
  await progress('waiting-for-controlled-command');
  await until(async () => {
    try { ready = JSON.parse(await readFile(readyPath, 'utf8')); return Number.isSafeInteger(ready.pid) && ready.pid > 1; } catch { return false; }
  }, 180000, 'Real provider did not start the controlled command');
  const command = execFileSync('/bin/ps', ['-ww', '-p', String(ready.pid), '-o', 'command='], { encoding: 'utf8' });
  assert.ok(command.includes(script), 'Ready PID does not belong to the fixture command');
  evidence.controlledCommandStarted = true;
  assert.equal(alive(other.pid), true);
  await progress('requesting-pause');
  const task = core.store.getTask(taskId);
  const pauseStarted = performance.now();
  const paused = await core.request('POST', `/api/tasks/${taskId}/pause`, { expectedRevision: task.revision });
  evidence.pauseElapsedMs = Math.round(performance.now() - pauseStarted);
  evidence.pauseStatus = paused.status; evidence.pauseError = safe(paused.error);
  evidence.immediatePauseConfirmed = paused.status === 'paused';
  evidence.taskStatus = core.store.getTask(taskId).status;
  const execution = await core.plugin.getExecution({ taskId, commandId: executionId });
  evidence.executionStatus = execution.status;
  evidence.actualModel = execution.actualModel || 'NOT VERIFIED';
  evidence.actualProcessExited = !alive(ready.pid);
  evidence.otherProjectProcessAlive = alive(other.pid);
  if (paused.status !== 'paused') {
    const inspection = await inspectWorkspaceWriters({ workspace });
    evidence.pauseWorkspaceInspection = {
      ...inspection,
      writers: inspection.writers?.map(row => ({ ...row, path: safe(row.path) })),
    };
    const pids = inspection.livePids?.filter(pid => Number.isSafeInteger(pid) && pid > 1) || [];
    if (pids.length && pids.length <= 256) {
      try { evidence.pauseWriterProcesses = safe(execFileSync('/bin/ps',
        ['-p', pids.join(','), '-o', 'pid=,ppid=,pgid=,lstart=,comm='], { encoding: 'utf8' })); }
      catch { evidence.pauseWriterProcesses = 'Process disappeared before diagnostic snapshot'; }
    }
  }
  await progress('pause-returned');
  // Preserve the physical outcome even when a conservative ancestry check
  // keeps the API unknown. File observations alone never confirm retirement.
  if (paused.status === 'paused')
    await until(() => core.leases.state().active.length === 0, 15000, 'Confirmed pause did not reconcile its execution lease');
  const remaining = Math.max(0, (ready.startedAt + 48) * 1000 - Date.now());
  await progress('waiting-past-original-write-deadline');
  await delay(remaining);
  let late = false; try { await readFile(latePath); late = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  evidence.delayedWriteExists = late; evidence.actualProcessExited = !alive(ready.pid);
  evidence.otherProjectProcessAlive = alive(other.pid);
  evidence.writeDeadlineObservedAt = new Date().toISOString();
  let finalPauseStatus = paused.status;
  if (paused.status !== 'paused' && recheckUnknown) {
    // A separate opt-in case exercises the same explicit reconciliation API
    // as the owner UI. One read-only recheck; no replay, fresh capture or stop.
    // The original immediate-pause outcome remains in the report unchanged.
    const current = core.store.getTask(taskId);
    const saved = JSON.parse(await readFile(join(root, 'data', 'plugins', 'codex-autocontinue', 'codex-autocontinue.json'), 'utf8'));
    const marker = saved.executors?.[`task:${taskId}`];
    const bound = marker?.status === 'retirement_unknown' && marker.taskId === taskId &&
      marker.projectId === current.projectId && marker.threadId === current.conversationId &&
      marker.workspace === workspace && Number.isSafeInteger(marker.pid) && marker.pid > 1 &&
      typeof marker.retirementId === 'string' && marker.retirementId.length === 36;
    if (!bound) {
      evidence.recheckSkipped = 'No original task-bound retirement_unknown marker; ordinary conversation reconciliation was not invoked';
      throw new Error(evidence.recheckSkipped);
    }
    evidence.recheckExercised = true;
    await progress('explicit-original-retirement-recheck');
    const reconciled = await core.request('POST', '/api/plugin/reconcile', { taskId,
      expectedRevision: current.revision, expectedRetirementId: marker.retirementId });
    evidence.recheckStatus = reconciled.status;
    evidence.recheckError = safe(reconciled.error);
    evidence.taskStatus = core.store.getTask(taskId).status;
    evidence.executionStatus = (await core.plugin.getExecution({ taskId, commandId: executionId })).status;
    assert.equal(reconciled.status, 'paused', reconciled.error || 'Original executor retirement was not confirmed');
    assert.equal(evidence.taskStatus, 'paused');
    assert.equal(evidence.executionStatus, 'paused');
    finalPauseStatus = reconciled.status;
    await until(() => core.leases.state().active.length === 0, 15000, 'Verified retirement did not reconcile its execution lease');
  }
  assert.equal(finalPauseStatus, 'paused', paused.error);
  assert.equal(late, false, 'Paused command still performed a delayed write');
  assert.equal(evidence.actualProcessExited, true);
  assert.equal(evidence.otherProjectProcessAlive, true, 'Pause affected the independent project process');
  assert.notEqual(core.store.getTask(taskId).acceptance, 'passed');
  evidence.functionalChecksPassed = true;
} catch (error) {
  evidence.errorCode = typeof error.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'UNCLASSIFIED';
  evidence.error = safe(error.message); process.exitCode = 1;
  if (core) {
    evidence.taskStatus = taskId ? core.store.getTask(taskId)?.status : null;
    evidence.execution = taskId && executionId ? await core.plugin.getExecution({ taskId, commandId: executionId }).catch(() => null) : null;
  }
} finally {
  // Cleanup is not pause evidence: inspect before killing only our own fixture.
  if (ready && alive(ready.pid)) {
    const command = execFileSync('/bin/ps', ['-ww', '-p', String(ready.pid), '-o', 'command='], { encoding: 'utf8' });
    if (command.includes(script)) { process.kill(ready.pid, 'SIGTERM'); await until(() => !alive(ready.pid), 5000, 'Fixture cleanup failed').catch(error => { evidence.cleanupError = safe(error.message); }); }
  }
  if (other && other.exitCode === null && !other.signalCode) {
    other.kill('SIGTERM'); await new Promise(done => other.once('exit', done));
  }
  const closeStarted = performance.now();
  try { await core?.close(); evidence.cleanShutdown = true; }
  catch (error) { evidence.cleanShutdown = false; evidence.shutdownError = safe(error.message); process.exitCode = 1; }
  evidence.shutdownElapsedMs = Math.round(performance.now() - closeStarted);
  evidence.finishedAt = new Date().toISOString();
  evidence.passed = evidence.functionalChecksPassed === true && evidence.cleanShutdown === true && !evidence.cleanupError;
  if (evidence.passed) await rm(root, { recursive: true, force: true });
  else await writeFile(join(qa, 'fixture-location.txt'), root + '\n', { mode: 0o600 });
  await writeFile(join(qa, 'result.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: evidence.passed, stage: evidence.stage, pauseStatus: evidence.pauseStatus, error: evidence.error }));
}
