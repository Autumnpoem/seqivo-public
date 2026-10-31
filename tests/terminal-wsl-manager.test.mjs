import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createTerminalManager } from '../server/terminal/manager.mjs';

// The adapter is deliberately fake. Its /bin/cat attach target is a macOS host
// PTY fixture; these tests never invoke wsl.exe or inspect a Windows machine.
function fakeWsl() {
  const calls = [];
  const accounts = { Ubuntu: { user: 'alice', uid: 1000 }, Debian: { user: 'bob', uid: 1001 } };
  const sessions = new Map();
  const support = {
    discover: async () => ({ supported: true, available: true, distributions: Object.keys(accounts) }),
    configure: async ({ distro, cwd }) => {
      if (!accounts[distro]) throw Object.assign(new Error('unknown distro'), { code: 'DISTRO_UNAVAILABLE' });
      if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0'))
        throw Object.assign(new Error('invalid Linux cwd'), { code: 'INVALID_CWD' });
      return { distro, ...accounts[distro], cwd };
    },
    adapter: profile => {
      const key = `${profile.wsl.distro}:${profile.wsl.user}:${profile.wsl.uid}:${profile.serverName}`;
      const rows = () => sessions.get(key) ?? [];
      return {
        inspect: async () => ({ available: true, serverName: profile.serverName, instanceId: 'a'.repeat(64), serverPid: null }),
        list: async () => {
          calls.push({ op: 'list', key });
          return { available: true, serverName: profile.serverName, instanceId: 'a'.repeat(64), serverPid: null, sessions: rows() };
        },
        create: async ({ name, cwd }) => {
          calls.push({ op: 'create', key, name, cwd });
          const item = { name, windows: 1, attached: false,
            sessionRef: { serverName: profile.serverName, instanceId: 'a'.repeat(64), sessionId: `$${rows().length}` } };
          sessions.set(key, [...rows(), item]);
          return item;
        },
        attachTarget: async ({ sessionRef, readOnly = false }) => {
          calls.push({ op: 'attach', key, sessionRef, readOnly });
          if (!rows().some(item => item.sessionRef.sessionId === sessionRef?.sessionId))
            throw Object.assign(new Error('missing session'), { code: 'SESSION_MISSING' });
          return { command: '/bin/cat', args: [], env: process.env };
        },
      };
    },
  };
  return { support, calls, accounts };
}

