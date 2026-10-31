import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Packaging checks can exercise the bundled entry with its own Node executable.
const sidecar = process.env.SEQIVO_TEST_SIDECAR || fileURLToPath(new URL('../server/sidecar.mjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitUntil(check, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = check();
    if (result) return result;
    await sleep(15);
  }
  throw Error(`Timed out waiting for ${label}`);
}

async function fixture(t, mode) {
  const root = await mkdtemp(join(tmpdir(), 'seqivo-sidecar-shutdown-'));
  const dataDir = join(root, 'data');
  const pluginDir = join(root, 'plugins');
  const plugin = join(pluginDir, 'shutdown-fixture');
  const marker = join(root, 'plugin-close-finished');
  const closeStarted = join(root, 'plugin-close-started');
  const closeRelease = join(root, 'plugin-close-release');
  await mkdir(plugin, { recursive: true });
  await writeFile(join(plugin, 'plugin.json'), JSON.stringify({
    id: 'shutdown-fixture', name: 'Shutdown fixture', version: '1', apiVersion: 1, entry: 'host.mjs',
  }));
  const closeBody = mode === 'failure'
    ? `throw Error('PRIVATE_FIXTURE_SECRET termination unconfirmed')`
    : mode === 'slow'
      ? `await writeFile(${JSON.stringify(closeStarted)},'started');
         for(let attempt=0;attempt<150&&!existsSync(${JSON.stringify(closeRelease)});attempt++)
           await new Promise(resolve=>setTimeout(resolve,20));
         if(!existsSync(${JSON.stringify(closeRelease)}))throw Error('fixture release timed out');
         await writeFile(${JSON.stringify(marker)},'finished')`
      : `await writeFile(${JSON.stringify(marker)},'finished')`;
  await writeFile(join(plugin, 'host.mjs'), `
import {writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
export async function createPlugin(){
  ${mode === 'startup-shutdown' ? 'await new Promise(resolve=>setTimeout(resolve,350));' : ''}
  const state=()=>({enabled:false,available:true,status:'idle'});
  return {state,configure:state,enable:state,disable:state,check:state,
    close:async()=>{${closeBody}}};
}`);
  const child = spawn(process.execPath, [sidecar, dataDir, pluginDir], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env },
  });
  const frames = [];
  let stdout = '', stderr = '', exit, closed = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
    let newline;
    while ((newline = stdout.indexOf('\n')) !== -1) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      frames.push({ ...frame, markerPresentAtReceipt: frame.event === 'shutdown-complete' && existsSync(marker) });
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  child.once('close', () => { closed = true; });
  t.after(async () => {
    if (!exit) {
      child.kill('SIGTERM');
      try { await waitUntil(() => exit, 'test sidecar exit after SIGTERM', 2_000); }
      catch {
        child.kill('SIGKILL');
        await waitUntil(() => exit, 'test sidecar exit after SIGKILL', 2_000);
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  // A native quit during boot is already in stdin before the sidecar installs
  // its line handler. It must still be handled once after initialization.
  if (mode === 'startup-shutdown') child.stdin.write('{"event":"shutdown"}\n{"event":"shutdown"}\n');
  await waitUntil(() => frames.some(frame => frame.event === 'ready') || exit, 'sidecar ready');
  assert.equal(exit, undefined, `sidecar exited before ready: ${stderr}`);
  return {
    child, frames, marker, closeStarted, closeRelease, dataDir,
    get stderr() { return stderr; },
    get exit() { return exit; },
    shutdown() { child.stdin.write('{"event":"shutdown"}\n'); },
    async waitExit() { await waitUntil(() => closed, 'sidecar stdio close'); return exit; },
  };
}

function stages(dataDir) {
  return readFileSync(join(dataDir, 'shutdown-stages.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

test('successful sidecar shutdown emits one flushed receipt only after Core and HTTP close', async t => {
  const run = await fixture(t, 'success');
  run.shutdown();
  run.shutdown();
  assert.deepEqual(await run.waitExit(), { code: 0, signal: null });
  const receipts = run.frames.filter(frame => frame.event === 'shutdown-complete');
  assert.equal(receipts.length, 1);
  assert.deepEqual({ event: receipts[0].event }, { event: 'shutdown-complete' });
  assert.equal(receipts[0].markerPresentAtReceipt, true);
  const events = stages(run.dataDir);
  for (const name of ['core', 'http']) {
    assert.deepEqual(events.filter(item => item.stage === name).map(item => item.status), ['started', 'fulfilled']);
  }
  await assert.rejects(readFile(join(run.dataDir, 'core.lock')), { code: 'ENOENT' });
});

test('failed plugin close exits unsuccessfully without a receipt and retains unsafe lock', async t => {
  const run = await fixture(t, 'failure');
  run.shutdown();
  assert.deepEqual(await run.waitExit(), { code: 1, signal: null });
  assert.equal(run.frames.filter(frame => frame.event === 'shutdown-complete').length, 0);
  assert.equal(JSON.parse(await readFile(join(run.dataDir, 'core.lock'), 'utf8')).uncleanShutdown, true);
  assert.deepEqual(stages(run.dataDir).filter(item => item.stage === 'core').map(item => item.status), ['started', 'rejected']);
  assert.match(run.stderr, /关闭任务服务失败/);
  assert.doesNotMatch(run.stderr, /PRIVATE_FIXTURE_SECRET/);
});

test('slow finite plugin close prevents early receipt and exit', async t => {
  const run = await fixture(t, 'slow');
  run.shutdown();
  await waitUntil(() => existsSync(run.closeStarted), 'fixture plugin close started');
  assert.equal(existsSync(run.marker), false);
  assert.equal(run.exit, undefined);
  assert.equal(run.frames.filter(frame => frame.event === 'shutdown-complete').length, 0);
  await writeFile(run.closeRelease, 'release');
  assert.deepEqual(await run.waitExit(), { code: 0, signal: null });
  assert.equal(await readFile(run.marker, 'utf8'), 'finished');
  assert.equal(run.frames.filter(frame => frame.event === 'shutdown-complete').length, 1);
  assert.equal(run.frames.find(frame => frame.event === 'shutdown-complete').markerPresentAtReceipt, true);
});

test('quit queued before delayed startup closes once and keeps bounded phase diagnostics', async t => {
  const run = await fixture(t, 'startup-shutdown');
  assert.deepEqual(await run.waitExit(), {code:0,signal:null});
  assert.equal(run.frames.filter(frame=>frame.event==='shutdown-complete').length,1);
  assert.ok(run.frames.findIndex(frame=>frame.event==='ready') < run.frames.findIndex(frame=>frame.event==='shutdown-complete'));
  assert.equal(run.frames.find(frame=>frame.event==='shutdown-complete').markerPresentAtReceipt,true);
  const diagnostic=JSON.parse(await readFile(join(run.dataDir,'startup.json'),'utf8'));
  assert.equal(diagnostic.stage,'closed');
  assert.ok(diagnostic.stages.length<=24);
  assert.deepEqual(diagnostic.stages.map(item=>item.stage),[
    'preview-runtime-check','core-start','database','plugins','files-started','workflow','core-ready','http-start','ready','closing','closed',
  ]);
  for(let index=0;index<diagnostic.stages.length;index++){
    const item=diagnostic.stages[index];
    assert.deepEqual(Object.keys(item).sort(),['elapsedMs','stage']);
    assert.ok(item.elapsedMs >= (diagnostic.stages[index-1]?.elapsedMs ?? 0));
  }
  assert.ok(diagnostic.stages.find(item=>item.stage==='plugins').elapsedMs>=300);
  await assert.rejects(readFile(join(run.dataDir,'core.lock')), {code:'ENOENT'});
});
