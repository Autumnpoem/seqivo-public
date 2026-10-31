import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, lstatSync, statSync, symlinkSync, unlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { Script, createContext } from 'node:vm';
import { createBridgeDiagnostics } from '../plugins/codex-autocontinue/bridge-diagnostics.mjs';

// Extract the actual private Bridge class; only its process, clock, and streams
// are replaced. This never launches a provider or a native task job.
const source = readFileSync(new URL('../plugins/codex-autocontinue/host.mjs', import.meta.url), 'utf8');
const start = source.indexOf('class Bridge {');
const end = source.indexOf('\n}\n\nexport ', start);
assert.ok(start >= 0 && end > start, 'Bridge source boundary changed');
assert.match(source.slice(end + 4), /^export /, 'Bridge must end before the next export');
const classSource = source.slice(start, end + 2);

function makeClock() {
  let next = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { const id = next++; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fire(ms) {
      const entry = [...timers].find(([, value]) => value.ms === ms);
      assert.ok(entry, `expected ${ms}ms watchdog`);
      timers.delete(entry[0]);
      entry[1].fn();
    },
  };
}

class MemoryJob {
  constructor(order = []) {
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.requests = [];
    this.stopCount = 0;
    this.order = order;
    let buffer = '';
    this.stdin.on('data', bytes => {
      buffer += bytes.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        this.requests.push(request);
        if (request.method === 'open') this.reply(request.id, { appServerPid: 12345 });
      }
    });
  }
  async spawn() { return { identity: { pid: 12344 }, stdin: this.stdin, stdout: this.stdout, stderr: this.stderr }; }
  async stop() {
    this.order.push('job.stop');
    this.stopCount++;
    this.stdin.destroy();
    return { verified: true, retired: true };
  }
  reply(id, result) { this.stdout.write(JSON.stringify({ id, result }) + '\n'); }
  error(id, type) { this.stdout.write(JSON.stringify({ id, error: { type, message: 'redacted' } }) + '\n'); }
}

function bridgeHarness({ diagnostic = () => {}, order = [], onExit = () => {} } = {}) {
  const clock = makeClock();
  const context = createContext({
    createInterface, pythonExecutable: () => '/fake/python',
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, process, console,
  });
  new Script(classSource + '\n;globalThis.ExtractedBridge = Bridge;').runInContext(context);
  const job = new MemoryJob(order);
  const bridge = new context.ExtractedBridge({
    pythonPath: '/fake/python', codexPath: '', pluginDir: '/fake', job,
    onEvent: () => {}, onExit, diagnostic,
  });
  return { bridge, job, clock };
}

test('ThreadReadTimeout records read budget, rejects only that read, and does not resend a turn', async () => {
  const events = [];
  const { bridge, job } = bridgeHarness({ diagnostic: event => events.push(event) });
  await bridge.open();
  const turn = bridge.request('turn', { threadId: 'thread-1' });
  job.reply(job.requests.at(-1).id, { turn: { id: 'turn-1' } });
  assert.equal((await turn).turn.id, 'turn-1');
  const read = bridge.request('thread', { threadId: 'thread-1' });
  job.error(job.requests.at(-1).id, 'ThreadReadTimeout');
  await assert.rejects(read, /ThreadReadTimeout/);
  assert.deepEqual(events.map(event => event.event), ['read_budget_exhausted']);
  assert.equal(events[0].method, 'thread');
  assert.equal(job.stopCount, 0);
  assert.equal(bridge.closing, false);
  const next = bridge.request('thread', { threadId: 'thread-1' });
  job.reply(job.requests.at(-1).id, { thread: { id: 'thread-1' } });
  assert.equal((await next).thread.id, 'thread-1');
  assert.equal(job.requests.filter(request => request.method === 'turn').length, 1);
});

test('request watchdog records first stop before job retirement; late reply and close do not overwrite it', async () => {
  const order = [];
  const events = [];
  const { bridge, job, clock } = bridgeHarness({
    order, diagnostic: event => { events.push(event); order.push(`diagnostic:${event.event}`); },
  });
  await bridge.open();
  const request = bridge.request('quota');
  const lateId = job.requests.at(-1).id;
  clock.fire(12000);
  await assert.rejects(request, /bridge timed out: quota/);
  await bridge.stopPromise;
  assert.deepEqual(order.slice(0, 2), ['diagnostic:first_stop', 'job.stop']);
  assert.deepEqual(events.filter(event => event.event === 'first_stop').map(event =>
    [event.reason, event.method, event.timeoutMs]), [['request_timeout', 'quota', 12000]]);
  job.reply(lateId, { quota: 'late' });
  job.stdout.end();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bridge.pending.size, 0);
  assert.equal(events.filter(event => event.event === 'first_stop').length, 1);
  assert.equal(job.stopCount, 1);
});

