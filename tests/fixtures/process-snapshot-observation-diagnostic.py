#!/usr/bin/env python3
"""Synthetic bulk kernel replies for the terminal observation contract."""
import ctypes
import importlib.util
import os
import struct
import sys

spec = importlib.util.spec_from_file_location('snapshot_helper', sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
uid = os.geteuid()
observer = os.getpid()
size = 648

def row(pid, owner=uid, pgid=1):
    data = bytearray(size)
    for offset, fmt, value in [(0, '<q', 12345), (8, '<i', 1), (40, '<i', pid),
                               (392, '<I', owner), (420, '<I', owner),
                               (560, '<i', 1), (564, '<i', pgid)]:
        struct.pack_into(fmt, data, offset, value)
    return bytes(data)

class Sysctl:
    def __init__(self, payloads, saturated=False):
        self.payloads = payloads
        self.saturated = saturated
        self.index = 0
    def __call__(self, _mib, _count, buffer, length_ptr, _new, _newlen):
        length = ctypes.cast(length_ptr, ctypes.POINTER(ctypes.c_size_t))
        payload = self.payloads[min(self.index, len(self.payloads)-1)]
        if buffer is None:
            length[0] = len(payload)
            return 0
        self.index += 1
        if self.saturated:
            return 0
        ctypes.memmove(buffer, payload, len(payload))
        length[0] = len(payload)
        return 0

class System:
    def __init__(self, payloads, saturated=False):
        self.sysctl = Sysctl(payloads, saturated)

original = (helper.ctypes.CDLL, helper.open_libproc, helper.identity)
try:
    helper.open_libproc = lambda: object()
    helper.identity = lambda *_: {'pid': observer, 'ppid': 1, 'pgid': 1,
                                  'euid': uid, 'ruid': uid, 'startSec': 12345, 'startUsec': 1}
    stable = row(observer) + row(123) + row(222, uid+1)
    churn = row(observer) + row(123) + row(124) + row(222, uid+1)
    def read(payloads, *, single=False, saturated=False):
        system = System(payloads, saturated)
        helper.ctypes.CDLL = lambda *_args, **_kwargs: system
        if single:
            return helper.snapshot(expected_uid=uid, single_observation=True)
        return helper.snapshot(expected_uid=uid)
    old = read([stable, churn])
    assert not old['verified'] and old['reason'] == 'identity_set_changed'
    print('old-two-enumeration-red: identity_set_changed', flush=True)
    observed = read([stable, churn], single=True)
    assert observed['verified'] and observed['attempts'] == 1
    assert observed['scope'] == 'macos-current-effective-uid-complete-observation'
    assert [item['pid'] for item in observed['rows']] == [123]
    assert observed['rows'][0]['startUsec'] == 1
    observed_later = read([churn], single=True)
    assert [item['pid'] for item in observed_later['rows']] == [123, 124]
    invalid = read([stable + row(123)], single=True)
    assert not invalid['verified'] and invalid['reason'] == 'kinfo_identity_invalid' and not invalid['rows']
    saturated = read([stable], single=True, saturated=True)
    assert not saturated['verified'] and saturated['reason'] == 'kinfo_partial_result' and not saturated['rows']
    helper.identity = lambda *_: {'pid': observer, 'ppid': 1, 'pgid': 1,
                                  'euid': uid, 'ruid': uid, 'startSec': 12345, 'startUsec': 2}
    changed = read([stable], single=True)
    assert not changed['verified'] and changed['reason'] == 'kinfo_abi_or_observer_mismatch'
    print('terminal-observation-contract: passed')
finally:
    helper.ctypes.CDLL, helper.open_libproc, helper.identity = original
