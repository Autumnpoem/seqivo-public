import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { accessSync, constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { createTerminalManager, originalTerminalAttachmentPresent } from '../server/terminal/manager.mjs';
import { createTerminalPluginLifecycle } from '../server/terminal/plugin-lifecycle.mjs';
import { createTmuxAdapter } from '../server/terminal/tmux.mjs';
import { nativeProcessTable } from '../server/codex-process-proof.mjs';

const KEY = 'terminal.plugin.v1';
const intent = root => join(root, 'terminal-plugin-intent.json');
const lifecycle = (store, root) => {
  const plugin = createTerminalPluginLifecycle({ store, intentPath: intent(root) });
  const manager = createTerminalManager({ store, pluginLifecycle: plugin });
  plugin.bindManager(manager);
  return { plugin, manager };
};
const python = process.env.TASKBOARD_TEST_PYTHON || resolve(dirname(process.execPath), '../../python/bin/python3');
const tmux = process.env.TMUX_TEST_EXECUTABLE || fileURLToPath(new URL('../.tools/terminal-build/install/bin/tmux', import.meta.url));
const delayUntil = async (predicate, timeout = 8000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const result = await predicate(); if (result) return result; } catch { /* Retry the fixture observation. */ }
    await delay(25);
  }
  throw Error('fixture condition did not become true');
};

test('an original birth remains live after group or UID changes', () => {
  const original = { pid: 12345, pgid: 12345, euid: 501, ruid: 501,
    startSec: 100, startUsec: 200 };
  assert.equal(originalTerminalAttachmentPresent(new Map([[original.pid,
    { ...original, pgid: 99999, euid: 502, ruid: 502 }]]), original), true);
  assert.equal(originalTerminalAttachmentPresent(new Map([[original.pid,
    { ...original, startUsec: 201 }]]), original), false);
});

test('interrupted zero-attachment disable recovers only to disabled after a real process loss', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seqivo-plugin-cold-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const childSource = `
    import { Store } from ${JSON.stringify(new URL('../server/store.mjs', import.meta.url).href)};
    import { createTerminalManager } from ${JSON.stringify(new URL('../server/terminal/manager.mjs', import.meta.url).href)};
    import { createTerminalPluginLifecycle } from ${JSON.stringify(new URL('../server/terminal/plugin-lifecycle.mjs', import.meta.url).href)};
    import { join } from 'node:path';
    const root = process.argv[1], store = new Store(join(root, 'board.sqlite'));
    const plugin = createTerminalPluginLifecycle({store,intentPath:join(root,'terminal-plugin-intent.json')});
    const manager = createTerminalManager({store,pluginLifecycle:plugin});
    plugin.bindManager(manager);
    manager.suspendForPlugin = () => new Promise(() => {});
    void plugin.disable();
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource, root], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  try {
    let witnessed = false;
    for (let n = 0; n < 250; n++) {
      if (child.exitCode !== null) throw Error(`fixture exited early: ${child.exitCode}`);
      try { witnessed = JSON.parse(await readFile(intent(root), 'utf8')).zeroAttachments === true; }
      catch { /* Wait for the durable intent. */ }
      if (witnessed) break;
      await delay(20);
    }
    assert.equal(witnessed, true, 'the disable witness must be durable before process loss');
  } finally { child.kill('SIGKILL'); await exited; }

  const store = new Store(join(root, 'board.sqlite'));
  t.after(() => store.close());
  assert.equal(JSON.parse(store.db.prepare('SELECT value FROM metadata WHERE key=?').get(KEY).value).status, 'disabling');
  const { plugin, manager } = lifecycle(store, root);
  assert.equal(plugin.state().status, 'disabled_unknown');
  assert.throws(() => plugin.assertEnabled(), { code: 'TERMINAL_PLUGIN_DISABLED' });
  assert.equal((await plugin.check()).status, 'disabled');
  await assert.rejects(readFile(intent(root)), { code: 'ENOENT' });
  assert.throws(() => plugin.assertEnabled(), { code: 'TERMINAL_PLUGIN_DISABLED' });
  assert.equal((await plugin.enable()).status, 'ready', 'input needs a separate explicit enable');
  await manager.close();
});

test('legacy, incomplete, and mismatched disable evidence remain unknown after restart', async t => {
  for (const scenario of ['legacy', 'missing', 'no-witness', 'wrong-id', 'wrong-operation',
    'malformed-id', 'extra-field', 'public-mode', 'unrelated-error', 'symlink']) {
    const root = await mkdtemp(join(tmpdir(), `seqivo-plugin-${scenario}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new Store(join(root, 'board.sqlite'));
    const id = randomUUID();
    store.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(KEY,
      JSON.stringify({ version: 1, status: scenario === 'unrelated-error' ? 'disabled_unknown' : 'disabling',
        lastError: scenario === 'unrelated-error' ? '终端插件状态未能持久保存，输入已冻结' : null,
        ...(scenario === 'legacy' ? {} : { intentId: id }) }));
    if (scenario !== 'missing') {
      const value = JSON.stringify({ version: scenario === 'legacy' ? 1 : 2,
        id: scenario === 'wrong-id' ? randomUUID() : scenario === 'malformed-id' ? 'a'.repeat(36) : id,
        operation: scenario === 'wrong-operation' ? 'enable' : 'disable',
        ...(scenario === 'no-witness' || scenario === 'legacy' ? {} : { zeroAttachments: true }),
        ...(scenario === 'extra-field' ? { owner: 'forged' } : {}) });
      if (scenario === 'symlink') {
        const target = join(root, 'outside.json');
        await writeFile(target, value, { mode: 0o600 });
        await symlink(target, intent(root));
      } else {
        await writeFile(intent(root), value, { mode: 0o600 });
        if (scenario === 'public-mode') {
          // chmod is deliberate: creation modes are masked by the build's umask.
          await chmod(intent(root), 0o644);
          assert.equal((await stat(intent(root))).mode & 0o777, 0o644);
        }
      }
    }
    const { plugin, manager } = lifecycle(store, root);
    assert.equal(plugin.state().status, 'disabled_unknown', scenario);
    await assert.rejects(plugin.check(), { code: 'TERMINAL_PLUGIN_UNKNOWN' }, scenario);
    assert.throws(() => plugin.assertEnabled(), { code: 'TERMINAL_PLUGIN_DISABLED' }, scenario);
    await manager.close();
    store.close();
  }
});

