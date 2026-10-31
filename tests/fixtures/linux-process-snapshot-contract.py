"""Deterministic parser/completeness checks; no process signals or /proc edits."""
import io
import os
import runpy
import sys
from unittest.mock import patch

module = runpy.run_path(sys.argv[1])
snapshot = module['linux_snapshot']
scope = snapshot.__globals__
Unknown = module['UnknownSnapshot']
uid, observer = os.geteuid(), os.getpid()
boot = '12345678-1234-1234-1234-123456789abc'
other = observer + 100000

def row(pid, born='123'):
    return dict(kind='linux-proc', pid=pid, ppid=1, pgid=0, euid=uid if pid == observer else uid + 1,
                ruid=uid if pid == observer else uid + 1, bootId=boot, startTicks=born)

def check_unknown(result, reason):
    assert result['verified'] is False, result
    assert result['reason'] == reason, result
    assert result['rows'] == [], result

with patch.dict(scope, linux_boot_id=lambda: boot,
                linux_visible_pids=lambda: sorted([observer, other]),
                linux_identity=lambda pid, _: row(pid)):
    complete = snapshot(uid, 2, True, False)
    assert complete['verified'] and complete['attempts'] == 2
    assert complete['rows'] == [row(other)]
    assert complete['scope'] == 'linux-all-visible-exact-births-two-observed-enumerations'
    own = snapshot(uid, 2, False, False)
    assert own['verified'] and own['rows'] == []
    check_unknown(snapshot(uid + 1, 2, True, False), 'unexpected_uid')
    check_unknown(snapshot(uid, 2, True, True), 'invalid_mode')

    samples = iter([sorted([observer, other]), [observer]])
    with patch.dict(scope, linux_visible_pids=lambda: next(samples)):
        check_unknown(snapshot(uid, 2, True, False), 'list_changed_during_scan')
    def denied(pid, _):
        if pid == other:
            raise PermissionError('fixture unreadable foreign PID')
        return row(pid)
    with patch.dict(scope, linux_identity=denied):
        check_unknown(snapshot(uid, 2, False, False), 'pid_info_incomplete')
    births = iter(['123', '124'])
    with patch.dict(scope, linux_identity=lambda pid, _: row(pid, next(births)) if pid == other else row(pid)):
        check_unknown(snapshot(uid, 2, True, False), 'identity_set_changed')
    with patch.dict(scope, linux_visible_pids=lambda: [other]):
        check_unknown(snapshot(uid, 2, True, False), 'observer_missing')

def stat(state='S', pgid='4', ticks='123'):
    return '42 (name with ) brackets) ' + ' '.join([state, '1', pgid] + ['0'] * 16 + [ticks])

parse = module['linux_stat']
assert parse(stat(), 42) == (1, 4, '123')
assert parse(stat(pgid='0', ticks='0'), 42) == (1, 0, '0')
assert parse(stat(state='Z'), 42) == (1, 4, '123'), 'full inventory must retain zombies'
for text, selected in [(stat(state='Z'), True), (stat(pgid='0'), True),
                       (stat(ticks='18446744073709551616'), False),
                       (stat(ticks='01'), False), ('42 broken', False)]:
    try:
        parse(text, 42, selected)
    except Unknown:
        pass
    else:
        raise AssertionError('Malformed or selected-dead identity was accepted')

enumerate_pids = module['linux_visible_pids']
for options, names, expected in [('rw,hidepid=2', ['42'], 'list_failed'),
                                ('rw', ['42', '42'], 'list_capacity_exceeded'),
                                ('rw', ['01'], 'list_invalid_pid')]:
    mount = '10 1 0:3 / /proc rw,nosuid - proc proc ' + options + '\n'
    with patch('builtins.open', return_value=io.StringIO(mount)), patch('os.listdir', return_value=names):
        try:
            enumerate_pids()
        except Unknown as error:
            assert str(error) == expected, str(error)
        else:
            raise AssertionError('Incomplete inventory was accepted')

print('linux-snapshot-contract: passed')
