import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalPsStart, inspectWorkspaceWriters, parseLsofWorkspace } from '../server/terminal/process-inspection.mjs';

test('process birth display accepts only C-locale dates and normalizes padding', () => {
  assert.equal(canonicalPsStart(' Sat Oct  7 01:02:03 2023 '), 'Sat Oct 7 01:02:03 2023');
  for (const value of [null, '', 'unknown', 'Sat Oct 32 01:02:03 2023', 'Sat Oct 7 25:02:03 2023',
    'Sam Okt 7 01:02:03 2023', 'Sat Oct 7 01:02:03 2023 trailing'])
    assert.equal(canonicalPsStart(value), null);
});

test('lsof parser classifies cwd and writable handles, but ignores read-only handles', () => {
  const fields = 'p123\0ctmux\0\nfcwd\0a \0n/tmp/work\0\n f3\0aw\0n/tmp/work/out\0\n f4\0ar\0n/tmp/work/read\0\np456\0csleep\0\nfcwd\0a \0n/tmp/elsewhere\0';
  const writers = parseLsofWorkspace(fields.replaceAll('\n f', '\nf'), '/tmp/work');
  assert.deepEqual(writers.map(item => item.reason), ['cwd', 'write_handle']);
  assert.deepEqual(writers.map(item => item.pid), [123, 123]);
});

test('unsupported platforms fail closed', async () => {
  const result = await inspectWorkspaceWriters({ workspace: '/tmp', platform: 'win32' });
  assert.equal(result.verified, false);
  assert.equal(result.unknown, true);
});

test('selected lsof records cannot silently discard unknown access or malformed identities', () => {
  const parse = value => parseLsofWorkspace(value, '/tmp/work', [], { selectedByDirectory: true });
  for (const fields of [
    'p123\0f3\0n/tmp/work/out\0',
    'p123\0f3\0a \0n/tmp/work/out\0',
    'p123\0f3\0ax\0n/tmp/work/out\0',
    'p123\0f3\0ar\0au\0n/tmp/work/out\0',
    'p123\0f3\0ar\0n\0n/tmp/work/out\0',
    'punknown\0f3\0aw\0n/tmp/work/out\0',
    'p123\0finvalid\0aw\0n/tmp/work/out\0',
    'p123\0',
    'f3\0aw\0n/tmp/work/out\0',
  ]) assert.throws(() => parse(fields));
  assert.equal(parse('p123\0f3\0ar\0n/tmp/work/read\0').length, 0);
  assert.equal(parse('p123\0f3\0au\0n/tmp/work/write\0')[0].reason, 'write_handle');
});

test('macOS lsof observes a live process whose cwd is the workspace', { skip: process.platform !== 'darwin' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'terminal-observer-'));
  const child = spawn('/bin/sleep', ['20'], { cwd: dir, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
  } await rm(dir, { recursive: true, force: true }); });
  const result = await inspectWorkspaceWriters({ workspace: dir });
  assert.equal(result.verified, true, result.reason);
  assert.equal(result.quiescent, false);
  assert.ok(result.livePids.includes(child.pid));
  assert.ok(result.writers.some(item => item.pid === child.pid && item.reason === 'cwd'));
});

test('macOS directory selection finds Unicode writable handles without confusing literal escapes',
  { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'terminal-unicode-'));
    const name = '中文 空间';
    const encoded = [...Buffer.from(name)].map(byte => byte >= 0x20 && byte < 0x7f
      ? String.fromCharCode(byte) : `\\x${byte.toString(16)}`).join('');
    const workspace = join(dir, name), literal = join(dir, encoded);
    await mkdir(workspace); await mkdir(literal);
    const children = [];
    t.after(async () => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
      }
      await rm(dir, { recursive: true, force: true });
    });
    for (const target of [workspace, literal]) {
      // cwd remains outside the workspace; only the inherited writable FD makes
      // this a writer. argv receives the filename without shell interpolation.
      const child = spawn('/bin/sh', ['-c', 'exec /bin/sleep 20 3>"$1"', 'fixture', join(target, '输出.txt')],
        { cwd: dir, stdio: 'ignore' });
      children.push(child);
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    }
    await sleep(80);
    const a = await inspectWorkspaceWriters({ workspace });
    const b = await inspectWorkspaceWriters({ workspace: literal });
    assert.equal(a.verified, true, a.reason);
    assert.equal(b.verified, true, b.reason);
    assert.ok(a.writers.some(row => row.pid === children[0].pid && row.reason === 'write_handle'));
    assert.ok(b.writers.some(row => row.pid === children[1].pid && row.reason === 'write_handle'));
    assert.ok(!a.livePids.includes(children[1].pid));
    assert.ok(!b.livePids.includes(children[0].pid));
  });
