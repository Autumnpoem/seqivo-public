#!/usr/bin/env python3
"""Read a bounded, current-user macOS process identity snapshot.

This is an observation, not proof that a command has stopped. In particular,
processes that start and exit between enumerations cannot be reconstructed.
"""

import argparse
import ctypes
import errno
import json
import os
import re
import struct
import sys


SCHEMA_VERSION = 1
PROC_PIDTBSDINFO = 3  # sys/proc_info.h
MAXCOMLEN = 16  # sys/param.h
MAX_PID_SLOTS = 65536
LINUX_SCHEMA_VERSION = 2
LINUX_MAX_TICKS = 18446744073709551615


class ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ("pbi_flags", ctypes.c_uint32),
        ("pbi_status", ctypes.c_uint32),
        ("pbi_xstatus", ctypes.c_uint32),
        ("pbi_pid", ctypes.c_uint32),
        ("pbi_ppid", ctypes.c_uint32),
        ("pbi_uid", ctypes.c_uint32),
        ("pbi_gid", ctypes.c_uint32),
        ("pbi_ruid", ctypes.c_uint32),
        ("pbi_rgid", ctypes.c_uint32),
        ("pbi_svuid", ctypes.c_uint32),
        ("pbi_svgid", ctypes.c_uint32),
        ("rfu_1", ctypes.c_uint32),
        ("pbi_comm", ctypes.c_char * MAXCOMLEN),
        ("pbi_name", ctypes.c_char * (2 * MAXCOMLEN)),
        ("pbi_nfiles", ctypes.c_uint32),
        ("pbi_pgid", ctypes.c_uint32),
        ("pbi_pjobc", ctypes.c_uint32),
        ("e_tdev", ctypes.c_uint32),
        ("e_tpgid", ctypes.c_uint32),
        ("pbi_nice", ctypes.c_int32),
        ("pbi_start_tvsec", ctypes.c_uint64),
        ("pbi_start_tvusec", ctypes.c_uint64),
    ]


ABI_OFFSETS = {
    "pbi_pid": 12,
    "pbi_ppid": 16,
    "pbi_uid": 20,
    "pbi_ruid": 28,
    "pbi_pgid": 100,
    "pbi_start_tvsec": 120,
    "pbi_start_tvusec": 128,
}


class UnknownSnapshot(Exception):
    pass


def linux_stat(raw, pid, selected=False):
    closing = raw.rfind(")")
    opening = raw.find(" (")
    if opening < 1 or closing <= opening or raw[closing + 1:closing + 2] != " ":
        raise UnknownSnapshot("pid_info_incomplete")
    fields = raw[closing + 2:].split()
    if raw[:opening] != str(pid) or len(fields) < 20 or fields[0] in ("X", "x") or selected and fields[0] == "Z":
        raise UnknownSnapshot("pid_info_incomplete")
    ppid, pgid, start_ticks = fields[1], fields[2], fields[19]
    group = r"[1-9][0-9]*" if selected else r"0|[1-9][0-9]*"
    ticks = r"[1-9][0-9]*" if selected else r"0|[1-9][0-9]*"
    if not re.fullmatch(r"0|[1-9][0-9]*", ppid) or not re.fullmatch(group, pgid) or not re.fullmatch(ticks, start_ticks):
        raise UnknownSnapshot("pid_info_incomplete")
    if int(start_ticks) > LINUX_MAX_TICKS:
        raise UnknownSnapshot("pid_info_incomplete")
    return (int(ppid), int(pgid), start_ticks)


def linux_boot_id():
    with open("/proc/sys/kernel/random/boot_id", "r", encoding="ascii") as file:
        value = file.read(100).strip()
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", value):
        raise UnknownSnapshot("pid_info_incomplete")
    return value


