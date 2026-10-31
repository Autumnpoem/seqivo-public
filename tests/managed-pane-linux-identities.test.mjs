import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const python = process.env.TASKBOARD_TEST_PYTHON || 'python3';
const helper = fileURLToPath(new URL('../plugins/codex-autocontinue/process_identities.py', import.meta.url));
const linux = process.platform === 'linux';
const bootId = '123e4567-e89b-42d3-a456-426614174000';
const targetPids = [41001, 41002];
const tickBirth = '18446744073709551615';
const linuxRow = (pid, overrides = {}) => ({ kind: 'linux-proc', pid, ppid: 40000, pgid: 40000,
  euid: process.geteuid?.() ?? 0, ruid: process.getuid?.() ?? 0,
  bootId, startTicks: tickBirth, ...overrides });

function runPython(source, args = []) {
  const result = spawnSync(python, ['-B', '-c', source, helper, ...args],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 100000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('Linux stat parser handles whitespace and parentheses in comm and preserves uint64 start ticks', () => {
  const result = runPython(String.raw`
import json, os, sys
sys.path.insert(0, os.path.dirname(sys.argv[1]))
import process_identities as subject
pid = 41001
fields = ['S', '40000', '40000', '0'] + ['0'] * 15 + ['18446744073709551615']
line = str(pid) + ' (worker (with spaces) and ) chars) ' + ' '.join(fields)
assert subject.linux_stat(line, pid) == (40000, 40000, '18446744073709551615')
for bad in [line.replace('18446744073709551615', '18446744073709551616'),
            line.replace('18446744073709551615', '018446744073709551615'),
            line.replace(' (worker (with spaces) and ) chars)', ' (bad) extra'),
            str(pid) + ' (x) Z ' + ' '.join(fields[1:])]:
    try: subject.linux_stat(bad, pid)
    except subject.UnknownSnapshot: pass
    else: raise AssertionError('malformed stat accepted')
print(json.dumps({'parsed': True, 'uint64MaxPreserved': True, 'malformedRejected': 4}))
`);
  assert.deepEqual(result, { parsed: true, uint64MaxPreserved: true, malformedRejected: 4 });
});

test('Linux selected snapshot requires two identical complete observations and hides raw read errors', () => {
  const result = runPython(String.raw`
import json, os, sys
from unittest.mock import patch
sys.path.insert(0, os.path.dirname(sys.argv[1]))
import process_identities as subject
uid, ruid, observer = 1001, 1001, 49999
pids = [41001, 41002]
boot = '123e4567-e89b-42d3-a456-426614174000'
def row(pid): return {'kind':'linux-proc','pid':pid,'ppid':40000,'pgid':40000,
    'euid':uid,'ruid':ruid,'bootId':boot,'startTicks':'12345678901234567890'}
def run(variant):
    reads = {pid: 0 for pid in pids}
    boots = [boot, '223e4567-e89b-42d3-a456-426614174000'] if variant == 'boot' else [boot, boot]
    def identity(pid, seen_uid, seen_ruid, observed_boot):
        reads[pid] += 1
        if variant == 'missing' and pid == pids[1] and reads[pid] == 2:
            raise FileNotFoundError('/proc/41002 disappeared secret-canary')
        if variant == 'read-error': raise PermissionError('/proc/41001/status secret-canary')
        value = row(pid)
        if pid == pids[0] and reads[pid] == 2:
            if variant == 'ticks': value['startTicks'] = '12345678901234567891'
            if variant == 'ppid': value['ppid'] += 1
            if variant == 'uid': value['euid'] += 1
            if variant == 'ruid': value['ruid'] += 1
        value['bootId'] = observed_boot
        return value
    with patch.object(subject.sys, 'platform', 'linux'), patch.object(subject.os, 'getpid', return_value=observer), \
         patch.object(subject.os, 'geteuid', return_value=uid), patch.object(subject.os, 'getuid', return_value=ruid), \
         patch.object(subject, 'linux_boot_id', side_effect=boots), patch.object(subject, 'linux_identity', side_effect=identity):
        return subject.snapshot(pids, expected_uid=uid), reads
good, counts = run('stable')
assert good['schemaVersion'] == 2 and good['scope'] == 'linux-selected-pids-two-observed-enumerations'
assert good['verified'] is True and good['attempts'] == 2 and good['reason'] is None
assert good['requestedPids'] == pids and [x['pid'] for x in good['rows']] == pids
assert all(value == 2 for value in counts.values())
for variant in ('boot','ticks','ppid','uid','ruid','missing'):
    bad, reads = run(variant)
    assert bad['verified'] is False and bad['rows'] == [] and bad['attempts'] == 2, (variant, bad)
    assert bad['reason'] and all(value == 2 for value in reads.values()), (variant, reads)
bad, _ = run('read-error')
assert bad['verified'] is False and bad['rows'] == []
assert bad['reason'] == 'pid_info_incomplete' and 'secret-canary' not in json.dumps(bad)
print(json.dumps({'stableTwoSamples': True, 'mutationsRejected': 6, 'rawErrorsHidden': True}))
`);
  assert.deepEqual(result, { stableTwoSamples: true, mutationsRejected: 6, rawErrorsHidden: true });
});

test('Linux identity reader uses a pinned proc dirfd and rejects interleaved or incomplete status data', () => {
  const result = runPython(String.raw`
import io, json, os, sys
from contextlib import ExitStack
from unittest.mock import patch
sys.path.insert(0, os.path.dirname(sys.argv[1]))
import process_identities as subject
pid, uid, ruid = 41001, 1001, 1001
def stat(ticks='123456789', ppid=40000):
    fields = ['S',str(ppid),'40000','0'] + ['0'] * 15 + [ticks]
    return str(pid) + ' (worker (with spaces) and ) chars) ' + ' '.join(fields)
good_status = 'Name:\tworker\nPid:\t41001\nUid:\t1001\t1001\t1001\t1001\n'
def observe(stats=(stat(),stat()), status=good_status):
    opened, closed, values = [], [], {}
    sequences = {'stat': list(stats), 'status': [status]}
    def fake_open(path, flags, *, dir_fd=None):
        if path == '/proc/41001':
            assert dir_fd is None
            assert flags & os.O_DIRECTORY and flags & os.O_NOFOLLOW
            opened.append(('root', path, None))
            return 100
        assert dir_fd == 100 and path in sequences
        opened.append((path, path, dir_fd))
        values[101 + len(values)] = sequences[path].pop(0)
        return max(values)
    def fake_fdopen(handle, mode, *, encoding):
        assert mode == 'r' and encoding == 'ascii'
        return io.StringIO(values[handle])
    def fake_close(handle): closed.append(handle)
    with ExitStack() as stack:
        stack.enter_context(patch.object(subject.os, 'open', fake_open))
        stack.enter_context(patch.object(subject.os, 'fdopen', fake_fdopen))
        stack.enter_context(patch.object(subject.os, 'close', fake_close))
        try: value = subject.linux_identity(pid, uid, ruid, '123e4567-e89b-42d3-a456-426614174000')
        except subject.UnknownSnapshot as error: value = {'error': str(error)}
    return value, opened, closed
good, opened, closed = observe()
assert good == {'kind':'linux-proc','pid':pid,'ppid':40000,'pgid':40000,'euid':uid,'ruid':ruid,
    'bootId':'123e4567-e89b-42d3-a456-426614174000','startTicks':'123456789'}
assert [x[0] for x in opened] == ['root','stat','status','stat'] and all(x[2] == 100 for x in opened[1:])
assert closed == [100]
cases = [
    ('birth changed', (stat(),stat(ticks='123456790')), good_status, 'pid_identity_changed'),
    ('parent changed', (stat(),stat(ppid=40001)), good_status, 'pid_identity_changed'),
    ('wrong Pid', (stat(),stat()), good_status.replace('41001','41002'), 'pid_identity_changed'),
    ('wrong real uid', (stat(),stat()), good_status.replace('1001\t1001','1002\t1001'), 'pid_identity_changed'),
    ('wrong effective uid', (stat(),stat()), good_status.replace('1001\t1001\t1001\t1001','1001\t1002\t1001\t1001'), 'pid_identity_changed'),
    ('missing Pid', (stat(),stat()), 'Uid:\t1001\t1001\t1001\t1001\n', 'pid_info_incomplete'),
    ('duplicate Pid', (stat(),stat()), good_status + 'Pid:\t41001\n', 'pid_info_incomplete'),
    ('missing Uid', (stat(),stat()), 'Pid:\t41001\n', 'pid_info_incomplete'),
    ('duplicate Uid', (stat(),stat()), good_status + 'Uid:\t1001\t1001\t1001\t1001\n', 'pid_info_incomplete'),
]
for label, stats, status, reason in cases:
    value, _, _ = observe(stats, status)
    assert value == {'error': reason}, (label, value)
print(json.dumps({'dirfdPinned': True, 'readOrder': True, 'malformedAndRacedIdentityRejected': len(cases)}))
`);
  assert.deepEqual(result, { dirfdPinned: true, readOrder: true, malformedAndRacedIdentityRejected: 9 });
});

test('Linux selected helper observes the actual live parent and direct child', { skip: !linux, timeout: 20000 }, async t => {
  const nativeSelectedIdentities = (await import('../server/terminal/process-identities.mjs')).nativeSelectedIdentities;
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 1);
  const stopChild = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended;
  };
  t.after(async () => {
    await stopChild();
  });
  const rows = await nativeSelectedIdentities(python, [process.pid, child.pid]);
  assert.ok(rows instanceof Map);
  assert.deepEqual([...rows.keys()], [process.pid, child.pid].sort((a, b) => a - b));
  const parent = rows.get(process.pid), directChild = rows.get(child.pid);
  for (const [pid, row] of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['kind','pid','ppid','pgid','euid','ruid','bootId','startTicks'].sort());
    assert.equal(row.kind, 'linux-proc'); assert.equal(row.pid, pid);
    assert.equal(row.euid, process.geteuid()); assert.equal(row.ruid, process.getuid());
    assert.match(row.bootId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.match(row.startTicks, /^(0|[1-9][0-9]*)$/);
    assert.ok(BigInt(row.startTicks) <= 18446744073709551615n);
  }
  assert.equal(directChild.ppid, process.pid, 'selected child must retain exact direct parentage');
  assert.ok(parent);
  await stopChild();
  await assert.rejects(nativeSelectedIdentities(python, [child.pid]), /unconfirmed|invalid selected process identity/i,
    'a disappeared requested PID is unknown, never a retirement proof');
});

