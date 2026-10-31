import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createCore } from '../server/core.mjs';
import { Store } from '../server/store.mjs';
import { createTmuxAdapter } from '../server/terminal/tmux.mjs';
import { connectManagedPane } from '../server/terminal/managed-pane.mjs';

const execAsync = promisify(execFile), sleep = ms => new Promise(done => setTimeout(done, ms));
const pythonPath = process.env.TASKBOARD_TEST_PYTHON || '/usr/bin/python3';
const tmuxPath = resolve(process.env.TASKBOARD_TEST_TMUX || '.tools/terminal-build/install/bin/tmux');
async function until(check, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await check()) return; } catch {} await sleep(50); }
  throw new Error('Isolated managed Core condition timed out');
}
async function fixture(t, allowLinux = false) {
  if (process.platform !== 'darwin' && !(allowLinux && process.platform === 'linux')) {
    t.skip('Exact managed process identity required'); return null;
  }
  try { await access(pythonPath, constants.X_OK); await access(tmuxPath, constants.X_OK); }
  catch { t.skip('Isolated Python/tmux runtime unavailable'); return null; }
  const root = await mkdtemp(join(tmpdir(), 'seqivo-managed-core-'));
  const dataDir = join(root, 'data'), workspace = join(root, 'workspace');
  await mkdir(dataDir); await mkdir(workspace);
  const serverName = `seqivo_core_${randomBytes(6).toString('hex')}`;
  const run = (...args) => execAsync(tmuxPath, ['-L', serverName, ...args], { timeout: 5000 });
  let core = await createCore({ dataDir, pluginDir: join(root, 'plugins'), files: false, managedPythonPath: pythonPath });
  const project = core.store.project({ name: 'Isolated managed pane', directory: workspace });
  await core.request('POST', '/api/terminal/profiles', { id: 'managed', label: 'Isolated managed',
    projectId: project.id, enabled: true, shell: '/bin/sh', serverName,
    allowSharedServer: true, tmuxExecutable: tmuxPath });
  const adapter = createTmuxAdapter({ executable: tmuxPath, serverName });
  const f = { root, dataDir, workspace, serverName, run, adapter, project,
    get core() { return core; }, set core(value) { core = value; },
    async restart() { await core.close(); core = await createCore({ dataDir, pluginDir: join(root, 'plugins'),
      files: false, managedPythonPath: pythonPath }); } };
  t.after(async () => {
    try { await core?.close(); } catch {}
    const recordsRoot = join(dataDir, 'terminal-managed-records');
    const { readdir } = await import('node:fs/promises');
    let cleanupUnknown = false;
    for (const dir of await readdir(recordsRoot).catch(() => [])) {
      let pane;
      try {
        const record = JSON.parse(await readFile(join(recordsRoot, dir, 'record.json'), 'utf8'));
        pane = await connectManagedPane({ socketPath: record.pane.socketPath, capability: record.pane.capability });
        const state = await pane.status();
        if (state.state !== 'exited') {
          if (state.state === 'stopped' || state.inputFrozen) await pane.resume();
          await run('send-keys', '-t', record.tmux.relayPaneId, 'exit', 'Enter');
          await until(async () => (await pane.status()).state === 'exited', 3000);
        }
        await pane.shutdown();
        await rm(record.pane.directory, { recursive: true, force: true });
      } catch (error) {
        cleanupUnknown = true;
        t.diagnostic(`Managed fixture cleanup unconfirmed (${error.code || error.message}); retained ${root}`);
      }
      finally { pane?.close(); }
    }
    if (cleanupUnknown) assert.fail('Managed fixture cleanup was not confirmed; original fixture retained');
    try { await run('kill-server'); } catch {}
    await rm(root, { recursive: true, force: true });
  });
  return f;
}
async function openOwner(core, connectionId, frames) {
  const ctx = { local: true, profileId: 'managed', connectionId };
  const send = frame => frames.push(frame);
  await core.terminal.frame(ctx, { v: 1, type: 'open', mode: 'tmux', cols: 80, rows: 24 }, send);
  return { ctx, send };
}
async function diagnosed(t, operation) {
  try { return await operation(); }
  catch (error) {
    // Fixed internal category only: never print the private record, capability,
    // socket path or native process table into a test log.
    t.diagnostic(`Managed operation failed: ${error.code || 'ERROR'} / ${error.diagnostic || 'unclassified'}`);
    throw error;
  }
}

