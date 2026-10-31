import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeProcessTable } from '../server/codex-process-proof.mjs';

const helper = fileURLToPath(new URL('../plugins/codex-autocontinue/process_snapshot.py', import.meta.url));
const bulkDiagnostic = fileURLToPath(new URL('./fixtures/process-snapshot-bulk-diagnostic.py', import.meta.url));
const python = process.env.TASKBOARD_TEST_PYTHON || 'python3';

function runSnapshot(extra = []) {
  const result = spawnSync(python, [helper, ...extra], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.ok(result.stdout, result.stderr);
  return { status: result.status, data: JSON.parse(result.stdout) };
}

function longProcess() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  assert.ok(Number.isInteger(child.pid) && child.pid > 0);
  return child;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit');
  child.kill('SIGTERM');
  await ended;
}

const darwin = process.platform === 'darwin';
const nativeSchema = process.platform === 'linux' ? 2 : 1;
const nativeScope = `${process.platform === 'linux' ? 'linux' : 'macos'}-all-visible-exact-births-two-observed-enumerations`;
const birthFields = (seconds, micros) => process.platform === 'linux'
  ? { kind: 'linux-proc', bootId: '12345678-1234-1234-1234-123456789abc', startTicks: String(seconds * 1000000 + micros) }
  : { startSec: seconds, startUsec: micros };
// The simulated helper is an extensionless POSIX executable with a shebang and geteuid.
const posixStubOnly = { skip: process.platform === 'win32' && 'POSIX executable helper stub' };

