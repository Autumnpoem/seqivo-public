import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const python = process.env.TASKBOARD_TEST_PYTHON || 'python3';
const selectedHelper = fileURLToPath(new URL('../plugins/codex-autocontinue/process_identities.py', import.meta.url));
const legacyHelper = fileURLToPath(new URL('../plugins/codex-autocontinue/process_snapshot.py', import.meta.url));
const darwin = process.platform === 'darwin';
const row = (pid, overrides = {}) => ({ pid, ppid: process.pid, pgid: process.pid,
  euid: process.geteuid?.() ?? 0, ruid: process.getuid?.() ?? 0,
  startSec: 1760000000, startUsec: 123456, ...overrides });

async function selected() {
  const module = await import('../server/terminal/process-identities.mjs');
  assert.equal(typeof module.nativeSelectedIdentities, 'function');
  return module.nativeSelectedIdentities;
}
async function ownedDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'seqivo-selected-identities-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function longChild() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 1);
  return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit');
  child.kill('SIGTERM');
  await ended;
}

test('selected native identity reads only the requested live parent and controlled child despite unrelated churn',
  { skip: !darwin, timeout: 30000 }, async t => {
    const nativeSelectedIdentities = await selected();
    const child = longChild();
    t.after(() => stop(child));
    const targets = [process.pid, child.pid];
    const first = await nativeSelectedIdentities(python, targets);
    assert.ok(first instanceof Map);
    assert.deepEqual([...first.keys()].sort((a, b) => a - b), [...targets].sort((a, b) => a - b));
    for (const pid of targets) {
      const value = first.get(pid);
      assert.deepEqual(Object.keys(value).sort(), ['pid', 'ppid', 'pgid', 'euid', 'ruid', 'startSec', 'startUsec'].sort());
      assert.equal(value.pid, pid);
      assert.equal(value.euid, process.geteuid());
      assert.ok(value.startSec > 0 && value.startUsec >= 0 && value.startUsec < 1000000);
    }
    assert.equal(first.get(child.pid).ppid, process.pid);
    for (let i = 0; i < 24; i++) {
      const short = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
      const ended = once(short, 'exit');
      if (i % 4 === 0) {
        const [observed] = await Promise.all([nativeSelectedIdentities(python, targets), ended]);
        assert.deepEqual(observed, first, 'unrelated short-lived PIDs must not change selected identities');
      } else await ended;
    }
    assert.deepEqual(await nativeSelectedIdentities(python, targets), first);
  });

test('Python selected snapshot ignores unrelated full-table churn but fails closed on changed or missing target',
  { skip: !darwin, timeout: 20000 }, () => {
    // No process names, argv, capabilities, or real fixture IDs cross this test boundary.
    const script = String.raw`
import importlib.util, json, os, sys
from contextlib import ExitStack
from unittest.mock import patch
sys.path.insert(0, os.path.dirname(sys.argv[1]))
import process_identities as selected
import process_snapshot as legacy
uid = os.geteuid()
pids = [41001, 41002]
base = {pid: dict(pid=pid, ppid=40001, pgid=40001, euid=uid, ruid=uid,
                  startSec=1760000000, startUsec=123456) for pid in pids}
def run(variant):
    counts = {pid: 0 for pid in pids}
    def identity(lib, observed_uid, pid):
        assert observed_uid == uid and pid in base
        counts[pid] += 1
        if variant == 'missing' and pid == pids[0] and counts[pid] == 2:
            raise legacy.UnknownSnapshot('pid_info_incomplete')
        value = base[pid].copy()
        if pid == pids[0] and counts[pid] == 2:
            if variant == 'birth': value['startUsec'] += 1
            if variant == 'parent': value['ppid'] += 1
            if variant == 'uid': value['euid'] += 1
            if variant == 'ruid': value['ruid'] += 1
        return value
    with ExitStack() as stack:
        for module in (legacy, selected):
            for key, value in [('checked_abi', lambda: None), ('open_libproc', lambda: object()),
                               ('identity', identity)]:
                if hasattr(module, key): stack.enter_context(patch.object(module, key, value))
            for key in ('list_current_uid_pids', 'enumerate_identities', 'enumerate_visible_identities'):
                if hasattr(module, key): stack.enter_context(patch.object(module, key,
                    side_effect=legacy.UnknownSnapshot('list_changed_during_scan')))
        result = selected.snapshot(pids, expected_uid=uid)
        if variant == 'stable':
            old = legacy.snapshot(expected_uid=uid)
        else: old = None
    return result, old, counts
good, old, counts = run('stable')
assert good['schemaVersion'] == 1 and good['uid'] == uid
assert good['scope'] == 'macos-selected-pids-two-observed-enumerations'
assert good['verified'] is True and good['reason'] is None and good['attempts'] == 2
assert good['requestedPids'] == sorted(pids)
assert good['ignoredObserverPid'] == good['observerPid']
assert [r['pid'] for r in good['rows']] == sorted(pids) and all(v == 2 for v in counts.values())
assert old['verified'] is False and old['reason'] == 'list_changed_during_scan' and old['rows'] == []
for variant in ('birth', 'parent', 'uid', 'ruid', 'missing'):
    bad, _, _ = run(variant)
    assert bad['verified'] is False and bad['rows'] == [], (variant, bad)
    assert bad['reason'] and bad['attempts'] == 2, (variant, bad)
for invalid in ([], [1], [41001, 41001], list(range(41001, 41010)), [os.getpid()]):
    bad = selected.snapshot(invalid, expected_uid=uid)
    assert bad['verified'] is False and bad['rows'] == [], invalid
print(json.dumps({'selectedStable': True, 'legacyStillFails': True, 'rejected': 5}))
`;
    const result = spawnSync(python, ['-c', script, selectedHelper, legacyHelper],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 100000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { selectedStable: true, legacyStillFails: true, rejected: 5 });
  });