test('Core rejects stale task content across awaited managed-pane proof before reserve and final send', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seqivo-managed-barrier-'));
  const pluginDir=join(root,'plugins'), extension=join(pluginDir,'fake');
  await mkdir(extension,{recursive:true});
  await writeFile(join(extension,'plugin.json'),JSON.stringify({id:'fake',name:'Barrier provider',version:'1',
    apiVersion:1,entry:'host.mjs',permissions:['tasks.read','task.resume','task.pause'],
    capabilities:['task.resume','task.pause']}));
  await writeFile(join(extension,'host.mjs'),`export async function createPlugin(context){
    const state=()=>({enabled:false,available:true});
    const resume=input=>context.authorizeExecution(input);
    return {state,configure:input=>input?.send?context.authorizeExecution(input.send):
      input?.revalidate?context.revalidateExecution(input.revalidate):state(),
      enable:state,disable:state,close:async()=>{},resume,pause:async()=>({status:'paused'}),
      check:async()=>state(),getExecution:async()=>({status:'unknown'})};
  }`);
  const core=await createCore({dataDir:join(root,'data'),pluginDir,files:false});
  t.after(async()=>{await core.close();await rm(root,{recursive:true,force:true});});
  const project=core.store.project({name:'Barrier workspace',directory:root});
  const task=core.store.createTask({projectId:project.id,title:'Before proof',conversationId:'thread-original',
    executionProvider:'fake'});
  const original=core.terminal.verifyManagedForExecution;
  const gate=()=>{
    let entered,release;
    const reached=new Promise(resolve=>{entered=resolve;});
    const waiting=new Promise(resolve=>{release=resolve;});
    core.terminal.verifyManagedForExecution=async()=>{entered();await waiting;};
    return {reached,release};
  };
  const first=gate();
  const pending=core.request('PATCH','/api/plugins/fake/config',{send:{taskId:task.id,commandId:'stale-reserve',
    expectedRevision:task.revision}});
  await first.reached;
  const newer=core.store.updateTask(task.id,{summary:'Changed during process proof'},task.revision);
  first.release();
  await assert.rejects(pending,{code:'EXECUTION_BINDING_CHANGED'});
  assert.equal(core.leases.state().active.length,0);

  const second=gate();
  const final=core.request('PATCH','/api/plugins/fake/config',{revalidate:{taskId:task.id,
    commandId:'stale-send',expectedRevision:newer.revision,expectedConversationId:newer.conversationId,
    expectedDirectory:project.directory}});
  await second.reached;
  core.store.updateTask(task.id,{summary:'Changed before final send'},newer.revision);
  second.release();
  await assert.rejects(final,{code:'EXECUTION_BINDING_CHANGED'});
  core.terminal.verifyManagedForExecution=original;
  assert.equal(core.leases.state().active.length,0);
});

