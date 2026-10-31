import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createCore } from '../server/core.mjs';
import { createTerminalManager } from '../server/terminal/manager.mjs';
import { createTerminalPluginLifecycle } from '../server/terminal/plugin-lifecycle.mjs';

async function storage(t) {
  const root = await mkdtemp(join(tmpdir(), 'seqivo-terminal-plugin-'));
  const store = new Store(join(root, 'board.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store };
}

async function coreFixture(t, manifest = true) {
  const root = await mkdtemp(join(tmpdir(), 'seqivo-terminal-plugin-core-'));
  const pluginDir = join(root, 'plugins'), dataDir = join(root, 'data');
  await mkdir(pluginDir, { recursive: true });
  if (manifest) {
    const builtIn = join(pluginDir, 'local-terminal');
    await mkdir(builtIn);
    await writeFile(join(builtIn, 'plugin.json'), await readFile(new URL('../plugins/local-terminal/plugin.json', import.meta.url)));
  }
  let core = await createCore({ dataDir, pluginDir, files: false });
  t.after(async () => { await core?.close(); await rm(root, { recursive: true, force: true }); });
  return { root, dataDir, pluginDir, get core() { return core; }, async restart() {
    await core.close();core = await createCore({ dataDir, pluginDir, files: false });return core;
  } };
}

test('Core-owned terminal registers without a worker and old metadata defaults to enabled', async t => {
  const x = await coreFixture(t);
  const descriptor = (await x.core.request('GET', '/api/plugins')).find(item => item.id === 'local-terminal');
  assert.deepEqual({ enabled: descriptor.enabled, status: descriptor.status, isolation: descriptor.isolation,
    trust: descriptor.trust, capabilities: descriptor.capabilities },
  { enabled: true, status: 'ready', isolation: 'core', trust: 'built-in', capabilities: ['terminal.local.v1'] });
  assert.equal((await x.core.request('GET', '/api/terminal/status')).plugin.contract, 'terminal.local.v1');
  for (const role of ['viewer', 'reporter', 'remote-controller'])
    await assert.rejects(x.core.request('POST', '/api/plugins/local-terminal/disable', {}, role), { code: 'TERMINAL_FORBIDDEN' });
  assert.equal((await x.core.request('GET', '/api/plugins')).filter(item => item.id === 'local-terminal').length, 1);
});

test('clean disable persists across restart, blocks tickets, then explicit enable restores the gate', async t => {
  const x = await coreFixture(t, false); // Old fixture without a new manifest is compatible.
  let plugin = (await x.core.request('GET', '/api/plugins')).find(item => item.id === 'local-terminal');
  assert.equal(plugin.status, 'ready');
  plugin = await x.core.request('POST', '/api/plugins/local-terminal/disable', {});
  assert.equal(plugin.status, 'disabled');
  assert.equal((await x.core.request('GET', '/api/terminal/status')).plugin.enabled, false);
  await assert.rejects(x.core.request('POST', '/api/terminal/tickets', { profileId: 'any' }),
    { code: 'TERMINAL_PLUGIN_DISABLED' });
  await x.restart();
  assert.equal((await x.core.request('GET', '/api/plugins')).find(item => item.id === 'local-terminal').status, 'disabled');
  plugin = await x.core.request('POST', '/api/plugins/local-terminal/enable', {});
  assert.equal(plugin.status, 'ready');
  assert.equal((await x.core.request('GET', '/api/terminal/status')).plugin.enabled, true);
});

test('side-loaded manifest cannot replace or duplicate Core-owned terminal', async t => {
  const x = await coreFixture(t);
  const forged = join(x.dataDir, 'extensions', 'local-terminal');
  await mkdir(forged, { recursive: true });
  await writeFile(join(forged, 'plugin.json'), JSON.stringify({ id: 'local-terminal', apiVersion: 1, entry: 'host.mjs' }));
  await writeFile(join(forged, 'host.mjs'), 'throw Error("untrusted terminal code executed")');
  await x.restart();
  const descriptors = (await x.core.request('GET', '/api/plugins')).filter(item => item.id === 'local-terminal');
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].isolation, 'core');
});

test('invalid or interrupted persisted schema remains unavailable and does not enable on check', async t => {
  const { root, store } = await storage(t);
  for (const value of ['null', '{', JSON.stringify({ version: 2, status: 'ready', lastError: null }),
    JSON.stringify({ version: 1, status: 'disabling', lastError: null })]) {
    store.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run('terminal.plugin.v1', value);
    const plugin = createTerminalPluginLifecycle({ store, intentPath: join(root, 'terminal-plugin-intent.json') });
    assert.equal(plugin.state().status, 'disabled_unknown');
    assert.throws(() => plugin.assertEnabled(), { code: 'TERMINAL_PLUGIN_DISABLED' });
    await assert.rejects(plugin.check(), { code: 'TERMINAL_PLUGIN_UNKNOWN' });
  }
});

