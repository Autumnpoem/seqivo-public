import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { createManagedPane, connectManagedPane } from '../server/terminal/managed-pane.mjs';

const pythonPath = process.env.TASKBOARD_TEST_PYTHON || '/usr/bin/python3';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(20);
  }
  throw new Error('Managed pane condition timed out');
}

async function fixture(t) {
  if (!['darwin', 'linux'].includes(process.platform)) { t.skip('PTY supervisor supports macOS and Linux'); return null; }
  try { await access(pythonPath, constants.X_OK); } catch { t.skip('Python runtime unavailable'); return null; }
  const root = await mkdtemp(join(tmpdir(), 'seqivo-pane-test-'));
  let pane = await createManagedPane({ pythonPath, shell: '/bin/sh', args: ['-i'], cwd: root });
  const identity = pane.identity;
  t.after(async () => {
    try {
      if (pane.closed) pane = await connectManagedPane({ socketPath: pane.socketPath, capability: pane.capability, expectedIdentity: identity });
      const state = await pane.status();
      if (state.state === 'stopped') await pane.resume();
      if (state.state !== 'exited') {
        await pane.write('exit\n');
        await until(async () => (await pane.status()).state === 'exited', 2000);
      }
      await pane.shutdown();
      pane.close();
    } catch {
      // Only test-owned processes.  If the fixture cannot prove a clean exit,
      // stop its known supervisor; do not infer any product stop evidence.
      try { process.kill(identity.supervisorPid, 'SIGTERM'); } catch {}
    }
    await rm(dirname(pane.socketPath), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  return { root, get pane() { return pane; }, set pane(value) { pane = value; }, identity };
}

test('managed PTY shell survives park and resume with the same directly owned child', async t => {
  const f = await fixture(t); if (!f) return;
  let output = '';
  f.pane.on('data', chunk => { output += chunk.toString('utf8'); });
  await f.pane.write('printf "BEFORE\\n"\n');
  await until(() => output.includes('BEFORE'));
  assert.deepEqual(await f.pane.resize(31, 97), { rows: 31, cols: 97 });
  await f.pane.write('stty size\n');
  await until(() => output.includes('31 97'));
  const parked = await f.pane.park();
  assert.deepEqual(parked, { parked: true, childPid: f.identity.childPid });
  assert.equal((await f.pane.status()).state, 'stopped');
  await assert.rejects(f.pane.write('printf "FORBIDDEN\\n"\n'), /child_not_running/);
  await sleep(150);
  assert.equal(output.includes('FORBIDDEN'), false);
  assert.deepEqual(await f.pane.resume(), { resumed: true, childPid: f.identity.childPid });
  await f.pane.write('printf "AFTER\\n"\n');
  await until(() => output.includes('AFTER'));
  assert.deepEqual(f.pane.identity, f.identity);
});

test('managed PTY delivers Ctrl-C to a foreground job; park refuses that job', async t => {
  const f = await fixture(t); if (!f) return;
  let output = '';
  f.pane.on('data', chunk => { output += chunk.toString('utf8'); });
  await f.pane.write('sleep 20\n');
  await sleep(150);
  await assert.rejects(f.pane.park(), /foreground_job_active/);
  await f.pane.write(Buffer.from([3]));
  await f.pane.write('printf "INTERRUPTED\\n"\n');
  await until(() => output.includes('INTERRUPTED'), 4000);
  assert.equal((await f.pane.status()).state, 'running');
});

test('wrong capability cannot attach; original capability reattaches after disconnect', async t => {
  const f = await fixture(t); if (!f) return;
  const { socketPath, capability } = f.pane;
  f.pane.close();
  await assert.rejects(connectManagedPane({ socketPath, capability: '0'.repeat(64) }), /refused|closed|reset|EPIPE/i);
  await assert.rejects(connectManagedPane({ socketPath, capability,
    expectedIdentity: { ...f.identity, childPid: f.identity.childPid + 1 } }), /process identity changed/);
  f.pane = await connectManagedPane({ socketPath, capability, expectedIdentity: f.identity });
  assert.equal((await f.pane.status()).childPid, f.identity.childPid);
});

test('exited child cannot be parked or resumed and supervisor can retire', async t => {
  const f = await fixture(t); if (!f) return;
  await f.pane.write('exit\n');
  await until(async () => (await f.pane.status()).state === 'exited');
  await assert.rejects(f.pane.park(), /child_exited/);
  await assert.rejects(f.pane.resume(), /child_not_parked/);
  assert.equal((await f.pane.status()).childPid, f.identity.childPid);
});

test('lost direct-child parentage is unknown and cannot stop, resume, input or retire', async t => {
  if (!['darwin', 'linux'].includes(process.platform)) { t.skip('Python supervisor supports macOS and Linux'); return; }
  const script = fileURLToPath(new URL('../server/terminal/managed-pane-supervisor.py', import.meta.url));
  const injection = String.raw`
import importlib.util, sys
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('managed_pane_supervisor', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
subject = module.Supervisor.__new__(module.Supervisor)
subject.child = 424242
subject.child_state = 'running'
subject.exit_code = None
subject.relay_enabled = False
subject.input_epoch = 1
subject.output_offset = 0
subject.replay_dropped = 0
subject.output_gap_unknown = False
with patch.object(module.os, 'waitpid', side_effect=ChildProcessError):
    subject.poll_child()
assert subject.child_state == 'unknown'
assert subject.handle_request({'op':'status'})['reason'] == 'child_parentage_lost'
for op in ('park', 'resume', 'input', 'shutdown'):
    try:
        subject.handle_request({'op':op, 'data':''})
    except ValueError as error:
        assert str(error) == 'child_identity_unknown', (op, error)
    else:
        raise AssertionError(op + ' incorrectly succeeded')
`;
  execFileSync(pythonPath, ['-c', injection, script], { timeout: 5000, stdio: 'pipe' });
});

test('late park, resume or input replies freeze their old connection until fresh status', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seqivo-pane-protocol-'));
  const socketPath = join(root, 'control.sock'), capability = randomBytes(32).toString('hex');
  const seen = [];
  const server = createServer(socket => {
    let pending = '';
    socket.on('data', chunk => {
      pending += chunk.toString('utf8');
      for (let end; (end = pending.indexOf('\n')) >= 0;) {
        const frame = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
        if (frame.op === 'hello') {
          if (frame.capability !== capability) { socket.destroy(); return; }
          socket.write(JSON.stringify({ type: 'hello', supervisorPid: 123, childPid: 456, state: 'running' }) + '\n');
        } else if (frame.op === 'status') {
          socket.write(JSON.stringify({ type: 'reply', id: frame.id, ok: true,
            result: { state: 'running', supervisorPid: 123, childPid: 456 } }) + '\n');
        } else {
          seen.push(frame.op);
          setTimeout(() => { if (!socket.destroyed) socket.write(JSON.stringify({ type: 'reply', id: frame.id,
            ok: true, result: { accepted: true } }) + '\n'); }, 100);
        }
      }
    });
  });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(socketPath, resolve));
  for (const op of ['park', 'resume', 'input']) {
    const pane = await connectManagedPane({ socketPath, capability, requestTimeoutMs: 30 });
    await assert.rejects(op === 'input' ? pane.write('x') : pane[op](), /result unknown/);
    assert.equal(pane.closed, true);
    await assert.rejects(pane.write('must-not-send'), /connection closed/);
    const fresh = await connectManagedPane({ socketPath, capability });
    assert.equal((await fresh.status()).state, 'running');
    assert.equal(Object.keys(fresh).includes('capability'), false);
    assert.equal(inspect(fresh).includes(capability), false);
    fresh.close();
  }
  await sleep(120);
  assert.deepEqual(seen, ['park', 'resume', 'input'], 'no timed-out request or input is replayed');
});