test('real Core retains the original managed shell across close/restart and explicit owner recovery', async t => {
  const f = await fixture(t, true); if (!f) return;
  const frames = [], { ctx, send } = await openOwner(f.core, 'first-owner', frames);
  await f.core.terminal.frame(ctx, { v: 1, type: 'takeover' }, send);
  assert.equal(frames.filter(x => x.type === 'control').at(-1).phase, 'human');
  await f.core.terminal.frame(ctx, { v: 1, type: 'create', epoch: 0, name: 'original' }, send);
  const ready = frames.filter(x => x.type === 'ready').at(-1);
  assert.ok(ready?.sessionRef);
  const index = JSON.parse(f.core.store.db.prepare('SELECT value FROM metadata WHERE key=?')
    .get('terminal.managed-panes.v1').value);
  assert.equal(index.entries.length, 1);
  assert.equal(index.entries[0].status, 'started');
  assert.equal(JSON.stringify(await f.core.request('GET', '/api/terminal/status')).includes('record.json'), false);
  const record = JSON.parse(await readFile(join(f.dataDir, 'terminal-managed-records', index.entries[0].directory, 'record.json'), 'utf8'));
  assert.equal(JSON.stringify(await f.core.request('GET', '/api/terminal/status')).includes(record.pane.capability), false);
  const shellPid = record.identities.shell.pid;
  if (process.platform === 'linux') {
    assert.equal(record.version, 2);
    assert.equal(record.identityKind, 'linux-proc');
    assert.match(record.identities.shell.startTicks, /^[1-9][0-9]*$/);
  }
  const marker = join(f.workspace, 'before.txt');
  await f.core.terminal.frame(ctx, { v: 1, type: 'input', epoch: ready.epoch, seq: 1,
    data: Buffer.from(`printf BEFORE > '${marker}'\n`).toString('base64') }, send);
  await until(async () => (await readFile(marker, 'utf8').catch(() => '')) === 'BEFORE');
  if (process.platform === 'linux') {
    await f.core.close(); f.core = null;
    const secondMarker=join(f.workspace,'after.txt');
    await execAsync(process.execPath,[fileURLToPath(new URL('./fixtures/linux-managed-core-controller.mjs',import.meta.url)),
      f.dataDir,f.root,JSON.stringify(ready.sessionRef),secondMarker],
    {timeout:30000,env:{...process.env,TASKBOARD_TEST_PYTHON:pythonPath}});
    assert.equal(await readFile(secondMarker,'utf8'),'AFTER');
    f.core=await createCore({dataDir:f.dataDir,pluginDir:join(f.root,'plugins'),files:false,managedPythonPath:pythonPath});
    const after=JSON.parse(await readFile(join(f.dataDir,'terminal-managed-records',index.entries[0].directory,'record.json'),'utf8'));
    assert.equal(after.identities.shell.pid,shellPid);
    assert.equal(after.identities.shell.bootId,record.identities.shell.bootId);
    assert.equal(after.identities.shell.startTicks,record.identities.shell.startTicks);
    assert.equal(JSON.parse(f.core.store.db.prepare('SELECT value FROM metadata WHERE key=?')
      .get('terminal.managed-panes.v1').value).entries.length,1);
    return;
  }
  await f.restart();
  assert.equal((await f.adapter.sessionPanes(ready.sessionRef))[0].pid, record.tmux.relayPanePid);
  await assert.rejects(f.core.terminal.frame(ctx, { v: 1, type: 'input', epoch: ready.epoch,
    seq: 2, data: Buffer.from('printf STALE\n').toString('base64') }, send), { code: 'OPEN_REQUIRED' });
  const recoveredFrames = [], recovered = await openOwner(f.core, 'recovered-owner', recoveredFrames);
  await f.core.terminal.frame(recovered.ctx, { v: 1, type: 'reconcile-control', action: 'acquire',
    sessionRef: ready.sessionRef, requestId: 'recover-original' }, recovered.send);
  assert.equal(recoveredFrames.filter(x => x.type === 'control').at(-1).owned, true);
  await f.core.terminal.frame(recovered.ctx, { v: 1, type: 'select', epoch: 0,
    sessionRef: ready.sessionRef }, recovered.send);
  const second = recoveredFrames.filter(x => x.type === 'ready').at(-1);
  assert.ok(second?.epoch > 0);
  const secondMarker = join(f.workspace, 'after.txt');
  await f.core.terminal.frame(recovered.ctx, { v: 1, type: 'input', epoch: second.epoch, seq: 1,
    data: Buffer.from(`printf AFTER > '${secondMarker}'\n`).toString('base64') }, recovered.send);
  await until(async () => (await readFile(secondMarker, 'utf8').catch(() => '')) === 'AFTER');
  const recoveredRecord = JSON.parse(await readFile(join(f.dataDir, 'terminal-managed-records', index.entries[0].directory,
    'record.json'), 'utf8'));
  assert.equal(recoveredRecord.identities.shell.pid, shellPid);
  assert.equal(JSON.parse(f.core.store.db.prepare('SELECT value FROM metadata WHERE key=?')
    .get('terminal.managed-panes.v1').value).entries.length, 1);
});