test('missing process UID preserves an ordinary disable without a cold witness', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seqivo-plugin-no-uid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = `
    import { Store } from ${JSON.stringify(new URL('../server/store.mjs', import.meta.url).href)};
    import { createTerminalManager } from ${JSON.stringify(new URL('../server/terminal/manager.mjs', import.meta.url).href)};
    import { createTerminalPluginLifecycle } from ${JSON.stringify(new URL('../server/terminal/plugin-lifecycle.mjs', import.meta.url).href)};
    import { join } from 'node:path';
    import { existsSync } from 'node:fs';
    const root = process.argv[1], store = new Store(join(root, 'board.sqlite'));
    process.getuid = undefined;
    const plugin = createTerminalPluginLifecycle({store,intentPath:join(root,'terminal-plugin-intent.json')});
    const manager = createTerminalManager({store,pluginLifecycle:plugin});
    plugin.bindManager(manager);
    const result = await plugin.disable();
    console.log(JSON.stringify({status:result.status,intent:existsSync(join(root,'terminal-plugin-intent.json'))}));
    await manager.close(); store.close();
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source, root],
    { encoding: 'utf8' }).trim());
  assert.deepEqual(result, { status: 'disabled', intent: false });
});

test('a witness write failure leaves the interrupted disable fenced across restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seqivo-plugin-write-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = `
    import { Store } from ${JSON.stringify(new URL('../server/store.mjs', import.meta.url).href)};
    import { createTerminalManager } from ${JSON.stringify(new URL('../server/terminal/manager.mjs', import.meta.url).href)};
    import { createTerminalPluginLifecycle } from ${JSON.stringify(new URL('../server/terminal/plugin-lifecycle.mjs', import.meta.url).href)};
    import { join } from 'node:path';
    import { readFileSync } from 'node:fs';
    const root = process.argv[1], store = new Store(join(root, 'board.sqlite'));
    const plugin = createTerminalPluginLifecycle({store,intentPath:join(root,'terminal-plugin-intent.json')});
    const manager = createTerminalManager({store,pluginLifecycle:plugin});
    plugin.bindManager(manager);
    const original = manager.preparePluginDisable.bind(manager), uid = process.getuid;
    manager.preparePluginDisable = async () => {
      const prepared = await original();
      process.getuid = () => { throw Error('fixture witness failure'); };
      return prepared;
    };
    let code;
    try { await plugin.disable(); } catch (error) { code = error.code; }
    process.getuid = uid;
    const witness = JSON.parse(readFileSync(join(root,'terminal-plugin-intent.json'),'utf8'));
    await manager.close().catch(() => {});
    store.close();
    console.log(JSON.stringify({code, witness:witness.zeroAttachments ?? null}));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source, root],
    { encoding: 'utf8' }).trim());
  assert.deepEqual(result, { code: 'TERMINAL_PLUGIN_UNKNOWN', witness: null });
  const store = new Store(join(root, 'board.sqlite'));
  t.after(() => store.close());
  const { plugin, manager } = lifecycle(store, root);
  assert.equal(plugin.state().status, 'disabled_unknown');
  await assert.rejects(plugin.check(), { code: 'TERMINAL_PLUGIN_UNKNOWN' });
  await manager.close().catch(() => {});
});