def linux_identity(pid, boot_id, expected_uid=None, expected_ruid=None, selected=False):
    directory = os.open(f"/proc/{pid}", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        def read(name):
            handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
            with os.fdopen(handle, "r", encoding="utf-8", errors="surrogateescape") as file:
                data = file.read(65537)
            if len(data) > 65536:
                raise UnknownSnapshot("pid_info_incomplete")
            return data

        before = linux_stat(read("stat"), pid, selected)
        status = read("status")
        after = linux_stat(read("stat"), pid, selected)
        if before != after:
            raise UnknownSnapshot("pid_identity_changed")
        pid_fields = re.findall(r"^Pid:\s*([0-9]+)\s*$", status, re.MULTILINE)
        uid_fields = re.findall(r"^Uid:\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s*$", status, re.MULTILINE)
        if len(pid_fields) != 1 or len(uid_fields) != 1:
            raise UnknownSnapshot("pid_info_incomplete")
        ruid, euid = int(uid_fields[0][0]), int(uid_fields[0][1])
        if int(pid_fields[0]) != pid or expected_uid is not None and euid != expected_uid or expected_ruid is not None and ruid != expected_ruid:
            raise UnknownSnapshot("pid_identity_changed")
        return {"kind": "linux-proc", "pid": pid, "ppid": before[0], "pgid": before[1],
                "euid": euid, "ruid": ruid, "bootId": boot_id, "startTicks": before[2]}
    finally:
        os.close(directory)


def linux_visible_pids():
    with open("/proc/self/mountinfo", "r", encoding="utf-8") as file:
        mounts = file.read(1048577)
    if len(mounts) > 1048576:
        raise UnknownSnapshot("list_failed")
    proc_mounts = []
    for line in mounts.splitlines():
        parts = line.split(" ")
        if len(parts) < 10 or parts[4] != "/proc":
            continue
        separator = parts.index("-") if "-" in parts else -1
        if separator < 6 or parts[separator + 1] != "proc":
            raise UnknownSnapshot("list_failed")
        proc_mounts.append(parts)
    if len(proc_mounts) != 1:
        raise UnknownSnapshot("list_failed")
    options = set(proc_mounts[0][5].split(",") + proc_mounts[0][-1].split(","))
    if any(option.startswith("hidepid=") and option != "hidepid=0" or option == "subset=pid" for option in options):
        raise UnknownSnapshot("list_failed")
    names = os.listdir("/proc")
    pids = []
    for name in names:
        if not name.isascii() or not name.isdecimal():
            continue
        if not re.fullmatch(r"[1-9][0-9]*", name) or int(name) > 2147483647:
            raise UnknownSnapshot("list_invalid_pid")
        pids.append(int(name))
    if not pids or len(pids) > MAX_PID_SLOTS or len(set(pids)) != len(pids):
        raise UnknownSnapshot("list_capacity_exceeded")
    return sorted(pids)


def linux_snapshot(expected_uid, enumerations, all_visible, single_observation):
    uid = os.geteuid()
    observer_pid = os.getpid()
    base = {"schemaVersion": LINUX_SCHEMA_VERSION, "uid": uid, "observerPid": observer_pid,
            "ignoredObserverPid": observer_pid,
            "scope": ("linux-current-effective-uid-complete-observation" if single_observation else
                      "linux-all-visible-exact-births-two-observed-enumerations" if all_visible else
                      "linux-current-effective-uid-two-observed-enumerations"),
            "verified": False, "reason": None, "attempts": 0, "rows": []}
    if expected_uid is not None and expected_uid != uid:
        base["reason"] = "unexpected_uid"
        return base
    if single_observation and all_visible:
        base["reason"] = "invalid_mode"
        return base
    previous = None
    try:
        for attempt in range(1, (1 if single_observation else enumerations) + 1):
            base["attempts"] = attempt
            boot_id = linux_boot_id()
            pids = linux_visible_pids()
            if observer_pid not in pids:
                raise UnknownSnapshot("observer_missing")
            current = [linux_identity(pid, boot_id) for pid in pids]
            if linux_visible_pids() != pids:
                raise UnknownSnapshot("list_changed_during_scan")
            observed = next((row for row in current if row["pid"] == observer_pid), None)
            if observed is None or observed["euid"] != uid:
                raise UnknownSnapshot("observer_missing")
            current = [row for row in current if row["pid"] != observer_pid and (all_visible or row["euid"] == uid)]
            if previous is not None and previous != current:
                raise UnknownSnapshot("identity_set_changed")
            previous = current
    except (UnknownSnapshot, OSError, UnicodeError) as exc:
        base["reason"] = str(exc) if isinstance(exc, UnknownSnapshot) else "pid_info_incomplete"
        return base
    base["verified"] = True
    base["rows"] = previous
    return base


def call_with_eintr_retry(function, *args):
    # Retry only a syscall interrupted before it returned any observation.
    # A missing PID, partial result, or changed identity is never retried away.
    for _ in range(3):
        ctypes.set_errno(0)
        result = function(*args)
        if result > 0 or ctypes.get_errno() != errno.EINTR:
            return result
    return result


def checked_abi():
    # Values verified against the local public SDK with sizeof/offsetof.
    if ctypes.sizeof(ProcBsdInfo) != 136 or any(
        getattr(ProcBsdInfo, field).offset != offset
        for field, offset in ABI_OFFSETS.items()
    ):
        raise UnknownSnapshot("abi_mismatch")


def open_libproc():
    try:
        lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        lib.proc_pidinfo.restype = ctypes.c_int
        return lib
    except (OSError, AttributeError) as exc:
        raise UnknownSnapshot("libproc_unavailable") from exc


def identity(lib, uid, pid):
    info = ProcBsdInfo()
    received = call_with_eintr_retry(lib.proc_pidinfo, pid, PROC_PIDTBSDINFO, 0, ctypes.byref(info), ctypes.sizeof(info))
    if received != ctypes.sizeof(info):
        raise UnknownSnapshot("pid_info_incomplete")
    if info.pbi_pid != pid or info.pbi_uid != uid or info.pbi_start_tvusec >= 1000000:
        raise UnknownSnapshot("pid_identity_changed")
    return {
        "pid": pid,
        "ppid": int(info.pbi_ppid),
        "pgid": int(info.pbi_pgid),
        "euid": int(info.pbi_uid),
        "ruid": int(info.pbi_ruid),
        "startSec": int(info.pbi_start_tvsec),
        "startUsec": int(info.pbi_start_tvusec),
    }


def enumerate_visible_identities(lib, uid, observer_pid, current_uid_only=False):
    # Public 64-bit macOS kinfo_proc ABI, checked with the SDK sizeof/offsetof
    # and cross-checked against libproc for our live observer on every read.
    # This read-only sysctl exposes exact births for foreign UIDs for which
    # proc_pidinfo may be unavailable. It never reads argv, names or credentials.
    if ctypes.sizeof(ctypes.c_void_p) != 8 or sys.byteorder != 'little':
        raise UnknownSnapshot('kinfo_abi_unsupported')
    size = 648
    system = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    system.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint,
                             ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
                             ctypes.c_void_p, ctypes.c_size_t]
    system.sysctl.restype = ctypes.c_int
    mib = (ctypes.c_int * 4)(1, 14, 0, 0)  # CTL_KERN, KERN_PROC, KERN_PROC_ALL
    length = ctypes.c_size_t()
    if call_with_eintr_retry(system.sysctl, mib, 4, None, ctypes.byref(length), None, 0) != 0:
        raise UnknownSnapshot('kinfo_size_failed')
    if not length.value or length.value % size or length.value > (MAX_PID_SLOTS - 64) * size:
        raise UnknownSnapshot('kinfo_size_invalid')
    buffer = ctypes.create_string_buffer(length.value + 64 * size)
    length.value = ctypes.sizeof(buffer)
    if call_with_eintr_retry(system.sysctl, mib, 4, buffer, ctypes.byref(length), None, 0) != 0:
        raise UnknownSnapshot('kinfo_read_failed')
    # A full buffer cannot prove that the kernel did not truncate its result.
    if not length.value or length.value % size or length.value >= ctypes.sizeof(buffer):
        raise UnknownSnapshot('kinfo_partial_result')
    rows = {}
    raw = buffer.raw[:length.value]
    for offset in range(0, length.value, size):
        pid = struct.unpack_from('<i', raw, offset + 40)[0]
        if pid == 0:  # kernel_task is not a user executor
            continue
        row = {'pid': pid, 'ppid': struct.unpack_from('<i', raw, offset + 560)[0],
               'pgid': struct.unpack_from('<i', raw, offset + 564)[0],
               'euid': struct.unpack_from('<I', raw, offset + 420)[0],
               'ruid': struct.unpack_from('<I', raw, offset + 392)[0],
               'startSec': struct.unpack_from('<q', raw, offset)[0],
               'startUsec': struct.unpack_from('<i', raw, offset + 8)[0]}
        if pid < 1 or pid in rows or row['ppid'] < 0 or row['pgid'] < 1 or row['startSec'] <= 0 or not 0 <= row['startUsec'] < 1000000:
            raise UnknownSnapshot('kinfo_identity_invalid')
        rows[pid] = row
    if rows.get(observer_pid) != identity(lib, uid, observer_pid):
        raise UnknownSnapshot('kinfo_abi_or_observer_mismatch')
    # Validate every bulk row before filtering. A foreign-UID process cannot
    # turn a malformed or incomplete kernel snapshot into a successful one.
    return [rows[pid] for pid in sorted(rows)
            if pid != observer_pid and (not current_uid_only or rows[pid]['euid'] == uid)]