test('provider close, stdout close, explicit stop and throwing observation callback preserve lifecycle', async () => {
  const providerEvents = [];
  const provider = bridgeHarness({ diagnostic: event => providerEvents.push(event), onExit: () => {} });
  await provider.bridge.open();
  provider.job.stdout.write(JSON.stringify({ event: 'closed' }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(provider.bridge.dead, true);
  assert.deepEqual(providerEvents.filter(event => event.event === 'first_stop').map(event => event.reason), ['provider_closed']);
  provider.job.stdout.end();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(providerEvents.filter(event => event.event === 'first_stop').length, 1);

  const stdoutEvents = [];
  let exits = 0;
  const stdout = bridgeHarness({ diagnostic: event => stdoutEvents.push(event), onExit: () => { exits++; } });
  await stdout.bridge.open();
  stdout.job.stdout.end();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(exits, 1);
  assert.deepEqual(stdoutEvents.filter(event => event.event === 'first_stop').map(event => event.reason), ['stdout_closed']);

  const explicit = bridgeHarness({ diagnostic: () => { throw new Error('observation unavailable'); } });
  await explicit.bridge.open();
  assert.deepEqual(await explicit.bridge.stop(), { verified: true, retired: true });
  assert.equal(explicit.job.stopCount, 1);
  assert.equal(explicit.bridge.closing, true);
});

test('diagnostic writer allows only bounded enumerated fields in private rotating logs and refuses symlinks', t => {
  const root = mkdtempSync(join(tmpdir(), 'seqivo-bridge-diagnostics-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writer = createBridgeDiagnostics(root);
  const secret = 'credential-token-private';
  const pathSecret = '/private/project/secret/file';
  writer.record({ event: 'first_stop', bridgeId: 'bridge-1', recordId: 'record-1',
    reason: secret, method: pathSecret, timeoutMs: 90000, credential: secret, path: pathSecret });
  writer.record({ event: 'unexpected', bridgeId: secret });
  const dir = join(root, 'diagnostics');
  const current = join(dir, 'bridge-lifecycle.jsonl');
  assert.equal(lstatSync(dir).mode & 0o077, 0);
  assert.equal(statSync(current).mode & 0o077, 0);
  let rows = readFileSync(current, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]), ['at', 'event', 'bridge', 'record', 'reason', 'method', 'timeoutMs']);
  assert.equal(rows[0].bridge, createHash('sha256').update('bridge-1').digest('hex').slice(0, 24));
  assert.equal(rows[0].reason, null);
  assert.equal(rows[0].method, null);
  assert.equal(rows[0].timeoutMs, 60000);
  assert.ok(!readFileSync(current, 'utf8').includes(secret));
  assert.ok(!readFileSync(current, 'utf8').includes(pathSecret));

  for (let index = 0; index < 1200; index++)
    writer.record({ event: 'read_budget_exhausted', bridgeId: `bridge-${index}`, recordId: `record-${index}`, method: 'thread' });
  assert.deepEqual(readdirSync(dir).sort(), ['bridge-lifecycle.jsonl', 'bridge-lifecycle.jsonl.previous']);
  for (const name of readdirSync(dir)) {
    const stats = statSync(join(dir, name));
    assert.ok(stats.size <= 64 * 1024, `${name} exceeded 64 KiB`);
    assert.equal(stats.mode & 0o077, 0);
  }
  rows = readFileSync(current, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.length > 0);

  const victim = join(root, 'victim');
  writeFileSync(victim, 'unchanged', { mode: 0o600 });
  unlinkSync(current);
  symlinkSync(victim, current);
  writer.record({ event: 'first_stop', reason: 'explicit_stop' });
  assert.equal(readFileSync(victim, 'utf8'), 'unchanged');
  assert.equal(lstatSync(current).isSymbolicLink(), true);
});
