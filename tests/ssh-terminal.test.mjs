import { sshServer } from './helpers/ssh-server.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import ssh2 from 'ssh2';
const { utils } = ssh2;
import { WebSocket } from 'ws';
import { createSshStore } from '../server/ssh/store.mjs';
import { createSshSession } from '../server/ssh/session.mjs';
import { resolveSshTarget } from '../server/ssh/network.mjs';
import { createHub } from '../server/hub/http.mjs';

const hostInput = extra => ({ name: 'Test SSH', host: '127.0.0.1', port: 22, username: 'tester',
  kind: 'server', authMethod: 'password', tmuxServer: 'default', ...extra });
async function until(check, label, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(20); }
  throw Error(`Timed out: ${label}`);
}
const temporaryDirectories = [];
after(async () => { for (const path of temporaryDirectories) await rm(path, { recursive: true, force: true }); });
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'seqivo-ssh-'));
  temporaryDirectories.push(path); return path;
}
function sessionHarness(t, store, host, secret, extra = {}) {
  const frames = [], owner = 'alice';
  const session = createSshSession({ store, owner, hostId: host.id, suppliedCredentials: secret,
    send: frame => frames.push(frame), validate: () => true, allowPrivateTargets: true, ...extra });
  t.after(() => session.close());
  return { session, frames, wait: (type, from = 0) => until(() => frames.slice(from).find(f => f.type === type), type) };
}

test('host library encrypts opt-in credentials, scopes owners and preserves default only for unchanged target', async t => {
  const dir = await directory(t), store = createSshStore(dir);
  const host = store.put('alice', hostInput({ rememberCredential: true, credentials: { password: 'NEVER_PLAINTEXT' } }));
  assert.equal(host.hasCredential, true); assert.equal(host.password, undefined); assert.equal(host.secret, undefined);
  assert.equal((await readFile(join(dir, 'ssh-hosts.json'), 'utf8')).includes('NEVER_PLAINTEXT'), false);
  assert.equal((await stat(join(dir, 'ssh-vault.key'))).mode & 0o777, 0o600);
  assert.deepEqual(store.list('bob'), []);
  assert.throws(() => store.get('bob', host.id), { code: 'SSH_HOST_NOT_FOUND' });
  assert.equal(createSshStore(dir).credential('alice', host.id).password, 'NEVER_PLAINTEXT');
  const pinned = store.pin('alice', host.id, 'SHA256:test', host.revision);
  const def = store.setDefault('alice', host.id, { id: '$1', server: 'old', name: 'A' }, pinned.revision);
  assert.throws(() => store.put('alice', { ...def, expectedRevision: 1 }, host.id), { code: 'SSH_CONFLICT' });
  const changed = store.put('alice', { ...def, expectedRevision: def.revision, host: 'example.com' }, host.id);
  assert.equal(changed.hasCredential, false); assert.equal(changed.defaultSession, null); assert.equal(changed.fingerprint, null);
  store.delete('alice', host.id, changed.revision); assert.deepEqual(store.list('alice'), []);
});

