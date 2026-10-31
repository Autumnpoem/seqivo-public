import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { prepareManagedTmuxSession, reconnectManagedTmuxSession, startPreparedManagedTmuxSession, verifyManagedTmuxSession } from '../server/terminal/managed-pane-record.mjs';
import { connectManagedPane } from '../server/terminal/managed-pane.mjs';

const execFileAsync = promisify(execFile);
const pythonPath = process.env.TASKBOARD_TEST_PYTHON || '/usr/bin/python3';
const tmuxPath = process.env.TASKBOARD_TEST_TMUX || '.tools/terminal-build/install/bin/tmux';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(40);
  }
  throw new Error('Managed pane condition timed out');
}
async function setup(t) {
  if (!['darwin', 'linux'].includes(process.platform)) { t.skip('Exact native identities require macOS or Linux'); return null; }
  try { await access(pythonPath, constants.X_OK); await access(tmuxPath, constants.X_OK); }
  catch { t.skip('Python or isolated tmux executable unavailable'); return null; }
  const root = await mkdtemp(join(tmpdir(), 'seqivo-record-test-'));
  const records = join(root, 'records'), workspace = join(root, 'workspace');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(records, { mode: 0o700 }); await mkdir(workspace);
  const serverName = `seqivo_record_${randomBytes(6).toString('hex')}`;
  const config = { recordRoot: records, socketRoot: tmpdir(), pythonPath,
    shell: '/bin/sh', args: ['-i'], cwd: workspace, tmuxPath: await realpath(tmuxPath),
    serverName, name: 'record_a' };
  const run = args => execFileAsync(config.tmuxPath, ['-L', serverName, ...args], { timeout: 5000 });
  let subject, prepared;
  t.after(async () => {
    if (!subject && prepared) {
      const retained = JSON.parse(await readFile(prepared.recordPath, 'utf8').catch(() => '{}'));
      assert.notEqual(retained.status, 'unknown', 'Preserve unknown startup record and sockets for inspection');
    }
    if (subject) {
      try {
        let pane = subject.pane;
        if (pane.closed) pane = await connectManagedPane({ socketPath: pane.socketPath,
          capability: pane.capability, expectedIdentity: subject.shellIdentity });
        const state = await pane.status();
        if (state.state === 'stopped' || state.inputFrozen) await pane.resume();
        await run(['send-keys', '-t', subject.relayPaneId, 'exit', 'Enter']);
        await until(async () => (await pane.status()).state === 'exited', 3000);
        await pane.shutdown(); pane.close();
      } catch (error) {
        // Preserve the fixture for inspection if its authenticated controller
        // cannot confirm cleanup; never signal a stored PID alone.
        throw new Error('Managed record fixture cleanup was not confirmed', { cause: error });
      }
    }
    try { await run(['kill-server']); } catch {}
    if (prepared) {
      const record = JSON.parse(await readFile(prepared.recordPath, 'utf8').catch(() => '{}'));
      if (record.pane?.directory) await rm(record.pane.directory, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, records, workspace, config, run,
    get subject() { return subject; }, set subject(value) { subject = value; },
    get prepared() { return prepared; }, set prepared(value) { prepared = value; } };
}

test('prepare persists private capability before startup and uncertain start cannot create a second shell', async t => {
  const f = await setup(t); if (!f) return;
  f.prepared = await prepareManagedTmuxSession(f.config);
  const record = JSON.parse(await readFile(f.prepared.recordPath, 'utf8'));
  assert.equal(record.status, 'prepared');
  assert.equal(record.version, process.platform === 'linux' ? 2 : 1);
  if (process.platform === 'linux') assert.equal(record.identityKind, 'linux-proc');
  assert.equal(Object.hasOwn(f.prepared, 'capability'), false);
  assert.equal(JSON.stringify(f.prepared).includes(record.pane.capability), false);
  assert.equal(JSON.stringify(f.prepared).includes(f.prepared.recordPath), false);
  assert.equal((await lstat(dirname(f.prepared.recordPath))).mode & 0o777, 0o700);
  assert.equal((await lstat(f.prepared.recordPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(record.pane.relayTokenFile)).mode & 0o777, 0o600);
  await assert.rejects(access(record.pane.socketPath), { code: 'ENOENT' });
  record.status = 'starting'; // Simulate a crash after durable intent, before a confirmed start.
  await writeFile(f.prepared.recordPath, JSON.stringify(record), { mode: 0o600 });
  await assert.rejects(startPreparedManagedTmuxSession({ recordRoot: f.records,
    recordPath: f.prepared.recordPath }), /already attempted/);
  await assert.rejects(access(record.pane.socketPath), { code: 'ENOENT' });
});

test('failed durable preparation starts no shell, and a long record root uses a separate short socket root', async t => {
  const f = await setup(t); if (!f) return;
  const blocked = join(f.root, 'not-a-directory');
  await writeFile(blocked, 'x');
  await assert.rejects(prepareManagedTmuxSession({ ...f.config, recordRoot: blocked }));
  const longRoot = join(f.root, 'records-' + 'x'.repeat(96));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(longRoot, { mode: 0o700 });
  f.prepared = await prepareManagedTmuxSession({ ...f.config, recordRoot: longRoot });
  const record = JSON.parse(await readFile(f.prepared.recordPath, 'utf8'));
  assert.ok(Buffer.byteLength(f.prepared.recordPath) > 100);
  assert.ok(Buffer.byteLength(record.pane.socketPath) < 100);
  assert.equal(record.status, 'prepared');
  await assert.rejects(access(record.pane.socketPath), { code: 'ENOENT' });
});

test('private record rejects changed capability, symlink and wrong expected root without starting shell', async t => {
  const f = await setup(t); if (!f) return;
  f.prepared = await prepareManagedTmuxSession(f.config);
  const record = JSON.parse(await readFile(f.prepared.recordPath, 'utf8'));
  await writeFile(record.pane.relayTokenFile, '0'.repeat(64), { mode: 0o600 });
  await assert.rejects(startPreparedManagedTmuxSession({ recordRoot: f.records,
    recordPath: f.prepared.recordPath }), /relay token changed/);
  await assert.rejects(access(record.pane.socketPath), { code: 'ENOENT' });
  await assert.rejects(reconnectManagedTmuxSession({ recordRoot: f.workspace,
    recordPath: f.prepared.recordPath }), /outside its expected root/);
  const data = await readFile(f.prepared.recordPath);
  await rm(f.prepared.recordPath);
  const target = join(f.root, 'record-copy.json');
  await writeFile(target, data, { mode: 0o600 });
  const { symlink } = await import('node:fs/promises');
  await symlink(target, f.prepared.recordPath);
  await assert.rejects(reconnectManagedTmuxSession({ recordRoot: f.records,
    recordPath: f.prepared.recordPath }), /record unreadable/);
});

test('real isolated tmux reconnect requires original exact process and pane identities', async t => {
  const f = await setup(t); if (!f) return;
  f.prepared = await prepareManagedTmuxSession(f.config);
  f.subject = await startPreparedManagedTmuxSession({ recordRoot: f.records,
    recordPath: f.prepared.recordPath });
  const originalPid = f.subject.shellIdentity.childPid;
  const record = JSON.parse(await readFile(f.prepared.recordPath, 'utf8'));
  assert.equal(record.status, 'started');
  assert.equal(Object.keys(f.subject.pane).includes('capability'), false);
  assert.equal(JSON.stringify(f.subject).includes(record.pane.capability), false);
  assert.equal(JSON.stringify(f.subject).includes(f.prepared.recordPath), false);
  f.subject.pane.close();
  let recovered;
  await until(async () => { try { recovered = await reconnectManagedTmuxSession({ recordRoot: f.records,
    recordPath: f.prepared.recordPath }); return true; } catch { return false; } });
  assert.equal(recovered.shellIdentity.childPid, originalPid);
  assert.equal((await recovered.pane.status()).inputFrozen, true);
  assert.equal(recovered.sessionRef.sessionId, f.subject.sessionRef.sessionId);
  f.subject = recovered;
  const marker = join(f.workspace, 'live-marker');
  await recovered.pane.resume();
  await f.run(['send-keys', '-t', recovered.relayPaneId, `touch ${marker}`, 'Enter']);
  await until(async () => { try { await access(marker); return true; } catch { return false; } });
  // A detached supervisor can be reparented across an app restart; its birth
  // and direct shell parentage, rather than its original PPID, are binding.
  const reparented = { ...record, identities: { ...record.identities,
    supervisor: { ...record.identities.supervisor, ppid: 1 } } };
  await writeFile(f.prepared.recordPath, JSON.stringify(reparented), { mode: 0o600 });
  recovered.pane.close();
  await until(async () => { try { f.subject = await reconnectManagedTmuxSession({ recordRoot: f.records,
    recordPath: f.prepared.recordPath }); return true; } catch { return false; } });
  f.subject.pane.close();
  await writeFile(f.prepared.recordPath, JSON.stringify({ ...record,
    pane: { ...record.pane, capability: '0'.repeat(64) } }), { mode: 0o600 });
  await assert.rejects(reconnectManagedTmuxSession({ recordRoot: f.records,
    recordPath: f.prepared.recordPath }), /original identity could not be confirmed/);
  await writeFile(f.prepared.recordPath, JSON.stringify(record), { mode: 0o600 });
  await until(async () => { try { f.subject = await reconnectManagedTmuxSession({ recordRoot: f.records,
    recordPath: f.prepared.recordPath }); return true; } catch { return false; } });
  const changedBirth = process.platform === 'linux'
    ? { startTicks: String(BigInt(record.identities.shell.startTicks) + 1n) }
    : { startUsec: record.identities.shell.startUsec + 1 };
  const corrupt = { ...record, identities: { ...record.identities,
    shell: { ...record.identities.shell, ...changedBirth } } };
  await writeFile(f.prepared.recordPath, JSON.stringify(corrupt), { mode: 0o600 });
  f.subject.pane.close();
  await assert.rejects(reconnectManagedTmuxSession({ recordRoot: f.records,
    recordPath: f.prepared.recordPath }), /original identity could not be confirmed/);
  assert.equal(f.subject.shellIdentity.childPid, originalPid);
});

test('Linux durable record reconnects in a new controller process without starting a second shell',
  { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
    const f = await setup(t); if (!f) return;
    f.prepared = await prepareManagedTmuxSession(f.config);
    const coordinates = { recordRoot: f.records, recordPath: f.prepared.recordPath };
    f.subject = await startPreparedManagedTmuxSession(coordinates);
    const original = JSON.parse(await readFile(f.prepared.recordPath, 'utf8'));
    assert.equal(original.version, 2);
    for (const identity of Object.values(original.identities)) {
      assert.equal(identity.kind, 'linux-proc');
      assert.match(identity.startTicks, /^(0|[1-9][0-9]*)$/);
      assert.equal(Object.hasOwn(identity, 'startSec'), false);
    }
    f.subject.pane.close();
    await sleep(80);
    const childFile = fileURLToPath(new URL('./fixtures/managed-record-controller.mjs', import.meta.url));
    const child = await execFileAsync(process.execPath, [childFile, JSON.stringify(coordinates)],
      { timeout: 15000, maxBuffer: 16384 });
    assert.equal(child.stderr, '');
    const receipt = JSON.parse(child.stdout);
    assert.deepEqual(receipt.identities, original.identities);
    assert.equal(receipt.sessionId, original.tmux.sessionRef.sessionId);
    assert.equal(receipt.inputInitiallyFrozen, true);
    const marker = join(f.workspace, 'cross-process-marker');
    await until(async () => { try { return await readFile(marker, 'utf8') === 'once\n'; } catch { return false; } });
    await until(async () => { try { f.subject = await reconnectManagedTmuxSession(coordinates); return true; } catch { return false; } });
    assert.deepEqual(f.subject.identities, original.identities);
    await verifyManagedTmuxSession(coordinates);
    await assert.rejects(startPreparedManagedTmuxSession(coordinates), /already attempted/);
    assert.equal(await readFile(marker, 'utf8'), 'once\n');
    const mutations = [
      { ...original, version: 1, identityKind: undefined },
      { ...original, identities: { ...original.identities, shell: { ...original.identities.shell,
        bootId: original.identities.shell.bootId === '00000000-0000-0000-0000-000000000000'
          ? '11111111-1111-1111-1111-111111111111' : '00000000-0000-0000-0000-000000000000' } } },
      { ...original, identities: { ...original.identities, relay: { ...original.identities.relay,
        euid: original.identities.relay.euid + 1 } } },
    ];
    try {
      for (const changed of mutations) {
        await writeFile(f.prepared.recordPath, JSON.stringify(changed), { mode: 0o600 });
        await assert.rejects(verifyManagedTmuxSession(coordinates), { code: 'MANAGED_PANE_UNKNOWN' });
      }
    } finally {
      await writeFile(f.prepared.recordPath, JSON.stringify(original), { mode: 0o600 });
    }
    await verifyManagedTmuxSession(coordinates);
    assert.equal(await readFile(marker, 'utf8'), 'once\n');
  });
