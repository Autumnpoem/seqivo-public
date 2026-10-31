import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { nativeProcessTable } from '../server/codex-process-proof.mjs';

const python = process.env.TASKBOARD_TEST_PYTHON || 'python3';
const helper = fileURLToPath(new URL('../plugins/codex-autocontinue/process_snapshot.py', import.meta.url));
const contract = fileURLToPath(new URL('./fixtures/linux-process-snapshot-contract.py', import.meta.url));

test('Linux snapshot rejects incomplete inventories and preserves exact births', { skip: process.platform === 'win32' }, () => {
  const result = spawnSync(python, ['-I', '-B', contract, helper], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /linux-snapshot-contract: passed/);
});

test('native Linux complete inventory retains a live owned process and its kernel birth', { skip: process.platform !== 'linux' }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    await once(child, 'spawn');
    const rows = await nativeProcessTable(python, 5000, { allVisible: true });
    const row = rows.get(child.pid);
    assert.ok(row);
    assert.equal(row.kind, 'linux-proc');
    assert.equal(row.ppid, process.pid);
    assert.equal(row.euid, process.geteuid());
    assert.equal(row.bootId, (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim());
    const stat = await readFile(`/proc/${child.pid}/stat`, 'utf8');
    assert.equal(row.startTicks, stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19]);
    assert.ok(rows.has(1), 'complete inventory must retain init, including its foreign UID');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGTERM');
      await exit;
    }
  }
});