async function fixture(t, wslSupport) {
  const dir = await mkdtemp(join(tmpdir(), 'terminal-wsl-manager-'));
  const store = new Store(join(dir, 'board.sqlite'));
  const manager = createTerminalManager({ store, wslSupport });
  t.after(async () => { await manager.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, manager };
}
const profile = (id = 'wsl', extra = {}) => ({ id, label: 'WSL', enabled: true, runtime: 'wsl',
  wslDistro: 'Ubuntu', wslCwd: '/home/alice/project with spaces', ...extra });
const ctx = (profileId, connectionId) => ({ local: true, profileId, connectionId });
const latest = (frames, type) => frames.filter(frame => frame.type === type).at(-1);
const open = { v: 1, type: 'open', mode: 'tmux', readOnly: false, cols: 80, rows: 24 };

test('missing WSL leaves native independent Shell usable; WSL validation and Hub projection stay scoped', async t => {
  const missing = { discover: async () => ({ supported: false, available: false, distributions: [] }),
    configure: async () => { throw Object.assign(new Error('WSL unavailable'), { code: 'CAPABILITY_UNAVAILABLE' }); },
    adapter: () => { throw new Error('unavailable adapter must not run'); } };
  const { dir, store, manager } = await fixture(t, missing);
  const project = store.project({ name: 'host project', directory: dir });
  await manager.request('POST', '/api/terminal/profiles', { id: 'native', label: 'Native', enabled: true,
    cwd: homedir(), shell: '/bin/sh' });
  const nativeFrames = [], native = ctx('native', 'native-shell');
  await manager.frame(native, { ...open, mode: 'shell' }, frame => nativeFrames.push(frame));
  assert.equal(latest(nativeFrames, 'ready')?.mode, 'shell', 'host Shell PTY still opens');
  await assert.rejects(manager.request('POST', '/api/terminal/profiles', profile()), { code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal((await manager.request('GET', '/api/terminal/status')).profiles.length, 1);
  assert.deepEqual(manager.profiles(), [{ id: 'native', label: 'Native' }]);
  assert.equal(manager.blocksProject(project.id), false);
  await manager.closeConnection(native.connectionId);
  const key = 'terminal.manager.v1';
  const state = JSON.parse(store.db.prepare('SELECT value FROM metadata WHERE key=?').get(key).value);
  state.defaults['local:local:native'] = { serverName: 'legacy', instanceId: 'a'.repeat(64), sessionId: '$0' };
  state.defaultRevisions['local:local:native'] = 3;
  store.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(state), key);
  const reloaded = createTerminalManager({ store, wslSupport: missing });
  await reloaded.bindOwner({ nodeId: 'bound-node', userId: 'bound-user' });
  const migrated = JSON.parse(store.db.prepare('SELECT value FROM metadata WHERE key=?').get(key).value);
  assert.deepEqual(migrated.defaults['bound-node:bound-user:native'], state.defaults['local:local:native'],
    'legacy native default key keeps its original unsuffixed identity');
  assert.equal(migrated.defaultRevisions['bound-node:bound-user:native'], 3);
  await reloaded.close();
});

test('WSL profile persists opaque target, uses exact Linux cwd, reconnects to default, and ignores host project freeze', async t => {
  const fake = fakeWsl();
  const { store, manager } = await fixture(t, fake.support);
  const project = store.project({ name: 'host project', directory: homedir() });
  await assert.rejects(manager.request('POST', '/api/terminal/profiles', profile('bad', { projectId: project.id })),
    { code: 'WSL_PROJECT_UNSUPPORTED' });
  await assert.rejects(manager.request('POST', '/api/terminal/profiles', profile('bad', { tmuxExecutable: '/bin/tmux' })),
    { code: 'WSL_INVALID_EXECUTABLE' });
  await assert.rejects(manager.request('POST', '/api/terminal/profiles', profile('bad', { wslCwd: 'C:\\Users\\alice' })),
    { code: 'INVALID_CWD' });
  const saved = await manager.request('POST', '/api/terminal/profiles', profile('wsl', { cwd: homedir() }));
  assert.deepEqual(saved.wsl, { distro: 'Ubuntu', user: 'alice', uid: 1000, cwd: '/home/alice/project with spaces' });
  assert.equal(saved.cwd, homedir(), 'host cwd is never taken from Linux path or caller');
  assert.deepEqual(manager.profiles(), [{ id: 'wsl', label: 'WSL', runtime: 'wsl' }]);
  assert.equal(JSON.stringify(manager.profiles()).includes('alice'), false);
  assert.equal(manager.blocksProject(project.id), false);
  const frames = [], first = ctx('wsl', 'wsl-first'), send = frame => frames.push(frame);
  await assert.rejects(manager.frame(first, { ...open, mode: 'shell' }, send), { code: 'WSL_TMUX_ONLY' });
  await manager.frame(first, open, send);
  assert.equal(latest(frames, 'sessions')?.items.length, 0);
  await manager.frame(first, { v: 1, type: 'create', epoch: 0, name: 'first' }, send);
  const ref = latest(frames, 'ready')?.sessionRef;
  assert.ok(ref);
  assert.deepEqual(fake.calls.find(call => call.op === 'create')?.cwd, '/home/alice/project with spaces');
  assert.ok(fake.calls.some(call => call.op === 'list' && call.key.startsWith('Ubuntu:alice:1000:')),
    'list stays bound to configured Linux account and server');
  await manager.frame(first, { v: 1, type: 'default', sessionRef: ref, expectedRevision: 0 }, send);
  assert.equal(latest(frames, 'sessions').defaultRevision, 1);
  await manager.frame(first, { v: 1, type: 'create', epoch: latest(frames, 'ready').epoch, name: 'temporary' }, send);
  assert.notDeepEqual(latest(frames, 'ready').sessionRef, ref, 'temporary selection attaches another session');
  const secondFrames = [], second = ctx('wsl', 'wsl-second');
  await manager.frame(second, open, frame => secondFrames.push(frame));
  assert.deepEqual(latest(secondFrames, 'ready')?.sessionRef, ref, 'new connection uses saved default');
  await manager.closeConnection(first.connectionId);
  const thirdFrames = [];
  await manager.frame(ctx('wsl', 'wsl-reconnect'), open, frame => thirdFrames.push(frame));
  assert.deepEqual(latest(thirdFrames, 'ready')?.sessionRef, ref, 'reconnect retains default rather than temporary session');
  await manager.sealProject(project.id);
  assert.equal((await manager.request('GET', '/api/terminal/status')).connections.find(c => c.id === second.connectionId)?.ready,
    true, 'host project freeze does not stop WSL PTY');
  assert.equal(manager.blocksProject(project.id), false);
  await manager.bindOwner({ nodeId: 'bound-node', userId: 'bound-user' });
  manager.setLink({ state: () => ({ nodeId: 'bound-node', ownerUserId: 'bound-user', status: 'connected' }),
    pending: async () => ({ devices: [] }), close: async () => {} });
  await manager.frame(second, { v: 1, type: 'list' }, frame => secondFrames.push(frame));
  assert.deepEqual(latest(secondFrames, 'sessions').defaultRef, ref, 'owner binding migrates WSL default');
  assert.equal(latest(secondFrames, 'sessions').defaultRevision, 1);
  for (const type of ['takeover', 'return'])
    await assert.rejects(manager.frame(second, { v: 1, type }, frame => secondFrames.push(frame)), { code: 'CONTROL_UNMANAGED' });
  const reloaded = createTerminalManager({ store, wslSupport: fake.support });
  t.after(() => reloaded.close());
  assert.deepEqual(reloaded.profiles(), [{ id: 'wsl', label: 'WSL', runtime: 'wsl' }]);
  assert.deepEqual((await reloaded.request('GET', '/api/terminal/status')).profiles[0].wsl, saved.wsl);
});

test('changing a WSL target or native runtime rejects before retiring live connection or old device grant', async t => {
  const fake = fakeWsl();
  const { manager } = await fixture(t, fake.support);
  await manager.request('POST', '/api/terminal/profiles', profile());
  const link = { state: () => ({ nodeId: 'bound-node', ownerUserId: 'bound-user', status: 'connected' }),
    pending: async () => ({ devices: [{ deviceId: 'phone', userId: 'bound-user' }] }),
    grant: async () => ({ revision: 7 }), refresh: () => {}, close: async () => {} };
  manager.setLink(link);
  await manager.request('POST', '/api/terminal/grants', { profileId: 'wsl', deviceId: 'phone', scopes: ['view', 'input'] });
  const frames = [], connection = ctx('wsl', 'live-wsl');
  await manager.frame(connection, open, frame => frames.push(frame));
  await manager.frame(connection, { v: 1, type: 'create', epoch: 0, name: 'live' }, frame => frames.push(frame));
  const original = (await manager.request('GET', '/api/terminal/status'));
  for (const change of [
    { runtime: 'native' },
    { wslDistro: 'Debian' },
  ]) await assert.rejects(manager.request('POST', '/api/terminal/profiles', profile('wsl', change)),
    { code: 'PROFILE_TARGET_CHANGED' });
  fake.accounts.Ubuntu.uid = 2000;
  await assert.rejects(manager.request('POST', '/api/terminal/profiles', profile()), { code: 'PROFILE_TARGET_CHANGED' });
  fake.accounts.Ubuntu = { user: 'other-user', uid: 1000 };
  await assert.rejects(manager.request('POST', '/api/terminal/profiles', profile()), { code: 'PROFILE_TARGET_CHANGED' });
  const after = await manager.request('GET', '/api/terminal/status');
  assert.deepEqual(after.profiles[0].wsl, original.profiles[0].wsl);
  assert.deepEqual(after.grants, original.grants);
  assert.equal(after.connections.find(c => c.id === 'live-wsl')?.ready, true);
});
