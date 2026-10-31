#!/usr/bin/env python3
"""Private macOS launchd-job launcher and identity-bound coalition observer.

No command, environment value, or capability is passed on the launchctl argv.
Only signal-member may signal, after two exact native identity/cohort reads.
"""
import ctypes
import errno
import json
import os
import pathlib
import socket
import stat
import struct
import sys
import signal

import process_snapshot

LIB = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
LIB.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                             ctypes.c_void_p, ctypes.c_int]
LIB.proc_pidinfo.restype = ctypes.c_int
LIB.proc_listcoalitions.argtypes = [ctypes.c_int, ctypes.c_int,
                                    ctypes.c_void_p, ctypes.c_int]
LIB.proc_listcoalitions.restype = ctypes.c_int

# SDK proc_info_private.h: PROC_PIDUNIQIDENTIFIERINFO=17, size=56.
# libproc's audit-token signal validates the current pidversion in-kernel;
# a concurrent exec changes that version and causes ESRCH rather than a PID
# signal to a different executable/process.
UNIQUE_FLAVOR = 17
UNIQUE_SIZE = 56
try:
    SIGNAL_WITH_TOKEN = LIB.proc_signal_with_audittoken
    SIGNAL_WITH_TOKEN.argtypes = [ctypes.c_void_p, ctypes.c_int]
    SIGNAL_WITH_TOKEN.restype = ctypes.c_int
except AttributeError:
    SIGNAL_WITH_TOKEN = None


def unique_identity(pid):
    raw = ctypes.create_string_buffer(UNIQUE_SIZE)
    n = LIB.proc_pidinfo(pid, UNIQUE_FLAVOR, 0, raw, UNIQUE_SIZE)
    if n != UNIQUE_SIZE:
        raise RuntimeError('member_unique_identity_unconfirmed')
    uniqueid = struct.unpack_from('<Q', raw, 16)[0]
    version = struct.unpack_from('<i', raw, 32)[0]
    if not uniqueid or version <= 0:
        raise RuntimeError('member_unique_identity_invalid')
    return {'uniqueid': str(uniqueid), 'pidversion': version}


def checked_member(pid, expected_resource=None):
    process_snapshot.checked_abi()
    lib = process_snapshot.open_libproc()
    uid = os.geteuid()
    before = process_snapshot.identity(lib, uid, pid)
    first_unique = unique_identity(pid)
    first_co = coalition(pid)
    after = process_snapshot.identity(lib, uid, pid)
    second_unique = unique_identity(pid)
    second_co = coalition(pid)
    if before != after or first_unique != second_unique or not first_co or first_co != second_co:
        raise RuntimeError('member_identity_changed')
    if expected_resource is not None and first_co['resource'] != expected_resource:
        raise RuntimeError('member_coalition_changed')
    return {**after, **second_unique, 'coalition': second_co}


def signal_member(raw):
    if SIGNAL_WITH_TOKEN is None:
        raise RuntimeError('audit_token_signal_unsupported')
    target = json.loads(raw)
    keys = {'pid', 'euid', 'ruid', 'startSec', 'startUsec',
            'uniqueid', 'pidversion', 'resource', 'signal'}
    if not isinstance(target, dict) or set(target) != keys:
        raise RuntimeError('member_request_invalid')
    if any(type(target[k]) is not int for k in keys - {'uniqueid'}) or \
            not isinstance(target['uniqueid'], str) or \
            not target['uniqueid'].isdigit() or \
            target['pid'] <= 0 or target['resource'] <= 0 or \
            target['signal'] not in (signal.SIGTERM, signal.SIGKILL):
        raise RuntimeError('member_request_invalid')
    current = checked_member(target['pid'], target['resource'])
    for key in ('pid', 'euid', 'ruid', 'startSec', 'startUsec',
                'uniqueid', 'pidversion'):
        if current[key] != target[key]:
            raise RuntimeError('member_identity_changed')
    # audit_token_t.val[5] is pid and val[7] is pidversion. Kernel lookup
    # validates version while holding its process reference. Other slots are
    # unused by proc_find_audit_token, not authority to signal a foreign UID.
    token = (ctypes.c_uint32 * 8)()
    token[5] = target['pid']
    token[7] = target['pidversion']
    result = SIGNAL_WITH_TOKEN(ctypes.byref(token), target['signal'])
    if result != 0:
        if result == errno.ESRCH:
            return {'verified': False, 'reason': 'member_changed_before_signal'}
        raise RuntimeError('member_signal_unconfirmed')
    return {'verified': True, 'signalled': True,
            'identity': {k: current[k] for k in ('pid', 'uniqueid', 'pidversion')}}


def coalition(pid):
    raw = ctypes.create_string_buffer(64)
    n = LIB.proc_pidinfo(pid, 20, 0, raw, len(raw))  # PROC_PIDCOALITIONINFO
    if n != 40:
        return None
    resource, jetsam, *_ = struct.unpack_from('<5Q', raw)
    return {'resource': resource, 'jetsam': jetsam}


def counts(target):
    needed = LIB.proc_listcoalitions(2, 0, None, 0)
    if needed <= 0 or needed % 16 or needed > 1024 * 1024:
        raise RuntimeError('coalition_list_size_unconfirmed')
    buf = ctypes.create_string_buffer(needed + 4096)
    n = LIB.proc_listcoalitions(2, 0, buf, len(buf))
    if n < 0 or n > len(buf) or n % 16:
        raise RuntimeError('coalition_list_unconfirmed')
    matches = [count for off in range(0, n, 16)
               for cid, typ, count in [struct.unpack_from('<QII', buf, off)]
               if typ == 0 and cid == target]
    if len(matches) > 1:
        raise RuntimeError('coalition_duplicate')
    return matches[0] if matches else None


