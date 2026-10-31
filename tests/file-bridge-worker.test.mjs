import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { mkdtemp, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { FileBridge } from '../server/files.mjs';

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'seqivo-file-worker-'));
  const dir = await realpath(temp);
  const store = new Store(join(dir, 'board.sqlite'));
  const project = store.project({ name: 'file worker', directory: dir });
  const task = store.createTask({ projectId: project.id, title: 'task', criteria: [] });
  const bridge = new FileBridge(store);
  t.after(async () => {
    bridge.close();
    await bridge.pause().catch(() => {});
    store.close();
    await rm(temp, { recursive: true, force: true });
  });
  return { dir, store, project, task, bridge };
}

async function until(predicate, message) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function blockedWorkerFixture(t) {
  if (process.platform === 'win32' || !existsSync('/usr/bin/mkfifo')) {
    t.skip('FIFO open fault injection requires POSIX mkfifo');
    return null;
  }
  const fixtureState = await fixture(t);
  const { dir, bridge } = fixtureState;
  const fifo = join(dir, 'blocked-fs-open');
  const marker = join(dir, 'unblocked-marker');
  const made = spawnSync('/usr/bin/mkfifo', [fifo], { encoding: 'utf8' });
  assert.equal(made.status, 0, 'mkfifo fixture must succeed');
  const worker = join(dir, 'blocked-worker.mjs');
  // The same child program is used by both positive and stopped cases.
  // Dispatch the filesystem operation before acknowledging the list RPC.
  await writeFile(worker, [
    "import { open, writeFile } from 'node:fs/promises';",
    'process.on(\'message\', async message => {',
    "  if (message.op !== 'list') { process.send({ id: message.id, result: true }); return; }",
    '  const pendingOpen = open(' + JSON.stringify(fifo) + ", 'r');",
    "  process.send({ probe: 'open-dispatched' });",
    '  const handle = await pendingOpen;',
    '  await handle.close();',
    '  await writeFile(' + JSON.stringify(marker) + ", 'once');",
    "  process.send({ probe: 'completed' });",
    '  process.send({ id: message.id, result: [] });',
    '});',
  ].join('\n'));
  bridge.workerUrl = worker;
  const tick = bridge.tick();
  const child = bridge.worker;
  assert.equal(child?.pid > 0, true);
  const probes = [];
  child.on('message', message => { if (typeof message?.probe === 'string') probes.push(message.probe); });
  await until(() => probes.includes('open-dispatched'), 'child did not reach FIFO open');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(bridge.busy, true, 'child remains blocked until FIFO release');
  assert.equal(probes.includes('completed'), false);
  return { ...fixtureState, fifo, marker, child, probes, tick };
}

async function releaseFifo(fifo) {
  // O_RDWR|O_NONBLOCK cannot hang even after the reader has been killed.
  const handle = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
  await handle.close();
}

test('worker imports once, writes an atomic receipt and exports current context', async t => {
  const { dir, store, task, bridge } = await fixture(t);
  const inbox = join(dir, '.taskboard', 'inbox');
  await mkdir(inbox, { recursive: true });
  await writeFile(join(inbox, 'event.json'), JSON.stringify({
    eventId: 'worker-event', type: 'task.update', taskId: task.id,
    expectedRevision: task.revision, payload: { summary: 'one import' },
  }));
  await bridge.tick();
  await bridge.tick();
  assert.equal(store.getTask(task.id).revision, 2);
  assert.match(await readFile(join(dir, '.taskboard', 'CONTEXT.md'), 'utf8'), /one import/);
  assert.equal(bridge.worker?.pid > 0, true);
  const files = await import('node:fs/promises').then(fs => fs.readdir(join(dir, '.taskboard', 'receipts')));
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(await readFile(join(dir, '.taskboard', 'receipts', files[0]), 'utf8')).status, 'accepted');
  await bridge.pause();
  assert.equal(bridge.worker, null);
});

test('releasing the FIFO lets the same blocked child complete exactly once (positive control)', async t => {
  const state = await blockedWorkerFixture(t);
  if (!state) return;
  const { bridge, child, fifo, marker, probes, store, task, tick } = state;
  await releaseFifo(fifo);
  await tick;
  assert.equal(await readFile(marker, 'utf8'), 'once');
  assert.equal(probes.filter(probe => probe === 'completed').length, 1);
  assert.equal(store.getTask(task.id).revision, 1);
  assert.equal(bridge.worker, child);
});

test('close proves exit of the blocked child; later FIFO release cannot write or apply', async t => {
  const state = await blockedWorkerFixture(t);
  if (!state) return;
  const { bridge, child, fifo, marker, probes, store, task, tick } = state;
  bridge.close();
  await bridge.pause({ timeoutMs: 2000 });
  await tick;
  assert.equal(bridge.worker, null);
  assert.equal(child.signalCode, 'SIGTERM');
  assert.equal(store.getTask(task.id).revision, 1);
  await releaseFifo(fifo);
  await new Promise(resolve => setTimeout(resolve, 30));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.equal(probes.includes('completed'), false);
  assert.equal(store.getTask(task.id).revision, 1);
});

test('pause and resume start a fresh worker without replaying an imported event', async t => {
  const { dir, store, task, bridge } = await fixture(t);
  const inbox = join(dir, '.taskboard', 'inbox');
  await mkdir(inbox, { recursive: true });
  await writeFile(join(inbox, 'first.json'), JSON.stringify({
    eventId: 'first-event', type: 'task.update', taskId: task.id,
    expectedRevision: 1, payload: { summary: 'first' },
  }));
  await bridge.tick();
  const first = bridge.worker;
  assert.equal(store.getTask(task.id).revision, 2);
  await bridge.pause();
  assert.equal(bridge.worker, null);
  assert.equal(first.signalCode, 'SIGTERM');
  await writeFile(join(inbox, 'second.json'), JSON.stringify({
    eventId: 'second-event', type: 'task.update', taskId: task.id,
    expectedRevision: 2, payload: { summary: 'second' },
  }));
  bridge.resume();
  await bridge.tick();
  assert.equal(store.getTask(task.id).revision, 3);
  assert.notEqual(bridge.worker?.pid, first.pid);
});

test('a child without proven exit keeps pause unknown and forbids resume or another worker', async t => {
  const { dir, bridge } = await fixture(t);
  await bridge.tick();
  const child = bridge.worker;
  assert.equal(child?.pid > 0, true);
  const kill = child.kill.bind(child);
  child.kill = () => true; // Model SIGTERM delivery without an exit observation.
  await assert.rejects(bridge.pause({ timeoutMs: 30 }), /未能在期限内停止/);
  child.kill = kill;
  assert.equal(bridge.unsafeStop, true);
  bridge.resume();
  assert.equal(bridge.paused, true);
  assert.equal(bridge.worker, child);
  assert.equal(bridge.worker.pid, child.pid);
  // Test-owned process cleanup, not a product fallback.
  child.kill('SIGTERM');
  await bridge.workerExit;
  assert.equal(bridge.worker, null);
  bridge.resume();
  assert.equal(bridge.paused, true);
  assert.equal(dir.length > 0, true);
});