test('parked managed tmux hands the workspace to a fake provider and explicitly resumes the original shell', async t => {
  const f = await fixture(t, true); if (!f) return;
  const task = f.core.store.createTask({ projectId: f.project.id, title: 'Fake provider handoff',
    executionProvider: 'fake' });
  const frames = [], owner = await openOwner(f.core, 'handoff-owner', frames);
  await f.core.terminal.frame(owner.ctx, { v: 1, type: 'takeover' }, owner.send);
  await f.core.terminal.frame(owner.ctx, { v: 1, type: 'create', epoch: 0, name: 'handoff-original' }, owner.send);
  const first = frames.filter(x => x.type === 'ready').at(-1);
  assert.ok(first?.sessionRef);
  const index = JSON.parse(f.core.store.db.prepare('SELECT value FROM metadata WHERE key=?')
    .get('terminal.managed-panes.v1').value);
  const record = JSON.parse(await readFile(join(f.dataDir, 'terminal-managed-records',
    index.entries[0].directory, 'record.json'), 'utf8'));
  const originalPid = record.identities.shell.pid;
  assert.equal(f.core.leases.available({ taskId: task.id }), false);

  await f.core.terminal.frame(owner.ctx, { v: 1, type: 'return', notes: 'Original shell is idle' }, owner.send);
  const review=frames.filter(x=>x.type==='control').at(-1);
  assert.equal(review.phase,'return_review',review.reason);
  assert.equal(review.owned,true);
  assert.equal(review.returnReview?.workspaceRelativeDirectories.length,1);
  assert.equal(f.core.leases.available({taskId:task.id}),false,'review cannot start a provider turn');
  await f.core.terminal.frame(owner.ctx,{v:1,type:'return-confirm',reviewId:review.returnReview.reviewId,
    expectedGeneration:review.generation},owner.send);
  const returned = frames.filter(x => x.type === 'control').at(-1);
  assert.equal(returned.phase, 'ai_ready', returned.reason);
  assert.equal(f.core.leases.available({ taskId: task.id }), true,
    'fake provider may reserve only after a proved park');
  const parked = await execAsync('/bin/ps', ['-p', String(originalPid), '-o', 'stat='], { timeout: 5000 });
  assert.match(parked.stdout.trim(), /^[Tt]/, 'the original shell is really stopped');
  const lateMarker = join(f.workspace, 'parked-old-input.txt');
  await f.run('send-keys', '-t', record.tmux.relayPaneId, `printf LATE > '${lateMarker}'`, 'Enter');
  await sleep(150);
  await assert.rejects(access(lateMarker), { code: 'ENOENT' },
    'external tmux input to the parked relay cannot reach the shell');

  const recovered = [], next = await openOwner(f.core, 'handoff-reacquire', recovered);
  await f.core.terminal.frame(next.ctx, { v: 1, type: 'takeover' }, next.send);
  assert.equal(recovered.filter(x => x.type === 'control').at(-1).phase, 'human');
  assert.equal(f.core.leases.available({ taskId: task.id }), false);
  await f.core.terminal.frame(next.ctx, { v: 1, type: 'select', epoch: 0,
    sessionRef: first.sessionRef }, next.send);
  const ready = recovered.filter(x => x.type === 'ready').at(-1);
  assert.deepEqual(ready?.sessionRef, first.sessionRef);
  assert.equal((await f.adapter.sessionPanes(first.sessionRef))[0].pid, record.tmux.relayPanePid);
  assert.equal(JSON.parse(await readFile(join(f.dataDir, 'terminal-managed-records',
    index.entries[0].directory, 'record.json'), 'utf8')).identities.shell.pid, originalPid);
  await sleep(150);
  await assert.rejects(access(lateMarker), { code: 'ENOENT' },
    'old tmux input is never replayed when the same shell resumes');
  const marker = join(f.workspace, 'resumed-new-input.txt');
  await f.core.terminal.frame(next.ctx, { v: 1, type: 'input', epoch: ready.epoch, seq: 1,
    data: Buffer.from(`printf NEW > '${marker}'\n`).toString('base64') }, next.send);
  await until(async () => (await readFile(marker, 'utf8').catch(() => '')) === 'NEW');
});