test('terminal metadata survives the plugin switch and disabled profiles are not advertised', async t => {
  const { root, store } = await storage(t);
  const original = { version: 1, namespace: 'fixed-namespace',
    profiles: [{ id: 'known', label: 'Known', enabled: true, projectId: null, cwd: root }],
    grants: [{ deviceId: 'device', profileId: 'known', scopes: ['view'], revoked: false }],
    defaults: { 'local:local:known': { serverName: 'fixed', instanceId: 'a'.repeat(64), sessionId: '$1' } },
    defaultRevisions: { 'local:local:known': 4 } };
  store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('terminal.manager.v1', JSON.stringify(original));
  const plugin = createTerminalPluginLifecycle({ store, intentPath: join(root, 'terminal-plugin-intent.json') });
  const manager = createTerminalManager({ store, pluginLifecycle: plugin });
  plugin.bindManager(manager);
  assert.deepEqual(manager.profiles(), [{ id: 'known', label: 'Known' }]);
  await plugin.disable();
  assert.deepEqual(manager.profiles(), []);
  assert.deepEqual(JSON.parse(store.db.prepare('SELECT value FROM metadata WHERE key=?').get('terminal.manager.v1').value), original);
  assert.equal((await plugin.enable()).status, 'ready');
  assert.deepEqual(manager.profiles(), [{ id: 'known', label: 'Known' }]);
  await manager.close();
});

test('unknown plugin states fence restore and a failed initial persist does not detach', async t => {
  const { root, store } = await storage(t);
  let detachCalls = 0;
  const plugin = createTerminalPluginLifecycle({ store, intentPath: join(root, 'terminal-plugin-intent.json'), emit: () => { throw Error('observer failed'); } });
  const manager = createTerminalManager({ store, pluginLifecycle: plugin });
  plugin.bindManager(manager);
  const clean = await plugin.disable();
  assert.equal(clean.status, 'disabled', 'observer failure does not turn a durable success into unknown');
  assert.throws(() => plugin.assertMetadataReplacementSafe([]), { code: 'TERMINAL_PLUGIN_UNKNOWN' });
  assert.equal((await plugin.enable()).status, 'ready');
  store.db.exec("CREATE TRIGGER terminal_plugin_write_fail BEFORE INSERT ON metadata WHEN NEW.key='terminal.plugin.v1' BEGIN SELECT RAISE(ABORT,'fixture write failed'); END");
  const failed = createTerminalPluginLifecycle({ store, intentPath: join(root, 'terminal-plugin-intent.json') });
  failed.bindManager({ assertPluginLifecycleChangeSafe() {}, assertPluginDisableSafe() {}, suspendForPlugin: async () => { detachCalls++; } });
  await assert.rejects(failed.disable(), { code: 'TERMINAL_PLUGIN_PERSIST_FAILED' });
  assert.equal(detachCalls, 0);
  assert.equal(failed.state().status, 'ready', 'readback proves no gate write or detach occurred');
  assert.equal(JSON.parse(store.db.prepare('SELECT value FROM metadata WHERE key=?').get('terminal.plugin.v1').value).status, 'ready');
  await assert.rejects(readFile(join(root, 'terminal-plugin-intent.json')), { code: 'ENOENT' });
  await failed.close();
  await manager.close();
});

test('unreadable pre-effect result and an uncleared intent remain unknown after restart', async t => {
  const { root, store } = await storage(t);
  const intentPath = join(root, 'terminal-plugin-intent.json');
  let reads = 0, detached = 0;
  const unreliable = { db: { prepare(sql) {
    if (sql.startsWith('SELECT value FROM metadata')) return { get() {
      if (++reads >= 3) throw Error('readback unavailable');
      return undefined;
    } };
    if (sql.startsWith('INSERT OR REPLACE INTO metadata')) return { run() { throw Error('commit result unavailable'); } };
    throw Error('unexpected fixture query');
  } } };
  const plugin = createTerminalPluginLifecycle({ store: unreliable, intentPath });
  plugin.bindManager({ assertPluginLifecycleChangeSafe() {}, assertPluginDisableSafe() {}, suspendForPlugin: async () => { detached++; } });
  await assert.rejects(plugin.disable(), { code: 'TERMINAL_PLUGIN_UNKNOWN' });
  assert.equal(detached, 0);
  assert.equal(plugin.state().status, 'disabled_unknown');
  assert.equal((await readFile(intentPath, 'utf8')).includes('"operation":"disable"'), true);
  const restarted = createTerminalPluginLifecycle({ store, intentPath });
  assert.equal(restarted.state().status, 'disabled_unknown', 'missing old DB row cannot override the durable intent');

  // An unlink result that cannot be trusted must also keep the intent fenced.
  await unlink(intentPath);
  const clean = createTerminalPluginLifecycle({ store, intentPath });
  clean.bindManager({ assertPluginLifecycleChangeSafe() {}, assertPluginDisableSafe() {}, suspendForPlugin: async () => {
    await unlink(intentPath);
    await symlink(join(root, 'owned-diagnostic'), intentPath);
  } });
  await assert.rejects(clean.disable(), { code: 'TERMINAL_PLUGIN_UNKNOWN' });
  assert.equal(createTerminalPluginLifecycle({ store, intentPath }).state().status, 'disabled_unknown');
});

