import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { createCore } from '../server/core.mjs';
import { startHttp } from '../server/http.mjs';
import { createHub } from '../server/hub/http.mjs';
import { sshServer } from './helpers/ssh-server.mjs';

async function until(fn, label, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error(`Timeout: ${label}`);
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`Timeout: ${label}`)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

for (const mode of ['desktop', 'hub']) test(`${mode} shutdown closes active SSH and pending trust, preserves remote tmux and reconnects without replay`, {
  skip: !process.env.TMUX_TEST_EXECUTABLE,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'seqivo-ssh-close-'));
  const executable = process.env.TMUX_TEST_EXECUTABLE;
  const serverName = `ssh-close-${process.pid}-${randomBytes(6).toString('hex')}`;
  const command = (...args) => execFileSync(executable, ['-L', serverName, ...args],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  const remote = await sshServer(t, { cwd: root, executable, serverName });
  let core, http, hub, login, api, origin, passed = false;
  const sockets = [];
  const stages = [];
  const close = async () => {
    if (mode === 'desktop') { await http?.close(); await core?.close(); }
    else await hub?.close();
  };
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await close();
    try { command('kill-server'); } catch {}
    if (passed) await rm(root, { recursive: true, force: true });
    else t.diagnostic(`Failure evidence retained at ${root}`);
  });
  async function openGateway(first) {
    if (mode === 'desktop') {
      core = await createCore({ dataDir: join(root, 'core'), pluginDir: join(root, 'empty-plugins'),
        files: false, onShutdown: event => stages.push(event) });
      http = await startHttp({ core, dataDir: join(root, 'core'), distDir: root, port: 0 });
      origin = `http://127.0.0.1:${http.port}`;
      api = (method, path, body) => core.request(method, path, body);
    } else {
      hub = await createHub({ dataDir: join(root, 'hub'), sshAllowPrivateTargets: true });
      origin = hub.url;
      if (first) login = await hub.accounts.register({ username: 'close_fixture',
        password: 'Disposable-close-test-239', source: 'test' });
      api = async (method, path, body) => {
        const response = await fetch(origin + path, { method,
          headers: { Origin: origin, Cookie: `hub_session=${login.sessionToken}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}) });
        assert.equal(response.status, 200);
        return response.json();
      };
    }
  }
  async function attach(host, trust = true) {
    const ticket = await api('POST', '/api/ssh/tickets', { hostId: host.id,
      credentials: { password: 'only-test-password' } });
    const ws = new WebSocket(origin.replace(/^http/, 'ws') + '/api/ssh/ws',
      { origin, ...(mode === 'hub' ? { headers: { Cookie: `hub_session=${login.sessionToken}` } } : {}) });
    sockets.push(ws);
    const frames = [];
    const send = frame => ws.send(JSON.stringify({ v: 1, ...frame }));
    ws.on('message', raw => {
      const frame = JSON.parse(raw); frames.push(frame);
      if (trust && frame.type === 'hostKey') send({ type: 'trust',
        challenge: frame.challenge, fingerprint: frame.fingerprint, approve: true });
    });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    send({ type: 'auth', ticket: ticket.ticket });
    return { ws, frames, send, wait: (predicate, label) => until(() => frames.find(predicate), label) };
  }
  const hostInput = name => ({ name, host: '127.0.0.1', port: remote.port, username: 'tester',
    kind: 'server', authMethod: 'password', tmuxServer: serverName });
  await openGateway(true);
  const host = await api('POST', '/api/ssh/hosts', hostInput('Original'));
  const active = await attach(host);
  await active.wait(f => f.type === 'sessions', 'SSH session list');
  active.send({ type: 'create', name: 'kept' });
  const ready = await active.wait(f => f.type === 'ready', 'tmux ready');
  active.send({ type: 'input', generation: ready.generation, sequence: 1,
    data: "printf 'EXACTLY_ONCE\\n' >> preserved.txt\r" });
  await until(async () => (await readFile(join(root, 'preserved.txt'), 'utf8').catch(() => '')) === 'EXACTLY_ONCE\n', 'remote write');
  active.send({ type: 'default', session: ready.session });
  await active.wait(f => f.type === 'sessions' && f.defaultSession?.id === ready.session.id, 'saved default');
  const before = command('list-sessions', '-F', '#{pid}:#{start_time}:#{session_id}:#{session_name}');
  const waitingHost = await api('POST', '/api/ssh/hosts', hostInput('Unconfirmed'));
  const authCount = remote.auth.length;
  const pending = await attach(waitingHost, false);
  await pending.wait(f => f.type === 'hostKey', 'unconfirmed fingerprint');
  assert.equal(remote.auth.length, authCount, 'pending trust must not authenticate');
  await bounded(close(), 'gateway and Core shutdown');
  await until(() => [active.ws, pending.ws].every(ws => ws.readyState === WebSocket.CLOSED), 'WebSocket close');
  assert.equal(remote.auth.length, authCount, 'shutdown must not approve trust');
  assert.equal(command('list-sessions', '-F', '#{pid}:#{start_time}:#{session_id}:#{session_name}'), before);
  assert.equal(await readFile(join(root, 'preserved.txt'), 'utf8'), 'EXACTLY_ONCE\n');
  if (mode === 'desktop') assert.deepEqual(stages.filter(e => e.stage === 'ssh').map(e => e.status), ['started', 'fulfilled']);
  await openGateway(false);
  const reopened = await attach(host);
  const recovered = await reopened.wait(f => f.type === 'ready', 'default after reopening');
  assert.deepEqual(recovered.session, ready.session);
  assert.equal(reopened.frames.filter(f => f.type === 'hostKey').length, 0);
  assert.equal(command('list-sessions', '-F', '#{pid}:#{start_time}:#{session_id}:#{session_name}'), before);
  assert.equal(await readFile(join(root, 'preserved.txt'), 'utf8'), 'EXACTLY_ONCE\n');
  await bounded(close(), 'reopened gateway shutdown');
  passed = true;
});
