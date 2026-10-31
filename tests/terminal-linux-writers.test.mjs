import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectWorkspaceWriters, linuxTracefsExclusion } from '../server/terminal/process-inspection.mjs';

const posixStub = { skip: process.platform === 'win32' && 'POSIX executable lsof fixture' };

test('Linux tracefs exemption never excludes the workspace or its mounted aliases', () => {
  const base = '20 1 8:1 / / rw - ext4 /dev/root rw\n21 20 0:9 / /sys/kernel/debug/tracing rw - tracefs tracefs rw\n';
  assert.deepEqual(linuxTracefsExclusion('/tmp/project', base), ['-e', '/sys/kernel/debug/tracing']);
  for (const workspace of ['/', '/sys', '/sys/kernel/debug/tracing', '/sys/kernel/debug/tracing/project'])
    assert.deepEqual(linuxTracefsExclusion(workspace, base), []);
  for (const alias of ['/tmp/project', '/tmp/project/nested', '/tmp', '/tmp/space\\040project']) {
    const mounts = base + `22 20 0:9 / ${alias} rw - tracefs tracefs rw\n`;
    const workspace = alias.includes('\\040') ? '/tmp/space project' : '/tmp/project';
    assert.deepEqual(linuxTracefsExclusion(workspace, mounts), []);
  }
  assert.deepEqual(linuxTracefsExclusion('/tmp/project', base.replace('- tracefs', '- ext4')), []);
  assert.throws(() => linuxTracefsExclusion('/tmp/project', 'incomplete'));
});

async function fakeLsof(t, { output = '', error = '', code = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'seqivo-linux-writers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'lsof'), argumentsFile = join(root, 'arguments.json');
  await writeFile(executable, `#!${process.execPath}\n` +
    `require('node:fs').writeFileSync(${JSON.stringify(argumentsFile)}, JSON.stringify(process.argv.slice(2)));\n` +
    `process.stdout.write(${JSON.stringify(output)});process.stderr.write(${JSON.stringify(error)});process.exitCode=${code};\n`);
  await chmod(executable, 0o700);
  return { root, executable, argumentsFile };
}

test('Linux writer observation keeps cwd and writable descriptors, excludes read-only descriptors', posixStub, async t => {
  const x = await fakeLsof(t, { output: 'p101\0cshell\0\nfcwd\0a \0n/work\0\np102\0cwriter\0\nf3\0aw\0n/work/out\0\np103\0creader\0\nf4\0ar\0n/work/in\0\n' });
  const result = await inspectWorkspaceWriters({ workspace: x.root, platform: 'linux', lsofPath: x.executable });
  assert.equal(result.verified, true, result.reason);
  assert.equal(result.quiescent, false);
  assert.equal(result.unknown, false);
  assert.deepEqual(result.livePids, [101, 102]);
  assert.equal(result.scope, 'linux-current-visible-cwd-and-write-handles');
  const args = JSON.parse(await readFile(x.argumentsFile, 'utf8'));
  assert.deepEqual(args.slice(-4), ['-nP', '-F0pfcna', '+D', await realpath(x.root)]);
  assert.ok(args.length === 4 || args.length === 6 && args[0] === '-e' && args[1] === '/sys/kernel/debug/tracing');
});

test('Linux empty lsof selection is quiescent, but warnings and incomplete output stay unknown', posixStub, async t => {
  for (const [name, response, expected] of [
    ['empty', { code: 1 }, true],
    ['permission warning', { code: 1, error: 'permission denied' }, false],
    ['command failure', { code: 2 }, false],
    ['incomplete descriptor', { output: 'p101\0f3\0n/work/out\0' }, false],
  ]) await t.test(name, async t => {
    const x = await fakeLsof(t, response);
    const result = await inspectWorkspaceWriters({ workspace: x.root, platform: 'linux', lsofPath: x.executable });
    assert.equal(result.verified, expected);
    assert.equal(result.quiescent, expected);
    assert.equal(result.unknown, !expected);
    assert.deepEqual(result.livePids, []);
  });
});

test('Linux unavailable lsof cannot prove an empty workspace', posixStub, async t => {
  const x = await fakeLsof(t);
  const result = await inspectWorkspaceWriters({ workspace: x.root, platform: 'linux', lsofPath: join(x.root, 'missing-lsof') });
  assert.equal(result.verified, false);
  assert.equal(result.quiescent, false);
  assert.equal(result.unknown, true);
});

test('native Linux default observer distinguishes cwd, writable and read-only open files',
  { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'seqivo-linux-native-writers-'));
    const workspace = join(root, '中文 空间');
    await mkdir(workspace);
    await writeFile(join(workspace, 'read.txt'), 'read only');
    const children = [];
    t.after(async () => {
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
      }
      await rm(root, { recursive: true, force: true });
    });
    for (const mode of ['cwd', 'write', 'read']) {
      const child = spawn(process.execPath, ['-e', `
        const fs = require('node:fs');
        if (process.argv[1] !== 'cwd') fs.openSync(process.argv[2], process.argv[1] === 'write' ? 'w' : 'r');
        process.stdout.write('ready');
        setTimeout(() => {}, 20000);
      `, mode, join(workspace, mode === 'write' ? 'write.txt' : 'read.txt')],
      { cwd: mode === 'cwd' ? workspace : root, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => reject(new Error('Fixture exited before ready')));
        child.stdout.once('data', resolve);
      });
    }
    const result = await inspectWorkspaceWriters({ workspace });
    assert.equal(result.verified, true, result.reason);
    assert.equal(result.quiescent, false);
    assert.equal(result.scope, 'linux-current-visible-cwd-and-write-handles');
    assert.ok(result.writers.some(row => row.pid === children[0].pid && row.reason === 'cwd'));
    assert.ok(result.writers.some(row => row.pid === children[1].pid && row.reason === 'write_handle'));
    assert.ok(!result.livePids.includes(children[2].pid));
  });