test('unknown lifecycle fences overlapping project aliases and metadata replacement', async t => {
  const { root, store } = await storage(t);
  const projectDir = join(root, 'project'), otherDir = join(root, 'other');
  await mkdir(projectDir);await mkdir(otherDir);
  const project = store.project({ name: 'Protected', directory: projectDir });
  const other = store.project({ name: 'Unrelated', directory: otherDir });
  const saved = { version: 1, profiles: [{ id: 'alias', label: 'Alias', enabled: true,
    projectId: null, cwd: projectDir }], grants: [], defaults: {}, defaultRevisions: {}, namespace: 'test' };
  store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('terminal.manager.v1', JSON.stringify(saved));
  await writeFile(join(root, 'terminal-plugin-intent.json'), '{"version":1,"operation":"disable"}');
  const plugin = createTerminalPluginLifecycle({ store, intentPath: join(root, 'terminal-plugin-intent.json') });
  const manager = createTerminalManager({ store, pluginLifecycle: plugin });
  assert.throws(() => manager.assertManagedReady(project.id), { code: 'TERMINAL_PLUGIN_UNKNOWN' });
  assert.doesNotThrow(() => manager.assertManagedReady(other.id));
  assert.throws(() => manager.beginMetadataReplacement(), { code: 'TERMINAL_PLUGIN_UNKNOWN' });
  await manager.close();
});

test('disable gates queued frames before draining and a same-process failed detach can be rechecked', async t => {
  const { root, store } = await storage(t);
  let releasePending;
  const pending = new Promise(resolve => { releasePending = resolve; });
  const plugin = createTerminalPluginLifecycle({ store, intentPath: join(root, 'terminal-plugin-intent.json') });
  const manager = createTerminalManager({ store, pluginLifecycle: plugin });
  plugin.bindManager(manager);
  manager.setLink({ pending: () => pending, state: () => ({ status: 'disconnected' }), close: async () => {} });
  const busy = manager.request('GET', '/api/terminal/status');
  const queued = manager.frame({ profileId: 'none', connectionId: 'queued' }, { v: 1, type: 'open' }, () => {});
  const disabling = plugin.disable();
  assert.equal(plugin.state().status, 'disabling');
  assert.throws(() => plugin.assertEnabled(), { code: 'TERMINAL_PLUGIN_DISABLED' });
  releasePending({ devices: [] });
  await busy;
  await assert.rejects(queued, { code: 'TERMINAL_PLUGIN_DISABLED' });
  assert.equal((await disabling).status, 'disabled');
  await manager.close();

  let attempts = 0;
  // Separate persisted state from the manager exercise above.
  store.db.prepare('DELETE FROM metadata WHERE key=?').run('terminal.plugin.v1');
  const recovery = createTerminalPluginLifecycle({ store, intentPath: join(root, 'terminal-plugin-intent.json') });
  recovery.bindManager({ assertPluginLifecycleChangeSafe() {}, assertPluginDisableSafe() {}, suspendForPlugin: async () => {
    if (++attempts === 1) throw Error('first detach unknown');
  }, verifyPluginRecovery: async () => {} });
  await assert.rejects(recovery.disable(), { code: 'TERMINAL_PLUGIN_UNKNOWN' });
  assert.equal(recovery.state().status, 'disabled_unknown');
  assert.equal((await recovery.check()).status, 'disabled');
  assert.equal((await recovery.enable()).status, 'ready');
});

test('synchronous change observers cannot re-enter lifecycle while the gate is being persisted', async t => {
  const { root, store } = await storage(t);
  let plugin, rejected;
  plugin = createTerminalPluginLifecycle({ store, intentPath: join(root, 'terminal-plugin-intent.json'), emit: () => {
    try { plugin.enable(); } catch (error) { rejected = error.code; }
  } });
  plugin.bindManager({ assertPluginLifecycleChangeSafe() {}, assertPluginDisableSafe() {}, suspendForPlugin: async () => {},
    verifyPluginRecovery: async () => {} });
  assert.equal((await plugin.disable()).status, 'disabled');
  assert.equal(rejected, 'TERMINAL_PLUGIN_BUSY');
});

test('metadata replacement and an awaited plugin enable cannot cross each other', async t => {
  const { root, store } = await storage(t);
  const plugin = createTerminalPluginLifecycle({ store, intentPath: join(root, 'terminal-plugin-intent.json') });
  const manager = createTerminalManager({ store, pluginLifecycle: plugin });
  plugin.bindManager(manager);
  await plugin.disable();
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  manager.verifyPluginRecovery = async () => waiting;
  const enabling = plugin.enable();
  assert.throws(() => manager.beginMetadataReplacement(), { code: 'TERMINAL_PLUGIN_BUSY' });
  release();
  assert.equal((await enabling).status, 'ready');
  const finish = manager.beginMetadataReplacement();
  await assert.rejects(plugin.disable(), { code: 'TERMINAL_PLUGIN_BUSY' });
  finish();
  await manager.close();
});