test('JS selected parser accepts one exact stable set and rejects fabricated or incomplete identities without leaking helper output',
  { skip: !darwin, timeout: 20000 }, async t => {
    const nativeSelectedIdentities = await selected();
    const dir = await ownedDir(t);
    const stub = join(dir, 'fake-python');
    const targetPids = [41001, 41002];
    const canary = 'secret-canary-must-not-appear';
    const valid = { schemaVersion: 1, uid: process.geteuid(), observerPid: 49999,
      ignoredObserverPid: 49999, requestedPids: targetPids,
      scope: 'macos-selected-pids-two-observed-enumerations', verified: true, reason: null,
      attempts: 2, rows: targetPids.map(pid => row(pid)) };
    async function response(value, code = 0) {
      // A packaged Node path can contain spaces; kernels do not quote shebang paths.
      const node = `'${process.execPath.replaceAll("'", "'\\''")}'`;
      await writeFile(stub, `#!/bin/sh\n':' //; exec ${node} "$0" "$@"\nprocess.stdout.write(${JSON.stringify(JSON.stringify(value))});process.exit(${code});\n`,
        { mode: 0o700 });
    }
    await response(valid);
    const accepted = await nativeSelectedIdentities(stub, targetPids, 3000);
    assert.deepEqual([...accepted.keys()], targetPids);
    const malformed = [
      ['missing PID', { ...valid, rows: [row(targetPids[0])] }],
      ['extra PID', { ...valid, rows: [...valid.rows, row(41003)] }],
      ['duplicate PID', { ...valid, rows: [valid.rows[0], valid.rows[0]] }],
      ['wrong scope', { ...valid, scope: 'macos-current-effective-uid-two-observed-enumerations' }],
      ['one sample', { ...valid, attempts: 1 }],
      ['wrong uid', { ...valid, uid: process.geteuid() + 1 }],
      ['row wrong uid', { ...valid, rows: [row(targetPids[0], { euid: process.geteuid() + 1 }), valid.rows[1]] }],
      ['row wrong real uid', { ...valid, rows: [row(targetPids[0], { ruid: process.getuid() + 1 }), valid.rows[1]] }],
      ['bad birth seconds', { ...valid, rows: [row(targetPids[0], { startSec: 0 }), valid.rows[1]] }],
      ['bad birth usec', { ...valid, rows: [row(targetPids[0], { startUsec: 1000000 }), valid.rows[1]] }],
      ['observer in target set', { ...valid, observerPid: targetPids[0], ignoredObserverPid: targetPids[0] }],
      ['unsorted requested PIDs', { ...valid, requestedPids: [...targetPids].reverse() }],
      ['unverified with rows', { ...valid, verified: false, reason: canary }],
    ];
    for (const [label, value] of malformed) {
      await response(value);
      await assert.rejects(nativeSelectedIdentities(stub, targetPids, 3000), error => {
        assert.equal(error.message.includes(canary), false, `${label} leaked helper content`);
        return true;
      }, label);
    }
    for (const pids of [[], [1], [0], [41001, 41001], [2147483648], Array.from({ length: 9 }, (_, i) => i + 2)]) {
      await assert.rejects(nativeSelectedIdentities(stub, pids, 3000));
    }
  });