def identity(pid):
    # The startup leader and its creator are known live current-UID PIDs.
    # Querying their exact birth twice avoids treating unrelated whole-machine
    # process churn as loss of an otherwise stable original identity.
    process_snapshot.checked_abi()
    lib = process_snapshot.open_libproc()
    uid = os.geteuid()
    try:
        return checked_member(pid)
    except process_snapshot.UnknownSnapshot:
        # A missing or changed owner after crash must be checked against an
        # all-visible native snapshot. It is never inferred from one failed
        # proc_pidinfo read or a PID-only existence query.
        snap = process_snapshot.snapshot(all_visible=True)
        if not snap['verified']:
            raise RuntimeError('native_' + str(snap['reason']))
        row = next((item for item in snap['rows'] if item['pid'] == pid), None)
        if row is None:
            return None
        return checked_member(pid)


def observe(target):
    # A complete native identity list is required even when the coalition
    # count is zero. A churned/partial list cannot be used as release proof.
    before = counts(target)
    snap = process_snapshot.snapshot(all_visible=True)
    if not snap['verified']:
        raise RuntimeError('native_' + str(snap['reason']))
    members = []
    for row in snap['rows']:
        co = coalition(row['pid'])
        if co is not None and co['resource'] == target:
            checked = checked_member(row['pid'], target)
            if any(checked[key] != row[key] for key in
                   ('pid', 'euid', 'ruid', 'startSec', 'startUsec')):
                raise RuntimeError('coalition_member_changed')
            members.append(checked)
    after = counts(target)
    if before != after:
        raise RuntimeError('coalition_count_changed')
    if before is not None and before != len(members):
        raise RuntimeError('coalition_members_incomplete')
    if before is None and members:
        raise RuntimeError('coalition_missing_with_members')
    return {'verified': True, 'count': before or 0,
            'listed': before is not None, 'members': members}


def send_line(sock, value):
    sock.sendall((json.dumps(value, separators=(',', ':')) + '\n').encode())


def connect(directory, name, capability):
    sock = socket.socket(socket.AF_UNIX)
    sock.settimeout(10)
    sock.connect(str(directory / (name + '.sock')))
    sock.sendall((capability + '\n').encode('ascii'))
    if sock.recv(1) != b'1':
        raise RuntimeError('socket_auth_failed')
    return sock


def launch(directory):
    fd = os.open(directory / 'launch.json', os.O_RDONLY | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        if (not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or
                stat.S_IMODE(st.st_mode) != 0o600 or st.st_nlink != 1):
            raise RuntimeError('launch_file_identity_unconfirmed')
        with os.fdopen(fd, 'r') as handle:
            fd = -1
            config = json.load(handle)
    finally:
        if fd >= 0:
            os.close(fd)
    capability = config['capability']
    streams = {name: connect(directory, name, capability)
               for name in ('control', 'stdin', 'stdout', 'stderr')}
    # Peer validates this identity against an independent native observation
    # before ACK. Until then no provider bytes can enter the stdout channel.
    co = coalition(os.getpid())
    if not co or not co['resource']:
        raise RuntimeError('job_coalition_unconfirmed')
    raw = ctypes.create_string_buffer(136)
    if LIB.proc_pidinfo(os.getpid(), 3, 0, raw, 136) != 136:
        raise RuntimeError('job_birth_unconfirmed')
    send_line(streams['control'], {'pid': os.getpid(),
              'startSec': struct.unpack_from('<Q', raw, 120)[0],
              'startUsec': struct.unpack_from('<Q', raw, 128)[0],
              'coalition': co})
    if streams['control'].recv(1) != b'1':
        raise RuntimeError('job_identity_rejected')
    streams['control'].close()
    os.chdir(config['cwd'])
    # socket.settimeout made each descriptor O_NONBLOCK. dup2 carries that
    # open-file-description flag into the exec'd command; ordinary blocking
    # stdin readers then fail with EAGAIN before the caller writes input.
    for name, sock in streams.items():
        if name == 'control':
            continue
        sock.setblocking(True)
    for number, name in enumerate(('stdin', 'stdout', 'stderr')):
        os.dup2(streams[name].fileno(), number)
    for name, sock in streams.items():
        if name == 'control':
            continue
        sock.close()
    os.execve(config['command'], [config['command'], *config['args']], config['env'])


def main():
    mode = sys.argv[1]
    if mode == 'launch' and len(sys.argv) == 3:
        launch(pathlib.Path(sys.argv[2]))
        return 0
    if mode == 'inspect' and len(sys.argv) == 3:
        print(json.dumps({'verified': True, 'identity': identity(int(sys.argv[2]))}))
        return 0
    if mode == 'observe' and len(sys.argv) == 3:
        print(json.dumps(observe(int(sys.argv[2]))))
        return 0
    if mode == 'signal-member' and len(sys.argv) == 3:
        print(json.dumps(signal_member(sys.argv[2])))
        return 0
    raise RuntimeError('invalid_mode')


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:
        # Never include exception text: paths/argv/env may be present there.
        if len(sys.argv) > 1 and sys.argv[1] != 'launch':
            print(json.dumps({'verified': False, 'reason': str(exc).split(':', 1)[0]}))
        sys.exit(2)