async function sequencedNativeStub(t, steps) {
  const dir = await mkdtemp(join(tmpdir(), 'seqivo-native-sequence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = join(dir, 'helper-stub.cjs');
  const counter = join(dir, 'calls');
  await writeFile(counter, '0');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const counter = ${JSON.stringify(counter)};
const steps = ${JSON.stringify(steps)};
const index = Number(fs.readFileSync(counter, 'utf8'));
fs.writeFileSync(counter, String(index + 1));
const step = steps[Math.min(index, steps.length - 1)];
if (step.delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, step.delayMs);
const uid = process.geteuid();
const result = step.type === 'valid' ? {
  schemaVersion: ${nativeSchema}, uid, verified: true, reason: null, observerPid: process.pid,
  ignoredObserverPid: process.pid, scope: ${JSON.stringify(nativeScope)},
  attempts: 2, rows: step.rows || []
} : {
  schemaVersion: ${nativeSchema}, uid: step.type === 'wrong_uid' ? uid + 1 : uid,
  verified: false, reason: step.type === 'permanent' ? 'unexpected_uid' : 'identity_set_changed',
  rows: step.type === 'partial' ? [{ pid: process.pid }] : []
};
process.stdout.write(step.type === 'malformed' ? '{' : JSON.stringify(result));
process.exit(step.type === 'valid' || step.type === 'malformed' ? 0 : 2);
`, { mode: 0o700 });
  return { executable, calls: async () => Number(await readFile(counter, 'utf8')) };
}

test('native process table retries one complete churn observation then keeps all verified rows', posixStubOnly, async t => {
  const live = { pid: 900000001, ppid: 1, pgid: 900000001,
    euid: process.geteuid(), ruid: process.geteuid(), ...birthFields(10, 11) };
  const oldBirth = { ...live, pid: 900000002, pgid: 900000002, ...birthFields(4, 11) };
  const reused = { ...oldBirth, ...birthFields(12, 11) };
  const stub = await sequencedNativeStub(t,
    [{ type: 'churn' }, { type: 'valid', rows: [live, reused] }]);
  const rows = await nativeProcessTable(stub.executable, 3000, { allVisible: true });
  assert.equal(await stub.calls(), 2);
  assert.deepEqual(rows.get(live.pid), live);
  assert.deepEqual(rows.get(reused.pid), reused);
  assert.notDeepEqual(rows.get(reused.pid), oldBirth, 'reused PID birth must remain visible to the caller');
});

test('native process table never treats repeated churn as an empty or verified table', posixStubOnly, async t => {
  const stub = await sequencedNativeStub(t, [{ type: 'churn' }, { type: 'churn' }]);
  await assert.rejects(nativeProcessTable(stub.executable, 3000, { allVisible: true }),
    { message: 'Native process snapshot is unconfirmed: identity_set_changed' });
  assert.equal(await stub.calls(), 2);
});

test('native process table leaves churn retry to a caller that owns its retry loop', posixStubOnly, async t => {
  const stub = await sequencedNativeStub(t, [{ type: 'churn' }, { type: 'valid' }]);
  await assert.rejects(nativeProcessTable(stub.executable, 3000,
    { allVisible: true, retryIdentityChurn: false }),
  { message: 'Native process snapshot is unconfirmed: identity_set_changed' });
  assert.equal(await stub.calls(), 1);
});

test('native process table never retries permanent, partial, wrong-UID or malformed replies', posixStubOnly, async t => {
  for (const [type, message] of [
    ['permanent', 'Native process snapshot is unconfirmed: unexpected_uid'],
    ['partial', 'Unverified native process snapshot'],
    ['wrong_uid', 'Unverified native process snapshot'],
    ['malformed', 'Malformed native process snapshot'],
  ]) {
    const stub = await sequencedNativeStub(t, [{ type }, { type: 'valid' }]);
    await assert.rejects(nativeProcessTable(stub.executable, 3000, { allVisible: true }), { message });
    assert.equal(await stub.calls(), 1, `${type} must not trigger a second read`);
  }
});

test('native process table rejects a delayed second result within the original timeout', posixStubOnly, async t => {
  const row = { pid: 900000003, ppid: 1, pgid: 900000003,
    euid: process.geteuid(), ruid: process.geteuid(), ...birthFields(20, 0) };
  const stub = await sequencedNativeStub(t,
    [{ type: 'churn' }, { type: 'valid', rows: [row], delayMs: 3000 }]);
  const started = performance.now();
  await assert.rejects(nativeProcessTable(stub.executable, 2500, { allVisible: true }),
    /Native process snapshot command failed|Native process snapshot deadline exceeded/);
  assert.equal(await stub.calls(), 2);
  assert.ok(performance.now() - started < 3200, 'the second read must not receive a fresh timeout');
});

test('bulk current-UID snapshots keep two complete samples and fail closed on malformed kernel rows', { skip: !darwin }, () => {
  const result = spawnSync(python, [bulkDiagnostic, helper], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /bulk-current-uid-fail-closed: passed/);
});

test('macOS snapshot reports only current-UID stable process identities with a verified ABI', { skip: !darwin }, async () => {
  const a = longProcess();
  const b = longProcess();
  try {
    const first = runSnapshot();
    assert.equal(first.status, 0);
    const data = first.data;
    assert.equal(data.schemaVersion, 1);
    assert.equal(data.verified, true);
    assert.equal(data.reason, null);
    assert.ok(data.attempts >= 2);
    assert.equal(data.uid, process.geteuid());
    assert.equal(data.ignoredObserverPid, data.observerPid);
    assert.equal(data.rows.some(row => row.pid === data.observerPid), false);
    assert.equal(new Set(data.rows.map(row => row.pid)).size, data.rows.length);
    for (const pid of [a.pid, b.pid]) {
      const row = data.rows.find(item => item.pid === pid);
      assert.ok(row, `missing controlled PID ${pid}`);
      assert.deepEqual(Object.keys(row).sort(), ['euid', 'pgid', 'pid', 'ppid', 'ruid', 'startSec', 'startUsec'].sort());
      assert.equal(row.euid, data.uid);
      assert.equal(row.ppid, process.pid);
      assert.ok(row.pgid > 0);
      assert.ok(row.startSec > 0);
      assert.ok(row.startUsec >= 0 && row.startUsec < 1000000);
    }
    await stop(a);
    const second = runSnapshot();
    assert.equal(second.status, 0);
    assert.equal(second.data.rows.some(row => row.pid === a.pid), false);
    assert.equal(second.data.rows.some(row => row.pid === b.pid), true);
  } finally {
    await stop(a);
    await stop(b);
  }
});

test('a process exited before observation is absent while an unrelated long process remains', { skip: !darwin }, async () => {
  const b = longProcess();
  try {
    const short = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' });
    assert.equal(short.status, 0);
    const { status, data } = runSnapshot();
    assert.equal(status, 0);
    assert.equal(data.rows.some(row => row.pid === short.pid), false);
    assert.equal(data.rows.some(row => row.pid === b.pid), true);
  } finally { await stop(b); }
});

test('wrong expected UID fails closed without exposing process rows', { skip: !darwin }, () => {
  const { status, data } = runSnapshot(['--expected-uid', String(process.geteuid() + 1)]);
  assert.equal(status, 2);
  assert.equal(data.verified, false);
  assert.equal(data.reason, 'unexpected_uid');
  assert.deepEqual(data.rows, []);
});

test('all-visible mode provides exact foreign-UID births without weakening current-user mode', { skip: !darwin }, () => {
  const { status, data } = runSnapshot(['--all-visible']);
  assert.equal(status, 0, data.reason);
  assert.equal(data.verified, true);
  assert.equal(data.scope, 'macos-all-visible-exact-births-two-observed-enumerations');
  const launchd = data.rows.find(row => row.pid === 1);
  assert.ok(launchd);
  assert.equal(launchd.euid, 0);
  assert.ok(launchd.startSec > 0);
  assert.ok(launchd.startUsec >= 0 && launchd.startUsec < 1000000);
  const own = data.rows.find(row => row.pid === process.pid);
  assert.equal(own.euid, process.geteuid());
  assert.deepEqual(Object.keys(own).sort(), ['euid', 'pgid', 'pid', 'ppid', 'ruid', 'startSec', 'startUsec'].sort());
});

test('incomplete native snapshot preserves bounded reason and never becomes a usable table', { skip: !darwin }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'seqivo-native-failure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stub = join(dir, 'helper-stub');
  async function script(reason, rows = []) {
    const result = { schemaVersion: 1, uid: process.geteuid(), verified: false, reason, rows };
    await writeFile(stub, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(result))});process.exit(2);\n`, { mode: 0o700 });
  }
  await script('identity_set_changed');
  await assert.rejects(nativeProcessTable(stub, 1000, { allVisible: true }),
    { message: 'Native process snapshot is unconfirmed: identity_set_changed' });
  await script('identity_set_changed', [{ pid: process.pid }]);
  await assert.rejects(nativeProcessTable(stub, 1000, { allVisible: true }),
    { message: 'Unverified native process snapshot' });
  await script('/private/path-or-secret-must-not-be-surfaced');
  await assert.rejects(nativeProcessTable(stub, 1000, { allVisible: true }),
    { message: 'Unverified native process snapshot' });
});