def snapshot(expected_uid=None, enumerations=2, all_visible=False, single_observation=False):
    if sys.platform == "linux":
        return linux_snapshot(expected_uid, enumerations, all_visible, single_observation)
    uid = os.geteuid()
    observer_pid = os.getpid()
    base = {
        "schemaVersion": SCHEMA_VERSION,
        "uid": uid,
        "observerPid": observer_pid,
        "ignoredObserverPid": observer_pid,
        "scope": ("macos-current-effective-uid-complete-observation" if single_observation else
                  "macos-all-visible-exact-births-two-observed-enumerations" if all_visible else
                  "macos-current-effective-uid-two-observed-enumerations"),
        "verified": False,
        "reason": None,
        "attempts": 0,
        "rows": [],
    }
    if sys.platform != "darwin":
        base["reason"] = "unsupported_platform"
        return base
    if expected_uid is not None and expected_uid != uid:
        base["reason"] = "unexpected_uid"
        return base
    if single_observation and all_visible:
        base["reason"] = "invalid_mode"
        return base
    try:
        checked_abi()
        lib = open_libproc()
    except UnknownSnapshot as exc:
        base["reason"] = str(exc)
        return base
    previous = None
    for attempt in range(1, (1 if single_observation else enumerations) + 1):
        base["attempts"] = attempt
        try:
            current = enumerate_visible_identities(lib, uid, observer_pid, current_uid_only=not all_visible)
        except UnknownSnapshot as exc:
            base["reason"] = str(exc)
            return base
        if previous is not None and previous != current:
            base["reason"] = "identity_set_changed"
            return base
        previous = current
    base["verified"] = True
    base["rows"] = previous
    return base


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-uid", type=int)
    parser.add_argument("--enumerations", type=int, default=2)
    parser.add_argument("--all-visible", action="store_true")
    parser.add_argument("--single-observation", action="store_true")
    args = parser.parse_args()
    if not 2 <= args.enumerations <= 8:
        parser.error("--enumerations must be between 2 and 8")
    if args.single_observation and (args.all_visible or args.enumerations != 2):
        parser.error("single observation is current-UID only and does not use the stable enumeration count")
    result = snapshot(args.expected_uid, args.enumerations, args.all_visible, args.single_observation)
    print(json.dumps(result, separators=(",", ":")))
    return 0 if result["verified"] else 2


if __name__ == "__main__":
    sys.exit(main())