test('a post-witness detach failure recorded as unknown recovers only to disabled', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seqivo-plugin-post-witness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = `
    import { Store } from ${JSON.stringify(new URL('../server/store.mjs', import.meta.url).href)};
    import { createTerminalManager } from ${JSON.stringify(new URL('../server/terminal/manager.mjs', import.meta.url).href)};
    import { createTerminalPluginLifecycle } from ${JSON.stringify(new URL('../server/terminal/plugin-lifecycle.mjs', import.meta.url).href)};
    import { join } from 'node:path';
    import { readFileSync } from 'node:fs';
    const root = process.argv[1], store = new Store(join(root, 'board.sqlite'));
    const plugin = createTerminalPluginLifecycle({store,intentPath:join(root,'terminal-plugin-intent.json')});
    const manager = createTerminalManager({store,pluginLifecycle:plugin});
    plugin.bindManager(manager);
    manager.suspendForPlugin = async () => { throw Error('fixture post-witness failure'); };
    let code;
    try { await plugin.disable(); } catch (error) { code = error.code; }
    const witness = JSON.parse(readFileSync(join(root,'terminal-plugin-intent.json'),'utf8'));
    const durable = JSON.parse(store.db.prepare('SELECT value FROM metadata WHERE key=?').get('terminal.plugin.v1').value);
    store.close();
    console.log(JSON.stringify({code,zeroAttachments:witness.zeroAttachments,matchingId:witness.id===durable.intentId,status:durable.status}));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source, root],
    { encoding: 'utf8' }).trim());
  assert.deepEqual(result, { code: 'TERMINAL_PLUGIN_UNKNOWN', zeroAttachments: true,
    matchingId: true, status: 'disabled_unknown' });
  const store = new Store(join(root, 'board.sqlite'));
  t.after(() => store.close());
  const { plugin, manager } = lifecycle(store, root);
  assert.equal(plugin.state().status, 'disabled_unknown');
  assert.equal((await plugin.check()).status, 'disabled');
  await assert.rejects(readFile(intent(root)), { code: 'ENOENT' });
  assert.throws(() => plugin.assertEnabled(), { code: 'TERMINAL_PLUGIN_DISABLED' });
  assert.equal((await plugin.enable()).status, 'ready');
  await manager.close();
});

test('a committed disable with the exact surviving witness can finish intent cleanup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seqivo-plugin-committed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'board.sqlite'));
  t.after(() => store.close());
  const id = randomUUID();
  store.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(KEY,
    JSON.stringify({ version: 1, status: 'disabled', lastError: null, intentId: id }));
  await writeFile(intent(root), JSON.stringify({ version: 2, id, operation: 'disable', zeroAttachments: true }),
    { mode: 0o600 });
  const { plugin, manager } = lifecycle(store, root);
  assert.equal(plugin.state().status, 'disabled_unknown');
  assert.equal((await plugin.check()).status, 'disabled');
  await assert.rejects(readFile(intent(root)), { code: 'ENOENT' });
  await manager.close();
});

test('partial, altered, and mismatched attached witnesses never clear cold unknown', async t => {
  if (process.platform !== 'darwin') { t.skip('macOS attached recovery only'); return; }
  const identity = { pid: 12345, pgid: 12345, euid: process.geteuid(), ruid: process.getuid(),
    startSec: 100, startUsec: 200 };
  const attachment = { connectionId: 'one', profileId: 'profile', profileBinding: 'a'.repeat(64),
    sessionRef: { serverName: 'seqivo_fixture', instanceId: 'b'.repeat(64), sessionId: '$1' }, identity };
  for (const scenario of ['missing', 'partial', 'altered-birth', 'wrong-id', 'wrong-count', 'extra-field', 'public-mode']) {
    const root = await mkdtemp(join(tmpdir(), `seqivo-plugin-attached-${scenario}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new Store(join(root, 'board.sqlite'));
    const id = randomUUID();
    const witness = { version: 3, id, operation: 'disable', connectionCount: 1,
      runtimeCount: 1, attachments: [attachment] };
    const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const proof = { attachmentDigest: digest(witness), attachmentCount: 1, connectionCount: 1 };
    const altered = structuredClone(witness);
    if (scenario === 'partial') altered.attachments = [];
    if (scenario === 'altered-birth') altered.attachments[0].identity.startUsec++;
    if (scenario === 'wrong-id') altered.id = randomUUID();
    if (scenario === 'wrong-count') altered.connectionCount = 2;
    if (scenario === 'extra-field') altered.unexpected = true;
    if (scenario === 'partial' || scenario === 'extra-field') proof.attachmentDigest = digest(altered);
    store.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(KEY,
      JSON.stringify({ version: 1, status: 'disabling', lastError: null, intentId: id, ...proof }));
    if (scenario !== 'missing') {
      await writeFile(intent(root), JSON.stringify(altered), { mode: 0o600 });
      if (scenario === 'public-mode') await chmod(intent(root), 0o644);
    }
    const { plugin, manager } = lifecycle(store, root);
    assert.equal(plugin.state().status, 'disabled_unknown', scenario);
    await assert.rejects(plugin.check(), { code: 'TERMINAL_PLUGIN_UNKNOWN' }, scenario);
    assert.throws(() => plugin.assertEnabled(), { code: 'TERMINAL_PLUGIN_DISABLED' }, scenario);
    await manager.close();
    store.close();
  }
});