test('Hub network policy rejects local and metadata addresses; local desktop may reach LAN', async () => {
  for (const host of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1'])
    await assert.rejects(resolveSshTarget(host), { code: 'SSH_NETWORK_DENIED' });
  assert.equal(await resolveSshTarget('127.0.0.1', true), '127.0.0.1');
  // Literal resolution makes no network request. Include positive cases: a
  // mixed-family BlockList would silently reject every public IPv4 address.
  assert.equal(await resolveSshTarget('8.8.8.8'), '8.8.8.8');
  assert.equal(await resolveSshTarget('2001:4860:4860::8888'), '2001:4860:4860::8888');
  for (const host of ['100.64.0.1', '172.16.0.1', '192.168.1.1', '::ffff:8.8.8.8', 'fc00::1', '64:ff9b::a00:1'])
    await assert.rejects(resolveSshTarget(host), { code: 'SSH_NETWORK_DENIED' });
});

test('SSH verifies first and changed host keys before password authentication; no silent trust', async t => {
  const dir = await directory(t), remote = await sshServer(t, { cwd: dir });
  const store = createSshStore(join(dir, 'vault'));
  let host = store.put('alice', hostInput({ port: remote.port }));
  const h = sessionHarness(t, store, host, { password: 'only-test-password' });
  const started = h.session.start(), challenge = await h.wait('hostKey');
  assert.equal(remote.auth.length, 0, 'Must not send credentials before host confirmation');
  await h.session.frame({ type: 'trust', challenge: challenge.challenge, fingerprint: challenge.fingerprint, approve: true });
  await started; assert.ok(remote.auth.includes('password'));
  h.session.close();
  host = store.get('alice', host.id);
  store.pin('alice', host.id, 'SHA256:different', host.revision);
  const changed = sessionHarness(t, store, store.get('alice', host.id), { password: 'only-test-password' });
  const before = remote.auth.length, nextStart = changed.session.start(), next = await changed.wait('hostKey');
  assert.equal(next.changed, true); assert.equal(remote.auth.length, before);
  await assert.rejects(changed.session.frame({ type: 'trust', challenge: next.challenge, fingerprint: next.fingerprint, approve: true }), { code: 'SSH_HOST_KEY' });
  changed.session.close(); await nextStart;
});

test('private-key with passphrase and jump host authenticate over real SSH transports', async t => {
  const dir = await directory(t);
  const privateKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'sec1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'fixture-passphrase' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const parsed = utils.parseKey(privateKey, 'fixture-passphrase');
  assert.ok(!(parsed instanceof Error));
  const remote = await sshServer(t, { cwd: dir, authKey: parsed });
  const jump = await sshServer(t, { cwd: dir });
  const store = createSshStore(join(dir, 'vault'));
  const bridge = store.put('alice', hostInput({ port: jump.port }));
  const host = store.put('alice', hostInput({ port: remote.port, authMethod: 'key', jumpHostId: bridge.id }));
  const h = sessionHarness(t, store, host, { privateKey, passphrase: 'fixture-passphrase' },
    { jumpCredentials: { password: 'only-test-password' } });
  const started = h.session.start();
  for (let i = 0; i < 2; i++) {
    const challenge = await until(() => h.frames.filter(f => f.type === 'hostKey')[i], 'jump/target fingerprint');
    await h.session.frame({ type: 'trust', challenge: challenge.challenge, fingerprint: challenge.fingerprint, approve: true });
  }
  await started;
  assert.ok(h.frames.some(f => f.type === 'connected'));
  assert.ok(jump.auth.includes('password')); assert.ok(remote.auth.includes('publickey'));
});

test('ordinary SSH remains usable when tmux is absent or the target has a non-POSIX login shell', async t => {
  for (const failure of [{ code: 127, message: 'tmux: command not found' },
    { code: 1, message: "'tmux' is not recognized as an internal or external command." }]) {
    const dir = await directory(), remote = await sshServer(t, { cwd: dir, tmuxFailure: failure });
    const store = createSshStore(join(dir, 'vault'));
    const host = store.put('alice', hostInput({ port: remote.port }));
    const h = sessionHarness(t, store, host, { password: 'only-test-password' });
    const started = h.session.start(), challenge = await h.wait('hostKey');
    await h.session.frame({ type: 'trust', challenge: challenge.challenge, fingerprint: challenge.fingerprint, approve: true });
    await started;
    assert.equal(h.frames.findLast(f => f.type === 'sessions').available, false);
    await h.session.frame({ type: 'shell' });
    const ready = h.frames.findLast(f => f.type === 'ready');
    assert.equal(ready.mode, 'shell');
    await h.session.frame({ type: 'input', generation: ready.generation, sequence: 1, data: "printf 'SHELL_OK\\n' > plain.txt\r" });
    await until(async () => await readFile(join(dir, 'plain.txt'), 'utf8').catch(() => '') === 'SHELL_OK\n', 'plain Shell writes a real file');
    const fresh = store.get('alice', host.id);
    store.put('alice', { ...fresh, expectedRevision: fresh.revision, name: 'Edited elsewhere' }, fresh.id);
    await assert.rejects(h.session.frame({ type: 'input', generation: ready.generation, sequence: 2, data: 'NOT_SENT\r' }), { code: 'SSH_CONFLICT' });
    h.session.close();
  }
});

test('wrong password fails without automatic retries or opening a command channel', async t => {
  const dir = await directory(), remote = await sshServer(t, { cwd: dir });
  const store = createSshStore(join(dir, 'vault'));
  const host = store.put('alice', hostInput({ port: remote.port }));
  const h = sessionHarness(t, store, host, { password: 'WRONG_PASSWORD' });
  const started = h.session.start(), challenge = await h.wait('hostKey');
  await h.session.frame({ type: 'trust', challenge: challenge.challenge, fingerprint: challenge.fingerprint, approve: true });
  await started;
  assert.equal(h.frames.find(f => f.type === 'error').code, 'SSH_AUTH_FAILED');
  assert.equal(remote.auth.filter(method => method === 'password').length, 1);
  assert.deepEqual(remote.commands, []);
});

test('real SSH and real tmux preserve A/B, default selection, file input and reject old channel input', {
  skip: !process.env.TMUX_TEST_EXECUTABLE,
}, async t => {
  const dir = await directory(t), executable = process.env.TMUX_TEST_EXECUTABLE;
  const serverName = `ssh-test-${process.pid}-${randomBytes(5).toString('hex')}`;
  t.after(() => { try { execFileSync(executable, ['-L', serverName, 'kill-server'], { stdio: 'ignore', timeout: 3000 }); } catch {} });
  const remote = await sshServer(t, { cwd: dir, executable, serverName });
  const store = createSshStore(join(dir, 'vault'));
  const host = store.put('alice', hostInput({ port: remote.port, tmuxServer: serverName }));
  const h = sessionHarness(t, store, host, { password: 'only-test-password' });
  const started = h.session.start(), challenge = await h.wait('hostKey');
  await h.session.frame({ type: 'trust', challenge: challenge.challenge, fingerprint: challenge.fingerprint, approve: true });
  await started;
  assert.equal(h.frames.find(f => f.type === 'sessions').available, true);
  await h.session.frame({ type: 'create', name: 'A' });
  const a = h.frames.findLast(f => f.type === 'ready');
  await h.session.frame({ type: 'input', generation: a.generation, sequence: 1, data: "printf 'A_ONCE\\n' >> ssh-a.txt\r" });
  await until(async () => await readFile(join(dir, 'ssh-a.txt'), 'utf8').catch(() => '') === 'A_ONCE\n', 'A real file');
  await h.session.frame({ type: 'default', session: a.session });
  await h.session.frame({ type: 'create', name: 'B' });
  const b = h.frames.findLast(f => f.type === 'ready');
  await h.session.frame({ type: 'resize', rows: 30, cols: 100 });
  await assert.rejects(h.session.frame({ type: 'input', generation: a.generation, sequence: 2, data: 'WRONG_TARGET\r' }), { code: 'SSH_INPUT_STALE' });
  await h.session.frame({ type: 'input', generation: b.generation, sequence: 1, data: "printf 'B_ONCE\\n' >> ssh-b.txt\r" });
  await until(async () => await readFile(join(dir, 'ssh-b.txt'), 'utf8').catch(() => '') === 'B_ONCE\n', 'B real file');
  assert.equal(store.get('alice', host.id).defaultSession.name, 'A');
  h.session.close();
  const reopened = sessionHarness(t, store, store.get('alice', host.id), { password: 'only-test-password' });
  await reopened.session.start();
  assert.equal(reopened.frames.findLast(f => f.type === 'ready').session.name, 'A');
  assert.equal(reopened.frames.filter(f => f.type === 'hostKey').length, 0);
  await reopened.session.frame({ type: 'default', session: b.session });
  reopened.session.close();
  const secondDevice = sessionHarness(t, store, store.get('alice', host.id), { password: 'only-test-password' });
  await secondDevice.session.start();
  assert.equal(secondDevice.frames.findLast(f => f.type === 'ready').session.name, 'B');
  assert.equal(await readFile(join(dir, 'ssh-a.txt'), 'utf8'), 'A_ONCE\n');
  assert.equal(await readFile(join(dir, 'ssh-b.txt'), 'utf8'), 'B_ONCE\n');
  secondDevice.session.close();
  execFileSync(executable, ['-L', serverName, 'kill-session', '-t', b.session.id]);
  const stale = sessionHarness(t, store, store.get('alice', host.id), { password: 'only-test-password' });
  await stale.session.start();
  assert.equal(stale.frames.some(f => f.type === 'ready'), false);
  assert.ok(stale.frames.some(f => f.type === 'notice'));
});

test('real SSH recovery returns exact current B, while manual connect uses A and replaced B never falls back', {
  skip: !process.env.TMUX_TEST_EXECUTABLE,
}, async t => {
  const dir = await directory(t), executable = process.env.TMUX_TEST_EXECUTABLE;
  const serverName = `ssh-recover-${process.pid}-${randomBytes(5).toString('hex')}`;
  t.after(() => { try { execFileSync(executable, ['-L', serverName, 'kill-server'], { stdio: 'ignore', timeout: 3000 }); } catch {} });
  const remote = await sshServer(t, { cwd: dir, executable, serverName });
  const store = createSshStore(join(dir, 'vault'));
  const host = store.put('alice', hostInput({ port: remote.port, tmuxServer: serverName }));
  const first = sessionHarness(t, store, host, { password: 'only-test-password' });
  const started = first.session.start(), challenge = await first.wait('hostKey');
  await first.session.frame({ type: 'trust', challenge: challenge.challenge, fingerprint: challenge.fingerprint, approve: true });
  await started;
  await first.session.frame({ type: 'create', name: 'A' });
  const a = first.frames.findLast(frame => frame.type === 'ready');
  await first.session.frame({ type: 'default', session: a.session });
  await first.session.frame({ type: 'create', name: 'B' });
  const b = first.frames.findLast(frame => frame.type === 'ready');
  const revision = store.get('alice', host.id).revision;
  assert.ok(first.frames.findLast(frame => frame.type === 'sessions').hostRevision === revision);
  first.session.close();

  const recovered = sessionHarness(t, store, host, { password: 'only-test-password' },
    { recoverSession: b.session, expectedHostRevision: revision });
  await recovered.session.start();
  const reopened = recovered.frames.filter(frame => frame.type === 'ready');
  assert.equal(reopened.length, 1);
  assert.deepEqual(reopened[0].session, b.session);
  await assert.rejects(recovered.session.frame({ type: 'input', generation: a.generation, sequence: 1, data: 'WRONG\r' }),
    { code: 'SSH_INPUT_STALE' });
  await recovered.session.frame({ type: 'input', generation: reopened[0].generation, sequence: 1,
    data: "printf 'RECOVERED_B\\n' >> recovered-b.txt\r" });
  await until(async () => await readFile(join(dir, 'recovered-b.txt'), 'utf8').catch(() => '') === 'RECOVERED_B\n', 'recovered B input');
  recovered.session.close();

  const manual = sessionHarness(t, store, host, { password: 'only-test-password' });
  await manual.session.start();
  assert.deepEqual(manual.frames.filter(frame => frame.type === 'ready').map(frame => frame.session), [a.session]);
  manual.session.close();

  execFileSync(executable, ['-L', serverName, 'kill-session', '-t', b.session.id]);
  execFileSync(executable, ['-L', serverName, 'new-session', '-d', '-s', 'B']);
  const stale = sessionHarness(t, store, host, { password: 'only-test-password' },
    { recoverSession: b.session, expectedHostRevision: revision });
  await stale.session.start();
  assert.equal(stale.frames.some(frame => frame.type === 'ready'), false);
  assert.ok(stale.frames.some(frame => frame.type === 'notice'));
  assert.deepEqual(stale.frames.find(frame => frame.type === 'recoverySettled'),
    { type: 'recoverySettled', outcome: 'missing', session: b.session });
  assert.equal(await readFile(join(dir, 'recovered-b.txt'), 'utf8'), 'RECOVERED_B\n');
  stale.session.close();

  store.setDefault('alice', host.id, a.session, revision);
  assert.throws(() => sessionHarness(t, store, host, { password: 'only-test-password' },
    { recoverSession: b.session, expectedHostRevision: revision }), { code: 'SSH_CONFLICT' });
});

test('real SSH seals old input before create and a delayed tmux selection, then accepts only new generations', {
  skip: !process.env.TMUX_TEST_EXECUTABLE,
}, async t => {
  const dir = await directory(), executable = process.env.TMUX_TEST_EXECUTABLE;
  const serverName = `ssh-switch-${process.pid}-${randomBytes(5).toString('hex')}`;
  const gate = join(dir, 'hold-list'), entered = join(dir, 'list-entered');
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const wrapper = join(dir, 'tmux');
  await writeFile(wrapper, `#!/bin/sh\nif [ "$3" = list-sessions ] && [ -f ${shellQuote(gate)} ]; then\n  : > ${shellQuote(entered)}\n  while [ -f ${shellQuote(gate)} ]; do sleep 0.02; done\nfi\nexec ${shellQuote(executable)} "$@"\n`, { mode: 0o755 });
  t.after(async () => {
    await rm(gate, { force: true });
    try { execFileSync(executable, ['-L', serverName, 'kill-server'], { stdio: 'ignore', timeout: 3000 }); } catch {}
  });
  const remote = await sshServer(t, { cwd: dir, executable: wrapper, serverName });
  const store = createSshStore(join(dir, 'vault'));
  const host = store.put('alice', hostInput({ port: remote.port, tmuxServer: serverName }));
  const h = sessionHarness(t, store, host, { password: 'only-test-password' });
  const started = h.session.start(), challenge = await h.wait('hostKey');
  await h.session.frame({ type: 'trust', challenge: challenge.challenge, fingerprint: challenge.fingerprint, approve: true });
  await started;
  await h.session.frame({ type: 'create', name: 'A' });
  const a = h.frames.findLast(f => f.type === 'ready');
  await h.session.frame({ type: 'list' });
  await h.session.frame({ type: 'default', session: a.session });
  await h.session.frame({ type: 'input', generation: a.generation, sequence: 1, data: "printf 'A_OK\\n' > a-ok.txt\r" });
  await until(async () => await readFile(join(dir, 'a-ok.txt'), 'utf8').catch(() => '') === 'A_OK\n', 'A input after list/default');

  const creating = h.session.frame({ type: 'create', name: 'B' });
  try {
    await assert.rejects(h.session.frame({ type: 'input', generation: a.generation, sequence: 2,
      data: "printf 'WRONG_A\\n' > wrong-a.txt\r" }), { code: 'SSH_INPUT_STALE' });
  } finally { await creating; }
  const b = h.frames.findLast(f => f.type === 'ready');
  assert.notEqual(b.generation, a.generation);
  await h.session.frame({ type: 'input', generation: b.generation, sequence: 1, data: "printf 'B_OK\\n' > b-ok.txt\r" });
  await until(async () => await readFile(join(dir, 'b-ok.txt'), 'utf8').catch(() => '') === 'B_OK\n', 'B input after create');

  await writeFile(gate, 'hold');
  const switching = h.session.frame({ type: 'select', session: a.session });
  try {
    await until(async () => Boolean(await stat(entered).catch(() => null)), 'tmux list barrier entered');
    await assert.rejects(h.session.frame({ type: 'input', generation: b.generation, sequence: 2,
      data: "printf 'WRONG_B\\n' > wrong-b.txt\r" }), { code: 'SSH_INPUT_STALE' });
  } finally { await rm(gate, { force: true }); await switching; }
  const returned = h.frames.findLast(f => f.type === 'ready');
  assert.notEqual(returned.generation, b.generation);
  assert.equal(returned.session.id, a.session.id);
  await h.session.frame({ type: 'input', generation: returned.generation, sequence: 1,
    data: "printf 'A_NEW\\n' > a-new.txt\r" });
  await until(async () => await readFile(join(dir, 'a-new.txt'), 'utf8').catch(() => '') === 'A_NEW\n', 'new generation input');
  assert.equal(await stat(join(dir, 'wrong-a.txt')).catch(() => null), null);
  assert.equal(await stat(join(dir, 'wrong-b.txt')).catch(() => null), null);
});

test('Hub requires account auth, isolates hosts and tickets, and revokes an open SSH connection on logout', async t => {
  const dir = await directory(t), remote = await sshServer(t, { cwd: dir,
    tmuxFailure: { code: 127, message: 'tmux: command not found' } });
  const hub = await createHub({ dataDir: join(dir, 'hub'), sshAllowPrivateTargets: true });
  t.after(() => hub.close());
  const alice = await hub.accounts.register({ username: 'ssh_alice', password: 'Only-For-Test-001', source: 'test' });
  const bob = await hub.accounts.register({ username: 'ssh_bob', password: 'Only-For-Test-002', source: 'test' });
  const api = (token, method, path, body) => fetch(hub.url + path, { method,
    headers: { Origin: hub.url, Cookie: `hub_session=${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const created = await api(alice.sessionToken, 'POST', '/api/ssh/hosts', hostInput({ port: remote.port }));
  assert.equal(created.status, 200); const host = await created.json();
  assert.equal((await (await api(bob.sessionToken, 'GET', '/api/ssh/hosts')).json()).hosts.length, 0);
  assert.equal((await api(bob.sessionToken, 'POST', '/api/ssh/tickets', { hostId: host.id })).status, 404);
  const noOrigin = await fetch(hub.url + '/api/ssh/hosts', { method: 'POST',
    headers: { Cookie: `hub_session=${alice.sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(hostInput({})) });
  assert.equal(noOrigin.status, 403);
  const ticket = await (await api(alice.sessionToken, 'POST', '/api/ssh/tickets',
    { hostId: host.id, credentials: { password: 'only-test-password' } })).json();
  async function rejectedTicket(token, value) {
    const rejected = new WebSocket(hub.url.replace('http', 'ws') + '/api/ssh/ws',
      { origin: hub.url, headers: { Cookie: `hub_session=${token}` } });
    t.after(() => rejected.terminate());
    const seen = []; rejected.on('message', raw => seen.push(JSON.parse(raw)));
    await new Promise(resolve => rejected.once('open', resolve));
    rejected.send(JSON.stringify({ v: 1, type: 'auth', ticket: value }));
    await until(() => rejected.readyState === WebSocket.CLOSED, 'wrong-account/replayed ticket rejected');
    assert.ok(seen.some(f => f.type === 'error'));
  }
  await rejectedTicket(bob.sessionToken, ticket.ticket);
  await rejectedTicket(alice.sessionToken, ticket.ticket);
  assert.equal(remote.auth.length, 0);
  const validTicket = await (await api(alice.sessionToken, 'POST', '/api/ssh/tickets',
    { hostId: host.id, credentials: { password: 'only-test-password' } })).json();
  const frames = [];
  const ws = new WebSocket(hub.url.replace('http', 'ws') + '/api/ssh/ws',
    { origin: hub.url, headers: { Cookie: `hub_session=${alice.sessionToken}` } });
  t.after(() => ws.terminate());
  ws.on('message', raw => {
    const f = JSON.parse(raw); frames.push(f);
    if (f.type === 'hostKey') ws.send(JSON.stringify({ v: 1, type: 'trust',
      challenge: f.challenge, fingerprint: f.fingerprint, approve: true }));
  });
  await new Promise(resolve => ws.once('open', resolve));
  ws.send(JSON.stringify({ v: 1, type: 'auth', ticket: validTicket.ticket }));
  await until(() => frames.find(f => f.type === 'connected'), 'SSH connected');
  const sessions = await until(() => frames.find(f => f.type === 'sessions'), 'SSH tmux-unavailable sessions');
  assert.equal(sessions.available, false);
  ws.send(JSON.stringify({ v: 1, type: 'shell' }));
  const ready = await until(() => frames.find(f => f.type === 'ready'), 'SSH shell ready');
  ws.send(JSON.stringify({ v: 1, type: 'input', generation: ready.generation, sequence: 1,
    data: "printf 'STARTED\\n' > revoked-started.txt; sleep 1; printf 'REVOKED_OUTPUT\\n' > revoked-output.txt; cat revoked-output.txt\r" }));
  await until(async () => await readFile(join(dir, 'revoked-started.txt'), 'utf8').catch(() => '') === 'STARTED\n', 'remote command started');
  const beforeLogout = frames.length;
  assert.equal((await api(alice.sessionToken, 'POST', '/api/auth/logout', {})).status, 200);
  await until(async () => await readFile(join(dir, 'revoked-output.txt'), 'utf8').catch(() => '') === 'REVOKED_OUTPUT\n', 'remote output after logout');
  await until(() => ws.readyState === WebSocket.CLOSED, 'revoked SSH closes', 6000);
  assert.equal(frames.slice(beforeLogout).some(f => f.type === 'output' && f.data.includes('REVOKED_OUTPUT')), false);
  assert.equal((await api(alice.sessionToken, 'GET', '/api/ssh/hosts')).status, 401);
});

test('local desktop SSH API is owner-only and the websocket coexists with the managed terminal route', async t => {
  const { createCore } = await import('../server/core.mjs');
  const { startHttp } = await import('../server/http.mjs');
  const dir = await directory(t);
  const core = await createCore({ dataDir: join(dir, 'core'), pluginDir: join(dir, 'empty-plugins'), files: false });
  const http = await startHttp({ core, dataDir: join(dir, 'core'), distDir: dir, port: 0 });
  t.after(async () => { await http.close(); await core.close(); });
  await assert.rejects(core.request('GET', '/api/ssh/hosts', {}, 'viewer'), { code: 'SSH_FORBIDDEN' });
  const remote = await sshServer(t, { cwd: dir });
  const host = await core.request('POST', '/api/ssh/hosts', hostInput({ port: remote.port }));
  const ticket = await core.request('POST', '/api/ssh/tickets', { hostId: host.id, credentials: { password: 'only-test-password' } });
  const ws = new WebSocket(ticket.websocketUrl, { origin: 'tauri://localhost' });
  t.after(() => ws.terminate());
  const frames = [];
  ws.on('message', raw => {
    const value = JSON.parse(raw); frames.push(value);
    if (value.type === 'hostKey') ws.send(JSON.stringify({ v: 1, type: 'trust',
      challenge: value.challenge, fingerprint: value.fingerprint, approve: true }));
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ v: 1, type: 'auth', ticket: ticket.ticket }));
  await until(() => frames.some(f => f.type === 'connected'), 'native IPC ticket to local SSH websocket');
  assert.equal((await core.request('GET', '/api/ssh/hosts')).hosts.length, 1);
  ws.close();
});
