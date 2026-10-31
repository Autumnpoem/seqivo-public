import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, rm, realpath, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createManagedTmuxSession, connectManagedPane } from '../server/terminal/managed-pane.mjs';

const execFileAsync = promisify(execFile);
const nodePython = process.env.TASKBOARD_TEST_PYTHON || '/usr/bin/python3';
const tmuxPath = process.env.TASKBOARD_TEST_TMUX || '.tools/terminal-build/install/bin/tmux';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(30);
  }
  throw new Error('managed tmux condition timed out');
}

test('isolated tmux relay preserves shell identity across park, resume and control reconnect', async t => {
  if (!['darwin', 'linux'].includes(process.platform)) { t.skip('PTY unsupported'); return; }
  try { await access(nodePython, constants.X_OK); await access(tmuxPath, constants.X_OK); }
  catch { t.skip('Python or isolated tmux executable unavailable'); return; }
  const root = await mkdtemp(join(tmpdir(), 'seqivo-managed-tmux-'));
  const serverName = `seqivo_managed_${randomBytes(6).toString('hex')}`;
  const run = (args) => execFileAsync(tmuxPath, ['-L', serverName, ...args], { timeout: 5000 });
  let subject;
  t.after(async () => {
    if (subject) {
      try {
        let pane = subject.pane;
        if (pane.closed) pane = await connectManagedPane({ socketPath: pane.socketPath,
          capability: pane.capability, expectedIdentity: subject.shellIdentity });
        let state = await pane.status();
        if (state.inputFrozen || state.state === 'stopped') await pane.resume();
        await run(['send-keys', '-t', subject.relayPaneId, 'exit', 'Enter']);
        await until(async () => (await pane.status()).state === 'exited', 3000);
        await pane.shutdown();
        pane.close();
      } catch {
        // Test-owned supervisor only; failed cleanup cannot serve as proof.
        try { process.kill(subject.shellIdentity.supervisorPid, 'SIGTERM'); } catch {}
      }
    }
    try { await run(['kill-server']); } catch {}
    if (subject) await rm(dirname(subject.pane.socketPath), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  subject = await createManagedTmuxSession({ pythonPath: nodePython, shell: '/bin/sh', args: ['-i'], cwd: root,
    rootDir: tmpdir(), tmuxPath: await realpath(tmuxPath), serverName, name: 'managed_a' });
  let pane = subject.pane;
  assert.notEqual(subject.relayPanePid, pane.identity.childPid);
  assert.equal(Object.keys(pane).includes('capability'), false);
  await until(async () => { try { await access(pane.relay.tokenFile); return false; } catch { return true; } });
  const relayArgv = (await execFileAsync('ps', ['-p', String(subject.relayPanePid), '-o', 'command='])).stdout;
  assert.equal(relayArgv.includes(pane.capability), false, 'control capability must not appear in tmux pane argv');
  const capture = async () => (await run(['capture-pane', '-p', '-t', subject.relayPaneId])).stdout;
  await run(['send-keys', '-t', subject.relayPaneId, 'printf MANAGED_READY', 'Enter']);
  await until(async () => (await capture()).includes('MANAGED_READY'));
  const parked = await pane.park();
  assert.equal(parked.childPid, subject.shellIdentity.childPid);
  assert.equal((await pane.status()).state, 'stopped');
  const forbidden = join(root, 'forbidden');
  await run(['send-keys', '-t', subject.relayPaneId, `touch ${forbidden}`, 'Enter']);
  await sleep(180);
  await assert.rejects(access(forbidden), { code: 'ENOENT' });
  await pane.resume();
  await sleep(180);
  await assert.rejects(access(forbidden), { code: 'ENOENT' }, 'old-epoch keys must not run after resume');
  const permitted = join(root, 'permitted');
  await run(['send-keys', '-t', subject.relayPaneId, `touch ${permitted}`, 'Enter']);
  await until(async () => { try { await access(permitted); return true; } catch { return false; } });
  pane.close();
  pane = await connectManagedPane({ socketPath: pane.socketPath, capability: pane.capability,
    expectedIdentity: subject.shellIdentity });
  assert.equal((await pane.status()).inputFrozen, true);
  await pane.resume();
  assert.equal((await pane.status()).childPid, subject.shellIdentity.childPid);
  subject = { ...subject, pane };
  await run(['send-keys', '-t', subject.relayPaneId, 'sleep 20', 'Enter']);
  await sleep(180);
  await assert.rejects(pane.park(), /foreground_job_active/);
  assert.equal((await pane.status()).inputFrozen, true);
  await pane.resume();
  await run(['send-keys', '-t', subject.relayPaneId, 'C-c']);
  await until(async () => (await pane.status()).state === 'running');

  // External SIGSTOP of the shell must not turn an active foreground job
  // into a successful park, and must freeze the relay before refusing.
  await run(['send-keys', '-t', subject.relayPaneId, 'sleep 20', 'Enter']);
  await until(async () => {
    const table = (await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,pgid='])).stdout;
    return table.trim().split('\n').some(line => {
      const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
      return pid > 0 && ppid === subject.shellIdentity.childPid && pgid !== subject.shellIdentity.childPid;
    });
  });
  process.kill(subject.shellIdentity.childPid, 'SIGSTOP');
  try {
    await until(async () => (await pane.status()).state === 'stopped');
    await assert.rejects(pane.park(), /foreground_job_active/);
    assert.equal((await pane.status()).inputFrozen, true);
    const stale = join(root, 'stale-after-external-stop');
    await run(['send-keys', '-t', subject.relayPaneId, `touch ${stale}`, 'Enter']);
    process.kill(subject.shellIdentity.childPid, 'SIGCONT');
    await until(async () => (await pane.status()).state === 'running');
    await pane.resume();
    await sleep(100);
    await assert.rejects(access(stale), { code: 'ENOENT' });
  } finally {
    try { process.kill(subject.shellIdentity.childPid, 'SIGCONT'); } catch {}
    try {
      if ((await pane.status()).inputFrozen) await pane.resume();
      await run(['send-keys', '-t', subject.relayPaneId, 'C-c']);
    } catch {}
  }
});

test('normal shell exit drains the final relay output and lets tmux end the original session', async t => {
  if (process.platform !== 'darwin') { t.skip('macOS isolated tmux integration'); return; }
  try { await access(nodePython, constants.X_OK); await access(tmuxPath, constants.X_OK); }
  catch { t.skip('Python or isolated tmux unavailable'); return; }
  const root = await mkdtemp(join(tmpdir(), 'seqivo-managed-tail-'));
  const serverName = `seqivo_tail_${randomBytes(6).toString('hex')}`;
  const run = args => execFileAsync(tmuxPath, ['-L', serverName, ...args], { timeout: 5000 });
  let subject;
  t.after(async () => {
    if (subject) {
      let cleaned = false;
      try {
        const pane = subject.pane.closed ? await connectManagedPane({ socketPath: subject.pane.socketPath,
          capability: subject.pane.capability, expectedIdentity: subject.shellIdentity }) : subject.pane;
        const status = await pane.status();
        if (status.state !== 'exited') {
          if (status.inputFrozen) await pane.resume();
          await run(['send-keys', '-t', subject.relayPaneId, 'exit', 'Enter']);
          await until(async () => (await pane.status()).state === 'exited', 3000);
        }
        await pane.shutdown(); pane.close();
        cleaned = true;
      } catch { /* Uncertain identity: keep the isolated fixture for diagnosis. */ }
      if (!cleaned) return;
      await rm(dirname(subject.pane.socketPath), { recursive: true, force: true });
    }
    try { await run(['kill-server']); } catch {}
    await rm(root, { recursive: true, force: true });
  });
  subject = await createManagedTmuxSession({ pythonPath: nodePython, shell: '/bin/sh', args: ['-i'], cwd: root,
    rootDir: tmpdir(), tmuxPath: await realpath(tmuxPath), serverName, name: 'tail_a' });
  const tail = join(root, 'tail.log');
  await run(['pipe-pane', '-o', '-t', subject.relayPaneId, `cat > ${tail}`]);
  await run(['send-keys', '-t', subject.relayPaneId, 'printf FINAL_OUTPUT_57; exit', 'Enter']);
  await until(async () => (await readFile(tail, 'utf8').catch(() => '')).includes('FINAL_OUTPUT_57'));
  await until(async () => {
    try { const { stdout } = await run(['list-sessions', '-F', '#{session_id}']);
      return !stdout.includes(subject.sessionRef.sessionId); }
    catch { return true; }
  });
  assert.equal((await subject.pane.status()).state, 'exited');
});