test('an attached tmux client still disables normally when cold birth proof is unavailable', async t => {
  if (process.platform !== 'darwin') { t.skip('macOS tmux fixture'); return; }
  try { execFileSync(tmux, ['-V'], { stdio: 'ignore' }); }
  catch { t.skip('isolated test tmux unavailable'); return; }
  const root = await mkdtemp(join(tmpdir(), 'seqivo-plugin-no-cold-proof-'));
  const store = new Store(join(root, 'board.sqlite'));
  const serverName = `seqivo-recovery-${process.pid}-${randomUUID().slice(0, 8)}`;
  const run = (...args) => execFileSync(tmux, ['-L', serverName, ...args],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  const { plugin, manager } = lifecycle(store, root); // No managed record root: no native cold proof.
  try {
    run('new-session', '-d', '-s', 'A', '-c', root, '/bin/sh');
    const ref = (await createTmuxAdapter({ executable: tmux, serverName }).list()).sessions[0].sessionRef;
    await manager.request('POST', '/api/terminal/profiles',
      { id: 'attached', label: 'Attached', cwd: root, enabled: true, serverName,
        allowSharedServer: true, tmuxExecutable: tmux, shell: '/bin/sh' });
    const ctx = { local: true, profileId: 'attached', connectionId: 'attached-client' }, frames = [];
    await manager.frame(ctx, { v: 1, type: 'open', mode: 'tmux', readOnly: true,
      cols: 80, rows: 24 }, frame => frames.push(frame));
    await manager.frame(ctx, { v: 1, type: 'select', epoch: 0, sessionRef: ref },
      frame => frames.push(frame));
    assert.ok(frames.some(frame => frame.type === 'ready'));
    assert.equal((await plugin.disable()).status, 'disabled');
    await assert.rejects(readFile(intent(root)), { code: 'ENOENT' });
    assert.equal(manager.hasConnections(), false);
  } finally {
    await manager.close().catch(() => {});
    store.close();
    try { run('kill-server'); } catch { /* Only this unique disposable server was addressed. */ }
    await rm(root, { recursive: true, force: true });
  }
});

test('attached tmux cold check refuses a live original client and recovers after its exact birth exits', async t => {
  if (process.platform !== 'darwin') { t.skip('macOS native process identity required'); return; }
  try { accessSync(python, constants.X_OK); execFileSync(tmux, ['-V'], { stdio: 'ignore' }); }
  catch { t.skip('bundled Python or isolated test tmux unavailable'); return; }
  const root = await mkdtemp(join(tmpdir(), 'seqivo-plugin-attached-'));
  const records = join(root, 'records');
  await mkdir(records, { mode: 0o700 });
  const serverName = `seqivo-recovery-${process.pid}-${randomUUID().slice(0, 8)}`;
  const run = (...args) => execFileSync(tmux, ['-L', serverName, ...args],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  const childSource = `
    import { Store } from ${JSON.stringify(new URL('../server/store.mjs', import.meta.url).href)};
    import { createTerminalManager } from ${JSON.stringify(new URL('../server/terminal/manager.mjs', import.meta.url).href)};
    import { createTerminalPluginLifecycle } from ${JSON.stringify(new URL('../server/terminal/plugin-lifecycle.mjs', import.meta.url).href)};
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const [root, records, tmux, serverName, refText, python] = process.argv.slice(1);
    const store = new Store(join(root, 'board.sqlite'));
    const plugin = createTerminalPluginLifecycle({store,intentPath:join(root,'terminal-plugin-intent.json')});
    const manager = createTerminalManager({store,pluginLifecycle:plugin,managedRecordRoot:records,managedPythonPath:python});
    plugin.bindManager(manager);
    await manager.request('POST','/api/terminal/profiles',
      {id:'attached',label:'Attached',cwd:root,enabled:true,serverName,allowSharedServer:true,tmuxExecutable:tmux,shell:'/bin/sh'});
    const ctx={local:true,profileId:'attached',connectionId:'attached-client'}, frames=[];
    await manager.frame(ctx,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},frame=>frames.push(frame));
    await manager.frame(ctx,{v:1,type:'select',epoch:0,sessionRef:JSON.parse(refText)},frame=>frames.push(frame));
    const ready=frames.find(frame=>frame.type==='ready');
    if (!ready) throw Error('tmux client did not attach');
    await manager.frame(ctx,{v:1,type:'input',epoch:ready.epoch,seq:0,
      data:Buffer.from('printf REC1013 > marker.txt\\n').toString('base64')},frame=>frames.push(frame));
    writeFileSync(join(root,'attached.ready'),'ready');
    manager.suspendForPlugin = () => new Promise(() => {});
    void plugin.disable();
    setInterval(() => {}, 1000);
  `;
  let child, store, manager;
  try {
    run('new-session', '-d', '-s', 'A', '-c', root, '/bin/sh');
    const adapter = createTmuxAdapter({ executable: tmux, serverName });
    const ref = (await adapter.list()).sessions[0].sessionRef;
    const paneBefore = (await adapter.sessionPanes(ref))[0];
    child = spawn(process.execPath, ['--input-type=module', '-e', childSource,
      root, records, tmux, serverName, JSON.stringify(ref), python], { stdio: ['ignore', 'pipe', 'pipe'] });
    let childError = '';
    child.stderr.on('data', chunk => { childError = (childError + chunk.toString()).slice(0, 4000); });
    await delayUntil(async () => {
      if (child.exitCode !== null) throw Error(`fixture exited: ${child.exitCode} ${childError}`);
      return (await readFile(join(root, 'attached.ready'), 'utf8')) === 'ready';
    });
    const witness = await delayUntil(async () => {
      const value = JSON.parse(await readFile(intent(root), 'utf8'));
      return value.version === 3 ? value : null;
    });
    assert.equal(await delayUntil(async () => await readFile(join(root, 'marker.txt'), 'utf8')), 'REC1013');
    assert.equal(witness.connectionCount, 1);
    assert.equal(witness.runtimeCount, 1);
    assert.equal(witness.attachments.length, 1);
    const original = witness.attachments[0].identity;
    assert.equal((await nativeProcessTable(python, 15000)).get(original.pid)?.startUsec, original.startUsec);
    store = new Store(join(root, 'board.sqlite'));
    const plugin = createTerminalPluginLifecycle({store,intentPath:intent(root)});
    manager = createTerminalManager({store,pluginLifecycle:plugin,managedRecordRoot:records,managedPythonPath:python});
    plugin.bindManager(manager);
    await manager.initializeManaged();
    assert.equal(plugin.state().status, 'disabled_unknown');
    await assert.rejects(plugin.check(), { code: 'TERMINAL_PLUGIN_UNKNOWN' }, 'live original tmux client must block');
    assert.equal(plugin.state().status, 'disabled_unknown');
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await delayUntil(async () => {
      const row = (await nativeProcessTable(python, 15000)).get(original.pid);
      return !row || row.startSec !== original.startSec || row.startUsec !== original.startUsec;
    });
    assert.equal((await plugin.check()).status, 'disabled');
    assert.equal((await adapter.sessionPanes(ref))[0].pid, paneBefore.pid, 'original tmux pane survives');
    assert.equal(await readFile(join(root, 'marker.txt'), 'utf8'), 'REC1013');
    assert.throws(() => plugin.assertEnabled(), { code: 'TERMINAL_PLUGIN_DISABLED' });
    assert.equal((await plugin.enable()).status, 'ready');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
    await manager?.close().catch(() => {});
    store?.close();
    try { run('kill-server'); } catch { /* Only this unique disposable server was addressed. */ }
    await rm(root, { recursive: true, force: true });
  }
});