test('a separately launched workspace writer keeps managed return unknown and AI fenced', async t => {
  const f=await fixture(t,true);if(!f)return;
  const frames=[],owner=await openOwner(f.core,'writer-owner',frames);
  await f.core.terminal.frame(owner.ctx,{v:1,type:'takeover'},owner.send);
  await f.core.terminal.frame(owner.ctx,{v:1,type:'create',epoch:0,name:'writer-original'},owner.send);
  const task=f.core.store.createTask({projectId:f.project.id,title:'External writer guard',executionProvider:'fake'});
  const writer=spawn('/bin/sleep',['30'],{cwd:f.workspace,stdio:'ignore'});
  try{
    await new Promise((resolve,reject)=>{writer.once('spawn',resolve);writer.once('error',reject);});
    await sleep(150);
    await f.core.terminal.frame(owner.ctx,{v:1,type:'return'},owner.send);
    const returned=frames.filter(frame=>frame.type==='control').at(-1);
    assert.equal(returned.phase,'unknown');
    assert.equal(f.core.leases.available({taskId:task.id}),false);
  }finally{
    const exited=new Promise(resolve=>writer.once('exit',resolve));
    writer.kill('SIGTERM');
    await exited;
  }
});

test('tampered original birth freezes recovery and never adopts a replacement session', async t => {
  const f = await fixture(t, true); if (!f) return;
  const frames = [], owner = await openOwner(f.core, 'tamper-owner', frames);
  await f.core.terminal.frame(owner.ctx, { v: 1, type: 'takeover' }, owner.send);
  await diagnosed(t, () => f.core.terminal.frame(owner.ctx,
    { v: 1, type: 'create', epoch: 0, name: 'original' }, owner.send));
  const ref = frames.filter(x => x.type === 'ready').at(-1).sessionRef;
  const index = JSON.parse(f.core.store.db.prepare('SELECT value FROM metadata WHERE key=?')
    .get('terminal.managed-panes.v1').value);
  const recordPath = join(f.dataDir, 'terminal-managed-records', index.entries[0].directory, 'record.json');
  const original = await readFile(recordPath, 'utf8'), record = JSON.parse(original);
  await f.core.close(); f.core = null;
  await writeFile(recordPath, JSON.stringify({ ...record, identities: { ...record.identities,
    shell: { ...record.identities.shell, ...(process.platform === 'linux'
      ? { startTicks: (BigInt(record.identities.shell.startTicks) + 1n).toString() }
      : { startUsec: (record.identities.shell.startUsec + 1) % 1000000 }) } } }),
  { mode: 0o600 });
  try {
    f.core = await createCore({ dataDir: f.dataDir, pluginDir: join(f.root, 'plugins'),
      files: false, managedPythonPath: pythonPath });
    const recoveredFrames = [], recovered = await openOwner(f.core, 'tampered-recovery', recoveredFrames);
    await f.core.terminal.frame(recovered.ctx, { v: 1, type: 'reconcile-control', action: 'acquire',
      sessionRef: ref, requestId: 'tampered' }, recovered.send);
    assert.equal(recoveredFrames.some(x => x.type === 'control' && x.phase === 'human' && x.owned), false);
    await assert.rejects(f.core.terminal.frame(recovered.ctx, { v: 1, type: 'create', epoch: 0,
      name: 'replacement' }, recovered.send));
    assert.equal((await f.adapter.list()).sessions.length, 1);
  } finally { await writeFile(recordPath, original, { mode: 0o600 }); }
});

