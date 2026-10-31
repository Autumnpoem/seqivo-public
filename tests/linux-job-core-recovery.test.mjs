import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, constants, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const controller = fileURLToPath(new URL('./fixtures/linux-job-core-recovery-controller.mjs', import.meta.url));
const pythonPath = process.env.TASKBOARD_TEST_PYTHON || '/usr/bin/python3';
const tmuxPath = process.env.TASKBOARD_TEST_TMUX || join(repo, '.tools/terminal-build/install/bin/tmux');
const linux = { skip: process.platform !== 'linux', timeout: 180000 };

async function runtimeAvailable(t) {
  try { await access(pythonPath, constants.X_OK); await access(tmuxPath, constants.X_OK); }
  catch { t.skip('A Linux Python/tmux runtime is required for the native Core recovery integration'); return false; }
  return true;
}

function launch(mode, root, dataDir, workspace, serverName, ready = null, scenario = 'turn-with-id') {
  const child = spawn(process.execPath, [controller, mode, root, dataDir, workspace, serverName,
    ready ? JSON.stringify(ready) : '-', scenario], {
    cwd: workspace,
    env: { ...process.env, TASKBOARD_TEST_PYTHON: pythonPath, TASKBOARD_TEST_TMUX: tmuxPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [], stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const lines = createInterface({ input: child.stdout });
  const queuedLines = [], lineWaiters = [];
  lines.on('line', line => {
    const waiter = lineWaiters.shift();
    if (waiter) waiter(line); else queuedLines.push(line);
  });
  const readLine = async timeoutMs => {
    if (queuedLines.length) return JSON.parse(queuedLines.shift());
    let timer;
    let resolveLine;
    const pending = new Promise(resolve => { resolveLine = resolve; });
    lineWaiters.push(resolveLine);
    try {
      const line = await Promise.race([
        pending,
        new Promise((_, reject) => {
          const fail = () => reject(new Error(`fixture exited before readiness: ${Buffer.concat(stderr).toString('utf8')}`));
          if (child.exitCode !== null || child.signalCode !== null) fail();
          else child.once('exit', fail);
        }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture output timed out')),
          timeoutMs); }),
      ]);
      return JSON.parse(line);
    } finally {
      clearTimeout(timer);
      const index = lineWaiters.indexOf(resolveLine);
      if (index >= 0) lineWaiters.splice(index, 1);
    }
  };
  const waitExit = async timeoutMs => {
    if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
    let timer;
    try {
      return await Promise.race([
        new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture exit timed out')),
          timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  return { child, lines, readLine, waitExit,
    get stdoutText() { return Buffer.concat(stdout).toString('utf8'); },
    get stderrText() { return Buffer.concat(stderr).toString('utf8'); } };
}

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'seqivo-linux-core-recovery-test-'));
  const dataDir = join(root, 'data');
  const workspace = join(root, 'workspace');
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  return { root, dataDir, workspace, serverName: `seqivo_core_recovery_${process.pid}_${Date.now()}` };
}

async function killExactCore(child, identity) {
  assert.equal(identity?.kind, 'linux-proc');
  assert.equal(identity.pid, child.pid);
  const helperDir = join(repo, 'plugins/codex-autocontinue');
  const script = 'import json,os,signal,sys;sys.path.insert(0,sys.argv[1]);from process_identities import linux_identity;expected=json.loads(sys.argv[2]);fd=os.pidfd_open(expected["pid"]);actual=linux_identity(expected["pid"],expected["euid"],expected["ruid"],expected["bootId"]);assert actual and all(actual.get(k)==expected.get(k) for k in ("kind","pid","euid","ruid","bootId","startTicks"));signal.pidfd_send_signal(fd,signal.SIGKILL,None,0);os.close(fd)';
  await exec(pythonPath, ['-I', '-B', '-c', script, helperDir, JSON.stringify(identity)], { timeout: 5000 });
}

async function disposeIfAlive(fixture, ready) {
  if (!fixture || fixture.child.exitCode !== null || fixture.child.signalCode !== null) return;
  // Prefer the fixture's ordinary Core close; if it cannot finish, use only
  // the PID/birth identity it reported, never a process name or process group.
  if (fixture.child.stdin.writable) fixture.child.stdin.write('CLOSE');
  try { await fixture.waitExit(30000); return; } catch { /* exact pidfd fallback below */ }
  if (ready?.coreIdentity) {
    await killExactCore(fixture.child, ready.coreIdentity);
    await fixture.waitExit(5000).catch(() => {});
  }
}

test('Linux Core restart reattaches the original admitted job, preserves unknown outcome, and permits explicit same-shell takeover', linux, async t => {
  if (!await runtimeAvailable(t)) return;
  const f = await makeRoot();
  let first = launch('start', f.root, f.dataDir, f.workspace, f.serverName);
  let ready = null;
  let restarted = null;
  let restartIdentity = null;
  let cleanupCompleted = false;
  t.after(async () => {
    await disposeIfAlive(first, ready);
    await disposeIfAlive(restarted, restartIdentity);
    if (cleanupCompleted) await rm(f.root, { recursive: true, force: true });
    else t.diagnostic(`Linux recovery fixture retained for inspection: ${f.root}`);
    first?.lines.close(); restarted?.lines.close();
  });

  ready = await first.readLine(60000);
  assert.equal(ready.coreIdentity.pid, first.child.pid, 'fixture reports the exact original Core process');
  assert.ok(ready.recordId && ready.commandId && ready.turnId && ready.sessionRef,
    'first Core emitted durable admission, turn ID and managed pane evidence');
  assert.equal(first.child.exitCode, null, 'original Core remains live before the crash point');

  await killExactCore(first.child, ready.coreIdentity);
  const killed = await first.waitExit(5000);
  assert.equal(killed.signal, 'SIGKILL', 'only the identity-verified original Core PID was terminated');
  first.lines.close();

  restarted = launch('restart', f.root, f.dataDir, f.workspace, f.serverName, ready);
  const restartReady = await restarted.readLine(30000);
  assert.equal(restartReady.stage, 'restart-core-ready');
  restartIdentity = restartReady.coreIdentity;
  assert.equal(restartIdentity.pid, restarted.child.pid);
  const exit = await restarted.waitExit(90000);
  assert.equal(exit.code, 0, `fresh Core recovery fixture failed: ${restarted.stderrText || restarted.stdoutText}`);
  const result = JSON.parse(restarted.stdoutText.trim().split('\n').at(-1));
  assert.equal(result.phase, 'recovered');
  assert.equal(result.recordId, ready.recordId);
  assert.equal(result.commandId, ready.commandId);
  assert.equal(result.turnId, ready.turnId);
  assert.equal(result.takeover, 'human');
  assert.equal(result.leaseStatus, 'unknown');
  assert.equal(result.providerTurnStarts, 1, 'no recovered Core path resubmitted the old provider command');
  assert.equal(result.shellPid, ready.shellIdentity.pid, 'human input used the original shell PID');
  assert.equal(result.cleanupConfirmed, true);
  t.diagnostic(`explicit recovery rechecks: ${result.explicitRecoveryRechecks}`);
  cleanupCompleted = true;
  restarted.lines.close();
});

test('Linux Core restart retires an interrupted provider turn without promoting it to a final-turn proof', linux, async t => {
  if (!await runtimeAvailable(t)) return;
  const f = await makeRoot();
  let first = launch('start', f.root, f.dataDir, f.workspace, f.serverName, null, 'turn-interrupted');
  let ready = null;
  let restarted = null;
  let restartIdentity = null;
  let cleanupCompleted = false;
  t.after(async () => {
    await disposeIfAlive(first, ready);
    await disposeIfAlive(restarted, restartIdentity);
    if (cleanupCompleted) await rm(f.root, { recursive: true, force: true });
    else t.diagnostic(`Interrupted-turn fixture retained for inspection: ${f.root}`);
    first?.lines.close(); restarted?.lines.close();
  });

  ready = await first.readLine(60000);
  assert.equal(ready.coreIdentity.pid, first.child.pid);
  assert.equal(ready.preCrashCommandStatus, 'interrupted', 'provider interruption was persisted before the crash point');
  assert.equal(ready.preCrashStopProofStatus, 'unverified', 'the host has no OS process-exit proof');
  assert.equal(ready.preCrashFinalTurnProof, null, 'the host has no final-turn proof');
  assert.ok(ready.recordId && ready.commandId && ready.turnId && ready.admission);
  await killExactCore(first.child, ready.coreIdentity);
  const killed = await first.waitExit(5000);
  assert.equal(killed.signal, 'SIGKILL', 'only the identity-verified original Core PID was terminated');
  first.lines.close();

  restarted = launch('restart', f.root, f.dataDir, f.workspace, f.serverName, ready, 'turn-interrupted');
  const restartReady = await restarted.readLine(30000);
  assert.equal(restartReady.stage, 'restart-core-ready');
  restartIdentity = restartReady.coreIdentity;
  assert.equal(restartIdentity.pid, restarted.child.pid);
  const exit = await restarted.waitExit(90000);
  assert.equal(exit.code, 0, `interrupted-turn recovery fixture failed: ${restarted.stderrText || restarted.stdoutText}`);
  const result = JSON.parse(restarted.stdoutText.trim().split('\n').at(-1));
  assert.equal(result.phase, 'recovered');
  assert.equal(result.recordId, ready.recordId);
  assert.equal(result.turnId, ready.turnId);
  assert.equal(result.takeover, 'human');
  assert.equal(result.leaseStatus, 'unknown');
  assert.equal(result.providerTurnStarts, 1, 'restart did not resend the interrupted provider command');
  assert.equal(result.shellPid, ready.shellIdentity.pid, 'takeover used the original shell');
  assert.equal(result.cleanupConfirmed, true);
  cleanupCompleted = true;
  restarted.lines.close();
});

test('Linux Core restart without an admitted turn ID cannot claim retirement or grant takeover', linux, async t => {
  if (!await runtimeAvailable(t)) return;
  const f = await makeRoot();
  let first = launch('start', f.root, f.dataDir, f.workspace, f.serverName, null, 'turn-no-id');
  let ready = null;
  let restarted = null;
  let restartIdentity = null;
  let cleanupCompleted = false;
  t.after(async () => {
    await disposeIfAlive(first, ready);
    await disposeIfAlive(restarted, restartIdentity);
    if (cleanupCompleted) await rm(f.root, { recursive: true, force: true });
    else t.diagnostic(`No-turn-ID fixture retained for inspection: ${f.root}`);
    first?.lines.close(); restarted?.lines.close();
  });

  ready = await first.readLine(60000);
  assert.equal(ready.turnId, null, 'fake provider is held before it returns a turn ID');
  assert.ok(ready.recordId && ready.commandId && ready.admission,
    'Core admission exists, but provider turn identity is not yet known');
  await killExactCore(first.child, ready.coreIdentity);
  const killed = await first.waitExit(5000);
  assert.equal(killed.signal, 'SIGKILL');
  first.lines.close();

  restarted = launch('restart', f.root, f.dataDir, f.workspace, f.serverName, ready, 'turn-no-id');
  const restartReady = await restarted.readLine(30000);
  assert.equal(restartReady.stage, 'restart-core-ready');
  restartIdentity = restartReady.coreIdentity;
  assert.equal(restartIdentity.pid, restarted.child.pid);
  const exit = await restarted.waitExit(90000);
  assert.equal(exit.code, 0, `no-turn-ID negative fixture failed: ${restarted.stderrText || restarted.stdoutText}`);
  const result = JSON.parse(restarted.stdoutText.trim().split('\n').at(-1));
  assert.equal(result.phase, 'rejected-no-turn-id');
  assert.equal(result.takeoverGranted, false, 'missing turn identity never grants human control');
  assert.equal(result.retirementReceipt, false, 'missing turn identity cannot yield a retirement receipt');
  assert.equal(result.closeClaimedSafe, false, 'Core/plugin close cannot report safe retirement without the required proof');
  assert.equal(result.providerTurnStarts, 1, 'the interrupted original request was not resent');
  assert.equal(result.shellPid, ready.shellIdentity.pid, 'the original shell remains available for inspection');
  assert.equal(result.cleanupConfirmed, true, 'test cleanup retired only its exact pane after assertions');
  cleanupCompleted = true;
  restarted.lines.close();
});