test('Linux JS parser accepts exact v2 identities and rejects mixed, unsafe or partial claims without leaking output',
  { skip: !linux, timeout: 20000 }, async t => {
    const nativeSelectedIdentities = (await import('../server/terminal/process-identities.mjs')).nativeSelectedIdentities;
    const dir = await mkdtemp(join(tmpdir(), 'seqivo-linux-selected-identities-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const stub = join(dir, 'fake-python');
    const canary = '/private/proc-secret-canary';
    const valid = { schemaVersion: 2, uid: process.geteuid(), observerPid: 49999,
      ignoredObserverPid: 49999, requestedPids: targetPids,
      scope: 'linux-selected-pids-two-observed-enumerations', verified: true, reason: null,
      attempts: 2, rows: targetPids.map(pid => linuxRow(pid)) };
    async function response(value, { code = 0, stderr = '' } = {}) {
      await writeFile(stub, `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(stderr)});process.stdout.write(${JSON.stringify(JSON.stringify(value))});process.exit(${code});\n`,
        { mode: 0o700 });
    }
    await response(valid);
    const accepted = await nativeSelectedIdentities(stub, targetPids, 3000);
    assert.deepEqual([...accepted.keys()], targetPids);
    assert.equal(accepted.get(targetPids[0]).startTicks, tickBirth, 'uint64 ticks remain a decimal string');
    const malformed = [
      ['v1 schema', { ...valid, schemaVersion: 1 }],
      ['Mac scope', { ...valid, scope: 'macos-selected-pids-two-observed-enumerations' }],
      ['mixed Mac fields', { ...valid, rows: [linuxRow(targetPids[0], { startSec: 1760000000, startUsec: 1 }), valid.rows[1]] }],
      ['unsafe numeric ticks', { ...valid, rows: [linuxRow(targetPids[0], { startTicks: Number(tickBirth) }), valid.rows[1]] }],
      ['noncanonical ticks', { ...valid, rows: [linuxRow(targetPids[0], { startTicks: '0123' }), valid.rows[1]] }],
      ['overflow ticks', { ...valid, rows: [linuxRow(targetPids[0], { startTicks: '18446744073709551616' }), valid.rows[1]] }],
      ['bad boot UUID', { ...valid, rows: [linuxRow(targetPids[0], { bootId: 'NOT-A-BOOT-ID' }), valid.rows[1]] }],
      ['partial rows', { ...valid, rows: [valid.rows[0]] }],
      ['requested PID mismatch', { ...valid, requestedPids: [41001, 41003] }],
      ['wrong row PID', { ...valid, rows: [linuxRow(41003), valid.rows[1]] }],
      ['duplicate row PID', { ...valid, rows: [valid.rows[0], valid.rows[0]] }],
      ['mixed boot IDs', { ...valid, rows: [valid.rows[0], linuxRow(targetPids[1], { bootId: '223e4567-e89b-42d3-a456-426614174000' })] }],
      ['wrong row euid', { ...valid, rows: [linuxRow(targetPids[0], { euid: process.geteuid() + 1 }), valid.rows[1]] }],
      ['wrong row ruid', { ...valid, rows: [linuxRow(targetPids[0], { ruid: process.getuid() + 1 }), valid.rows[1]] }],
      ['one observation', { ...valid, attempts: 1 }],
      ['observer selected', { ...valid, observerPid: targetPids[0], ignoredObserverPid: targetPids[0] }],
    ];
    for (const [label, value] of malformed) {
      await response(value);
      await assert.rejects(nativeSelectedIdentities(stub, targetPids, 3000), error => {
        assert.equal(error.message.includes(canary), false, `${label} leaked helper output`);
        return true;
      }, label);
    }
    await response(valid, { stderr: canary });
    await assert.rejects(nativeSelectedIdentities(stub, targetPids, 3000), error => {
      assert.equal(error.message.includes(canary), false, 'stderr must not leak raw helper details'); return true;
    });
  });