test('registry write failure after shell start preserves the intent and rejects a second start', async t => {
  const f = await fixture(t); if (!f) return;
  const frames = [], owner = await openOwner(f.core, 'failure-owner', frames);
  await f.core.terminal.frame(owner.ctx, { v: 1, type: 'takeover' }, owner.send);
  f.core.store.db.exec(`CREATE TRIGGER reject_managed_started BEFORE INSERT ON metadata
    WHEN NEW.key='terminal.managed-panes.v1' AND json_extract(NEW.value,'$.entries[0].status')='started'
    BEGIN SELECT RAISE(ABORT,'controlled registry write failure'); END;`);
  await assert.rejects(f.core.terminal.frame(owner.ctx, { v: 1, type: 'create', epoch: 0,
    name: 'first' }, owner.send), { code: 'MANAGED_PANE_UNKNOWN' });
  const index = JSON.parse(f.core.store.db.prepare('SELECT value FROM metadata WHERE key=?')
    .get('terminal.managed-panes.v1').value);
  assert.equal(index.entries.length, 1);
  assert.ok(['intent', 'unknown'].includes(index.entries[0].status));
  const record = JSON.parse(await readFile(join(f.dataDir, 'terminal-managed-records',
    index.entries[0].directory, 'record.json'), 'utf8'));
  assert.equal(record.status, 'started');
  assert.equal((await f.adapter.list()).sessions.length, 1);
  assert.equal(f.core.terminal.blocksProject(f.project.id), true);
  const control = JSON.parse(f.core.store.db.prepare('SELECT value FROM metadata WHERE key=?')
    .get('terminal.control.v1').value);
  assert.equal(control.entries[f.project.id].phase, 'unknown');
  const task = f.core.store.createTask({ projectId: f.project.id, title: 'No AI after unknown managed pane' });
  assert.equal(f.core.leases.available({ taskId: task.id }), false);
  if (process.platform === 'linux') {
    const recorded = (await f.adapter.list()).sessions[0].sessionRef;
    await f.core.terminal.frame(owner.ctx, { v: 1, type: 'takeover-existing', sessionRefs: [recorded] }, owner.send);
    assert.equal(frames.some(frame => frame.type === 'control' && frame.phase === 'human' &&
      frame.mode === 'existing' && frame.owned), false,
    'a recorded managed pane cannot bypass the unknown fence through takeover-existing');
    assert.equal(f.core.terminal.blocksProject(f.project.id), true);
    assert.equal(f.core.leases.available({ taskId: task.id }), false);
  }
  await assert.rejects(f.core.terminal.frame(owner.ctx, { v: 1, type: 'open', mode: 'shell',
    cols: 80, rows: 24 }, owner.send), { code: 'MANAGED_PANE_UNKNOWN' });
  await assert.rejects(f.core.terminal.frame(owner.ctx, { v: 1, type: 'create', epoch: 0,
    name: 'second' }, owner.send), { code: 'MANAGED_PANE_UNKNOWN' });
  assert.equal((await f.adapter.list()).sessions.length, 1);
  f.core.store.db.exec('DROP TRIGGER reject_managed_started');
  await f.restart();
  const afterFrames = [], after = await openOwner(f.core, 'failure-restart', afterFrames);
  await assert.rejects(f.core.terminal.frame(after.ctx, { v: 1, type: 'create', epoch: 0,
    name: 'third' }, after.send), { code: 'MANAGED_PANE_UNKNOWN' });
  assert.equal(f.core.terminal.blocksProject(f.project.id), true);
  assert.equal((await f.adapter.list()).sessions.length, 1);
});

