import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTerminalRuntime, TerminalRuntimeError } from '../server/terminal/runtime.mjs';

function temporaryDirectory(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'seqivo-pty-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function withTimeout(promise, ms = 5000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PTY timed out')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

test('PTY rejects invalid shell, cwd, arguments and size before spawn', t => {
  const cwd = temporaryDirectory(t);
  assert.throws(() => createTerminalRuntime({ shell: '/bin/sh', cwd: 'relative' }), { code: 'INVALID_CWD' });
  assert.throws(() => createTerminalRuntime({ shell: 'sh', cwd }), { code: 'INVALID_SHELL' });
  assert.throws(() => createTerminalRuntime({ shell: '/bin/sh', cwd, args: ['bad\0arg'] }), { code: 'INVALID_ARGS' });
  assert.throws(() => createTerminalRuntime({ shell: '/bin/sh', cwd, cols: 0 }), { code: 'INVALID_SIZE' });
  assert.equal(new TerminalRuntimeError('EXAMPLE', 'message').code, 'EXAMPLE');
});

test('real PTY streams bounded output and reports child exit', { skip: process.platform !== 'darwin' }, async t => {
  const cwd = temporaryDirectory(t);
  const chunks = [];
  let resolveExit;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  const terminal = createTerminalRuntime({
    shell: '/bin/sh', cwd, cols: 80, rows: 24, maxChunkBytes: 64,
    onData: chunk => chunks.push(chunk),
    onExit: resolveExit,
  });
  t.after(async () => { await terminal.close().catch(() => {}); });
  assert.ok(terminal.pid > 0);
  terminal.resize(90, 30);
  terminal.write("pwd; printf '%01024d' 0; exit\n");
  const result = await withTimeout(exited);
  assert.equal(result.exitCode, 0);
  assert.ok(chunks.every(chunk => Buffer.byteLength(chunk) <= 64));
  assert.match(chunks.join(''), new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(chunks.join(''), /0{100}/);
  await terminal.close();
  assert.throws(() => terminal.write('x'), { code: 'TERMINAL_CLOSED' });
});

test('closing real PTY ends only its owned child', { skip: process.platform !== 'darwin' }, async t => {
  const cwd = temporaryDirectory(t);
  const terminal = createTerminalRuntime({ shell: '/bin/sh', cwd, cols: 80, rows: 24 });
  const result = await withTimeout(terminal.close());
  assert.equal(typeof result.exitCode, 'number');
  assert.throws(() => terminal.resize(80, 24), { code: 'TERMINAL_CLOSED' });
});
