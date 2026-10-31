import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { prepareTerminalRuntime } from '../scripts/prepare-terminal-runtime.mjs';

const run = (binary, args, options = {}) => execFileSync(binary, args, {
  encoding: 'utf8', timeout: 5000, ...options,
}).trim();

test('unconfigured terminal packaging reports an unbundled capability', async () => {
  const result = await prepareTerminalRuntime('/tmp/seqivo-unused-test-resource', { executable: '' });
  assert.equal(result.bundled, false);
  assert.equal(result.reason, process.platform === 'darwin' ? 'NOT_CONFIGURED' : 'UNSUPPORTED_PLATFORM');
});

test('macOS tmux bundle runs after its source prefix is removed', {
  skip: process.platform !== 'darwin' || !process.env.TMUX_TEST_EXECUTABLE,
}, async t => {
  const sourceBinary = process.env.TMUX_TEST_EXECUTABLE;
  const licenses = {
    tmux: process.env.TMUX_TEST_TMUX_LICENSE,
    utf8proc: process.env.TMUX_TEST_UTF8PROC_LICENSE,
    jemalloc: process.env.TMUX_TEST_JEMALLOC_LICENSE,
    libevent: process.env.TMUX_TEST_LIBEVENT_LICENSE,
  };
  const root = mkdtempSync(join(tmpdir(), 'seqivo-pack-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourcePrefix = join(root, 'temporary-source');
  const sourceBin = join(sourcePrefix, 'bin', 'tmux');
  mkdirSync(join(sourcePrefix, 'bin'), { recursive: true });
  mkdirSync(join(sourcePrefix, 'lib'), { recursive: true });
  copyFileSync(sourceBinary, sourceBin);
  chmodSync(sourceBin, 0o755);
  const dependencies = run('/usr/bin/otool', ['-L', sourceBinary]).split('\n').slice(1)
    .map(line => line.match(/^\s+(.+?) \(compatibility version /)?.[1])
    .filter(path => path && path.startsWith('/') && !path.startsWith('/usr/lib/') && !path.startsWith('/System/Library/'));
  assert.ok(dependencies.some(path => path.includes('libutf8proc')));
  assert.ok(dependencies.some(path => path.includes('libjemalloc')));
  for (const dependency of dependencies) {
    const copied = join(sourcePrefix, 'lib', basename(dependency));
    copyFileSync(dependency, copied);
    run('/usr/bin/install_name_tool', ['-change', dependency, copied, sourceBin]);
  }

  const result = await prepareTerminalRuntime(join(root, 'resources'), { executable: sourceBin, licenses });
  assert.equal(result.bundled, true);
  assert.ok(result.libraries.some(name => name.startsWith('libutf8proc.')));
  assert.ok(result.libraries.some(name => name.startsWith('libjemalloc.')));
  assert.equal(readFileSync(join(root, 'resources', 'terminal', 'manifest.json'), 'utf8').includes(sourcePrefix), false);
  for (const name of ['tmux-COPYING.txt', 'libevent-LICENSE.txt', 'libutf8proc.3.dylib-LICENSE.txt', 'libjemalloc.2.dylib-LICENSE.txt']) {
    assert.ok(existsSync(join(root, 'resources', 'terminal', 'licenses', name)));
  }
  rmSync(sourcePrefix, { recursive: true, force: true });
  assert.equal(run(result.path, ['-V']), 'tmux 3.8');
  assert.match(run('/usr/bin/otool', ['-L', result.path]), /@loader_path\/\.\.\/lib\/libutf8proc/);
  assert.match(run('/usr/bin/otool', ['-L', result.path]), /@loader_path\/\.\.\/lib\/libjemalloc/);
  run('/usr/bin/codesign', ['--verify', '--strict', result.path]);

  const socketPath = join('/tmp', `seqivo-pack-${randomBytes(8).toString('hex')}.sock`);
  const env = { ...process.env };
  delete env.DYLD_LIBRARY_PATH;
  delete env.DYLD_FALLBACK_LIBRARY_PATH;
  try {
    run(result.path, ['-S', socketPath, 'new-session', '-d', '-s', 'test', '-c', root], { env });
    assert.match(run(result.path, ['-S', socketPath, 'list-sessions', '-F', '#{session_name}'], { env }), /^test$/);
  } finally {
    try { run(result.path, ['-S', socketPath, 'kill-server'], { env }); } catch { /* already closed */ }
    rmSync(socketPath, { force: true });
  }
});