test('legacy tmux without a private record remains unadopted after Core restart', async t => {
  const f = await fixture(t, true); if (!f) return;
  await f.run('new-session', '-d', '-s', 'legacy', '-c', f.workspace);
  const original = (await f.adapter.list()).sessions[0].sessionRef;
  await f.restart();
  const frames = [];
  const owner=await openOwner(f.core, 'legacy-view', frames);
  assert.equal(frames.filter(x => x.type === 'sessions').at(-1).items.length, 1);
  assert.equal(frames.some(x => x.type === 'ready'), false);
  if (process.platform === 'linux') {
    await f.core.terminal.frame(owner.ctx,{v:1,type:'takeover-existing',sessionRefs:[original]},owner.send);
    assert.equal(frames.some(x=>x.type==='control'&&x.phase==='human'&&x.owned),false);
    await f.core.terminal.frame(owner.ctx,{v:1,type:'reconcile-control',action:'acquire',
      sessionRef:original,requestId:'legacy-reconcile'},owner.send);
    assert.equal(frames.some(x=>x.type==='control'&&x.phase==='human'&&x.owned),false);
    await assert.rejects(f.core.terminal.frame(owner.ctx,{v:1,type:'select',epoch:0,sessionRef:original},owner.send));
  }
  assert.equal(f.core.store.db.prepare('SELECT value FROM metadata WHERE key=?')
    .get('terminal.managed-panes.v1'), undefined);
  assert.deepEqual((await f.adapter.list()).sessions[0].sessionRef, original);
});

test('Linux Core quiesces a real fake-protocol Codex subprocess before resuming the same managed shell',
  { skip: process.platform !== 'linux' }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'seqivo-linux-codex-core-'));
    const dataDir = join(root, 'data'), workspace = join(root, 'workspace');
    await mkdir(dataDir); await mkdir(workspace);
    const controller = fileURLToPath(new URL('./fixtures/linux-managed-codex-controller.mjs', import.meta.url));
    const child = spawn(process.execPath, [controller, root, dataDir, workspace], {
      cwd: workspace, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-8192); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(code, 0, `Linux fake Codex Core fixture failed: ${stderr || stdout}`);
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(result.phase, 'human');
    assert.ok(result.bridgePid > 1);
    assert.ok(result.appServerPid > 1);
    assert.ok(result.shellPid > 1);
    await rm(root, { recursive: true, force: true });
  });

test('old archive cannot erase a live managed pane fence before restore', async t => {
  const f = await fixture(t); if (!f) return;
  const task = f.core.store.createTask({ projectId: f.project.id, title: 'Archive fence' });
  const archive = await f.core.request('GET', '/api/backup');
  const frames = [], owner = await openOwner(f.core, 'archive-owner', frames);
  await f.core.terminal.frame(owner.ctx, { v: 1, type: 'takeover' }, owner.send);
  await diagnosed(t, () => f.core.terminal.frame(owner.ctx,
    { v: 1, type: 'create', epoch: 0, name: 'archive-original' }, owner.send));
  const ready = frames.filter(x => x.type === 'ready').at(-1);
  assert.ok(ready?.sessionRef);
  const originalPid = (await f.adapter.sessionPanes(ready.sessionRef))[0].pid;
  f.core.terminal.disconnect(owner.ctx.connectionId, 0);
  await until(() => !f.core.terminal.hasConnections());
  await assert.rejects(f.core.request('POST', '/api/backup/restore', { confirm: true, archive }),
    { code: 'MANAGED_PANE_UNKNOWN' });
  await assert.rejects(f.core.request('POST', '/api/maintenance/replay', { confirm: true }),
    { code: 'MANAGED_PANE_UNKNOWN' });
  assert.equal((await f.adapter.sessionPanes(ready.sessionRef))[0].pid, originalPid);
  assert.equal(f.core.leases.available({ taskId: task.id }), false);
});

test('restart fences a live private pane when a restored database omitted its index', async t => {
  const f = await fixture(t); if (!f) return;
  const task = f.core.store.createTask({ projectId: f.project.id, title: 'Missing index fence' });
  const archive = await f.core.request('GET', '/api/backup');
  const frames = [], owner = await openOwner(f.core, 'missing-index-owner', frames);
  await f.core.terminal.frame(owner.ctx, { v: 1, type: 'takeover' }, owner.send);
  await f.core.terminal.frame(owner.ctx, { v: 1, type: 'create', epoch: 0, name: 'original' }, owner.send);
  const ref = frames.filter(x => x.type === 'ready').at(-1).sessionRef;
  const originalPid = (await f.adapter.sessionPanes(ref))[0].pid;
  await f.core.close(); f.core = null;
  // Simulate an offline/older backup replacement that bypassed the Core API.
  // The surviving private record must still fence the next Core startup.
  const offline = new Store(join(f.dataDir, 'board.sqlite'));
  try { offline.restoreArchive(archive); } finally { offline.close(); }
  f.core = await createCore({ dataDir: f.dataDir, pluginDir: join(f.root, 'plugins'),
    files: false, managedPythonPath: pythonPath });
  f.core.store.bindDirectory(f.project.id, { directory: f.workspace });
  assert.equal(f.core.terminal.blocksProject(f.project.id), true);
  assert.equal(f.core.leases.available({ taskId: task.id }), false);
  assert.equal((await f.adapter.sessionPanes(ref))[0].pid, originalPid);
});

