#!/usr/bin/env python3
"""Isolated synthetic KERN_PROC_ALL responses; never inspects a live process."""

import ctypes
import importlib.util
import os
import struct
import sys


spec = importlib.util.spec_from_file_location("snapshot_helper", sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
SIZE = 648
UID = os.geteuid()
OBSERVER = os.getpid()
FOREIGN_UID = UID + 1 if UID < 4294967295 else UID - 1


def kinfo(pid, euid, *, pgid=1):
    raw = bytearray(SIZE)
    values = [(0, "<q", 12345), (8, "<i", 1), (40, "<i", pid),
              (392, "<I", euid), (420, "<I", euid), (560, "<i", 1),
              (564, "<i", pgid)]
    for offset, fmt, value in values:
        struct.pack_into(fmt, raw, offset, value)
    return bytes(raw)


class FakeSysctl:
    def __init__(self, payloads, saturated=False):
        self.payloads = payloads
        self.saturated = saturated
        self.index = 0

    def __call__(self, _mib, _count, buffer, length_ptr, _new, _newlen):
        length = ctypes.cast(length_ptr, ctypes.POINTER(ctypes.c_size_t))
        payload = self.payloads[min(self.index, len(self.payloads) - 1)]
        if buffer is None:
            length[0] = len(payload)
            return 0
        self.index += 1
        if self.saturated:
            # Kernel reporting the entire supplied capacity is not full-list proof.
            length[0] = length[0]
            return 0
        ctypes.memmove(buffer, payload, len(payload))
        length[0] = len(payload)
        return 0


class FakeSystem:
    def __init__(self, payloads, saturated=False):
        self.sysctl = FakeSysctl(payloads, saturated)


def observer_identity():
    return {"pid": OBSERVER, "ppid": 1, "pgid": 1, "euid": UID,
            "ruid": UID, "startSec": 12345, "startUsec": 1}


original_cdll = helper.ctypes.CDLL
original_open_libproc = helper.open_libproc
original_identity = helper.identity
try:
    helper.open_libproc = lambda: object()
    helper.identity = lambda _lib, _uid, _pid: observer_identity()

    def run(payloads, *, all_visible=False, saturated=False):
        system = FakeSystem(payloads, saturated)
        helper.ctypes.CDLL = lambda *_args, **_kwargs: system
        return helper.snapshot(expected_uid=UID, all_visible=all_visible)

    base = kinfo(OBSERVER, UID) + kinfo(123, UID) + kinfo(222, FOREIGN_UID)
    stable = run([base, base])
    assert stable["verified"] and stable["reason"] is None
    assert [row["pid"] for row in stable["rows"]] == [123]
    assert stable["attempts"] == 2
    all_visible = run([base, base], all_visible=True)
    assert all_visible["verified"]
    assert [row["pid"] for row in all_visible["rows"]] == [123, 222]

    changed = run([base, kinfo(OBSERVER, UID) + kinfo(124, UID) + kinfo(222, FOREIGN_UID)])
    assert not changed["verified"] and changed["reason"] == "identity_set_changed"
    assert changed["rows"] == []
    duplicate = run([base + kinfo(123, UID)])
    assert not duplicate["verified"] and duplicate["reason"] == "kinfo_identity_invalid"
    invalid_foreign = run([base + kinfo(333, FOREIGN_UID, pgid=0)])
    assert not invalid_foreign["verified"] and invalid_foreign["reason"] == "kinfo_identity_invalid"
    saturated = run([base], saturated=True)
    assert not saturated["verified"] and saturated["reason"] == "kinfo_partial_result"
    helper.identity = lambda _lib, _uid, _pid: {**observer_identity(), "startUsec": 2}
    mismatch = run([base])
    assert not mismatch["verified"] and mismatch["reason"] == "kinfo_abi_or_observer_mismatch"
    print("bulk-current-uid-fail-closed: passed")
finally:
    helper.ctypes.CDLL = original_cdll
    helper.open_libproc = original_open_libproc
    helper.identity = original_identity
