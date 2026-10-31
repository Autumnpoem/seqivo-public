import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { createCore } from '../server/core.mjs';
import { startHttp } from '../server/http.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('shutdown cancels a pending conversation, rejects new work and releases the verified lock', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seqivo-shutdown-'));
  const dataDir = join(root, 'data'), pluginDir = join(root, 'plugins');
  const extension = join(pluginDir, 'codex-autocontinue');
  const reading = join(root, 'reading'), sent = join(root, 'sent');
  await mkdir(extension, { recursive: true });
  await writeFile(join(extension, 'plugin.json'), JSON.stringify({
    id: 'codex-autocontinue', name: 'Fake held read', version: '1', apiVersion: 1,
    entry: 'host.mjs', permissions: ['task.read', 'task.resume'], capabilities: ['task.resume'],
  }));
  await writeFile(join(extension, 'host.mjs'), `
import {writeFile} from 'node:fs/promises';
export function createPlugin(){
  let release;
  const state=()=>({id:'codex-autocontinue',enabled:false,available:true,status:'idle',policies:[]});
  return {state,configure:async()=>state(),enable:async()=>state(),disable:async()=>state(),check:async()=>state(),
    conversation:async({taskId})=>{const held=new Promise(resolve=>{release=resolve;});await writeFile(${JSON.stringify(reading)},'yes');await held;return {taskId,status:'planned',messages:[]};},
    resume:async()=>{await writeFile(${JSON.stringify(sent)},'sent');return {status:'running'};},
    close:async()=>{release?.();}};
}
`);
  const stages = [];
  let core = await createCore({ dataDir, pluginDir, files: false, onShutdown: event => {
    stages.push(event);
    if (event.stage === 'tick') throw Error('diagnostic sink unavailable');
  } });
  t.after(async () => { await core?.close().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  const project = core.store.project({ name: 'Disposable', directory: root });
  const task = core.store.createTask({ projectId: project.id, title: 'Held read', conversationId: 'owned-fake-thread' });
  const pendingRead = core.request('GET', `/api/tasks/${task.id}/conversation`).catch(error => error);
  const markerDeadline = Date.now() + 3000;
  while (Date.now() < markerDeadline) { try { await access(reading); break; } catch { await sleep(20); } }
  await access(reading);
  const started = Date.now();
  const closing = core.close();
  await assert.rejects(core.request('POST', `/api/tasks/${task.id}/continue`, { expectedRevision: task.revision, commandId: 'late' }),
    error => error.code === 'SHUTTING_DOWN');
  let deadlineTimer;
  try { await Promise.race([closing, new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => reject(Error('shutdown exceeded five seconds')), 5000);
  })]); }
  finally { clearTimeout(deadlineTimer); }
  assert.ok(Date.now() - started < 5000);
  await pendingRead;
  await assert.rejects(access(sent), error => error.code === 'ENOENT');
  await assert.rejects(access(join(dataDir, 'core.lock')), error => error.code === 'ENOENT');
  for (const stage of ['conversations', 'plugins', 'remote', 'workflow', 'file_bridge', 'tick', 'active_requests']) {
    assert.deepEqual(stages.filter(event => event.stage === stage).map(event => event.status), ['started', 'fulfilled']);
  }
  core = await createCore({ dataDir, pluginDir, files: false });
  await core.close();
});

test('HTTP shutdown closes an incomplete request body without waiting for its client', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seqivo-http-shutdown-'));
  const core = { events: new EventEmitter(), request: async () => ({ ok: true }) };
  const http = await startHttp({ core, dataDir: root, distDir: root, port: 0 });
  const socket = connect(http.port, '127.0.0.1');
  t.after(async () => { socket.destroy(); await http.close(); await rm(root, { recursive: true, force: true }); });
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(`POST /api/state HTTP/1.1\r\nHost: 127.0.0.1:${http.port}\r\nAuthorization: Bearer ${http.tokens.owner}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  await sleep(30);
  await Promise.race([http.close(), sleep(1000).then(() => { throw Error('HTTP shutdown waited for an incomplete request body'); })]);
});

test('HTTP shutdown waits for an already dispatched write to finish', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seqivo-http-write-'));
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const core = { events: new EventEmitter(), request: async () => { entered(); await pending; return { saved: true }; } };
  const http = await startHttp({ core, dataDir: root, distDir: root, port: 0 });
  t.after(async () => { release(); await http.close(); await rm(root, { recursive: true, force: true }); });
  const response = fetch(`http://127.0.0.1:${http.port}/api/state`, { headers: { Authorization: `Bearer ${http.tokens.owner}` } });
  await started;
  let closed = false;
  const closing = http.close().then(() => { closed = true; });
  await sleep(30);
  assert.equal(closed, false);
  release();
  assert.deepEqual(await (await response).json(), { saved: true });
  await closing;
});

test('HTTP shutdown preserves an earlier response when the same socket has a partial next body', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seqivo-http-pipeline-'));
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const core = { events: new EventEmitter(), request: async () => { entered(); await pending; return { saved: true }; } };
  const http = await startHttp({ core, dataDir: root, distDir: root, port: 0 });
  const socket = connect(http.port, '127.0.0.1');
  t.after(async () => { release(); socket.destroy(); await http.close(); await rm(root, { recursive: true, force: true }); });
  let received = '';
  socket.on('data', chunk => { received += chunk.toString(); });
  const clientClosed = new Promise(resolve => socket.once('close', resolve));
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(`GET /api/state HTTP/1.1\r\nHost: 127.0.0.1:${http.port}\r\nAuthorization: Bearer ${http.tokens.owner}\r\n\r\n`);
  await started;
  socket.write(`POST /api/state HTTP/1.1\r\nHost: 127.0.0.1:${http.port}\r\nAuthorization: Bearer ${http.tokens.owner}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  await sleep(30);
  const closing = http.close();
  release();
  await Promise.race([closing, sleep(1000).then(() => { throw Error('HTTP shutdown held a pipelined partial body'); })]);
  await clientClosed;
  assert.match(received, /"saved":true/);
});