test('damaged index or unindexed private directory freezes execution without adopting it', async t => {
  const f = await fixture(t); if (!f) return;
  const task = f.core.store.createTask({ projectId: f.project.id, title: 'Damaged index fence' });
  const recordRoot = join(f.dataDir, 'terminal-managed-records');
  const extra = join(recordRoot, 'seqivo-pane-record-UNINDEXED');
  await mkdir(extra, { mode: 0o700 });
  await f.restart();
  assert.equal(f.core.terminal.blocksProject(f.project.id), true);
  assert.equal(f.core.leases.available({ taskId: task.id }), false);
  await rm(extra, { recursive: true, force: true });
  f.core.store.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)')
    .run('terminal.managed-panes.v1', '{damaged');
  await f.core.close(); f.core = null;
  f.core = await createCore({ dataDir: f.dataDir, pluginDir: join(f.root, 'plugins'),
    files: false, managedPythonPath: pythonPath });
  assert.equal(f.core.terminal.blocksProject(f.project.id), true);
  assert.equal(f.core.leases.available({ taskId: task.id }), false);
});

test('restore rejects an incoming managed index even when the current record root is empty', async t => {
  const f = await fixture(t); if (!f) return;
  const cleanArchive = await f.core.request('GET', '/api/backup');
  f.core.store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)')
    .run('terminal.managed-panes.v1', JSON.stringify({ version: 1, entries: [{}] }));
  await assert.rejects(f.core.request('POST', '/api/backup/restore',
    { confirm: true, archive: cleanArchive }), { code: 'MANAGED_PANE_UNKNOWN' });
  const archive = await f.core.request('GET', '/api/backup');
  f.core.store.db.prepare('DELETE FROM metadata WHERE key=?').run('terminal.managed-panes.v1');
  await assert.rejects(f.core.request('POST', '/api/backup/restore', { confirm: true, archive }),
    { code: 'MANAGED_PANE_UNKNOWN' });
});

test('restore await boundary cannot issue a new execution lease before metadata replacement', async t => {
  const f = await fixture(t); if (!f) return;
  const task = f.core.store.createTask({ projectId: f.project.id, title: 'Restore reservation race',
    conversationId: 'isolated-thread', executionProvider: 'fake' });
  const archive = await f.core.request('GET', '/api/backup');
  const originalState = f.core.plugin.state;
  let entered, release;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.core.plugin.state = async () => { entered(); await gate; return originalState(); };
  const restoring = f.core.request('POST', '/api/backup/restore', { confirm: true, archive });
  await reached;
  const available = f.core.leases.available({ taskId: task.id });
  const executionBlocked = f.core.terminal.blocksProject(f.project.id);
  let reserved = false, reserveError;
  try { f.core.leases.reserve({ taskId: task.id, commandId: 'race', provider: 'fake' }); reserved = true; }
  catch (error) { reserveError = error; }
  release();
  try { await restoring; } finally { f.core.plugin.state = originalState; }
  assert.equal(available, false);
  assert.equal(executionBlocked, true);
  assert.equal(reserved, false);
  assert.equal(reserveError?.code, 'MANAGED_PANE_UNKNOWN');
  assert.equal(f.core.leases.state().active.length, 0);
  assert.equal(f.core.terminal.blocksProject(f.project.id), false);
});
