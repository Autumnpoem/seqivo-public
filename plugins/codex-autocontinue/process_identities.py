#!/usr/bin/env python3
"""Observe only explicitly selected live process identities, twice.

This is not a process inventory, descendant proof, or proof of quiescence.
Callers must still compare the returned births with their original records.
The full-inventory helper remains necessary for writer and stop checks.
"""

import argparse
import json
import os
import re
import sys

from process_snapshot import UnknownSnapshot, checked_abi, identity, open_libproc


SCOPE = "macos-selected-pids-two-observed-enumerations"
LINUX_SCOPE = "linux-selected-pids-two-observed-enumerations"
MAX_SELECTED = 8


def linux_stat(raw, pid):
    closing = raw.rfind(")")
    opening = raw.find(" (")
    if opening < 1 or closing <= opening or raw[closing + 1:closing + 2] != " ":
        raise UnknownSnapshot("pid_info_incomplete")
    fields = raw[closing + 2:].split()
    if raw[:opening] != str(pid) or len(fields) < 20 or fields[0] in ("Z", "X", "x"):
        raise UnknownSnapshot("pid_info_incomplete")
    ppid, pgid, start_ticks = fields[1], fields[2], fields[19]
    if not re.fullmatch(r"0|[1-9][0-9]*", ppid) or not re.fullmatch(r"[1-9][0-9]*", pgid) or not re.fullmatch(r"[1-9][0-9]*", start_ticks):
        raise UnknownSnapshot("pid_info_incomplete")
    if int(start_ticks) > 18446744073709551615:
        raise UnknownSnapshot("pid_info_incomplete")
    return (int(ppid), int(pgid), start_ticks)


def linux_identity(pid, uid, ruid, boot_id):
    directory = os.open(f"/proc/{pid}", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        def read(name):
            handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
            with os.fdopen(handle, "r", encoding="ascii") as file:
                return file.read(65536)

        before = linux_stat(read("stat"), pid)
        status = read("status")
        after = linux_stat(read("stat"), pid)
        if before != after:
            raise UnknownSnapshot("pid_identity_changed")
        pid_fields = re.findall(r"^Pid:\s*([0-9]+)\s*$", status, re.MULTILINE)
        uid_fields = re.findall(r"^Uid:\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s*$", status, re.MULTILINE)
        if len(pid_fields) != 1 or len(uid_fields) != 1:
            raise UnknownSnapshot("pid_info_incomplete")
        if int(pid_fields[0]) != pid or int(uid_fields[0][0]) != ruid or int(uid_fields[0][1]) != uid:
            raise UnknownSnapshot("pid_identity_changed")
        return {"kind": "linux-proc", "pid": pid, "ppid": before[0], "pgid": before[1],
                "euid": uid, "ruid": ruid, "bootId": boot_id, "startTicks": before[2]}
    finally:
        os.close(directory)


def linux_boot_id():
    with open("/proc/sys/kernel/random/boot_id", "r", encoding="ascii") as file:
        value = file.read(100).strip()
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", value):
        raise UnknownSnapshot("pid_info_incomplete")
    return value


def snapshot(pids, expected_uid=None):
    uid = os.geteuid()
    observer_pid = os.getpid()
    base = {
        "schemaVersion": 2 if sys.platform == "linux" else 1,
        "uid": uid,
        "observerPid": observer_pid,
        "ignoredObserverPid": observer_pid,
        "requestedPids": [],
        "scope": LINUX_SCOPE if sys.platform == "linux" else SCOPE,
        "verified": False,
        "reason": None,
        "attempts": 0,
        "rows": [],
    }
    if (not isinstance(pids, list) or not 1 <= len(pids) <= MAX_SELECTED
            or any(type(pid) is not int or not 1 < pid <= 2147483647 for pid in pids)
            or len(set(pids)) != len(pids) or observer_pid in pids):
        base["reason"] = "pid_identity_changed"
        return base
    base["requestedPids"] = sorted(pids)
    if sys.platform not in ("darwin", "linux"):
        base["reason"] = "unsupported_platform"
        return base
    if expected_uid is not None and expected_uid != uid:
        base["reason"] = "unexpected_uid"
        return base
    try:
        if sys.platform == "darwin":
            checked_abi()
            lib = open_libproc()
        previous = None
        for attempt in range(1, 3):
            base["attempts"] = attempt
            if sys.platform == "linux":
                boot_id = linux_boot_id()
                current = [linux_identity(pid, uid, os.getuid(), boot_id) for pid in base["requestedPids"]]
            else:
                current = [identity(lib, uid, pid) for pid in base["requestedPids"]]
            # Require each requested process to remain owned by this user, with
            # a complete stable birth/parent/group. Never omit a missing PID.
            if any(row["pid"] != pid or row["euid"] != uid or row["ruid"] != os.getuid()
                   for pid, row in zip(base["requestedPids"], current)):
                raise UnknownSnapshot("pid_identity_changed")
            if previous is not None and previous != current:
                raise UnknownSnapshot("pid_identity_changed")
            previous = current
    except (UnknownSnapshot, OSError, UnicodeError) as exc:
        base["reason"] = str(exc) if isinstance(exc, UnknownSnapshot) else "pid_info_incomplete"
        return base
    base["verified"] = True
    base["rows"] = previous
    return base


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-uid", type=int, required=True)
    parser.add_argument("--pid", type=int, action="append", required=True)
    args = parser.parse_args()
    result = snapshot(args.pid, args.expected_uid)
    print(json.dumps(result, separators=(",", ":")))
    return 0 if result["verified"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
