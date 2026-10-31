#!/usr/bin/env python3
"""One-shot, unprivileged Linux task supervisor. No provider protocol lives here."""

import ctypes
import hmac
import json
import os
import select
import signal
import socket
import subprocess
import sys
import threading
import time

from process_identities import linux_boot_id, linux_identity
from process_snapshot import UnknownSnapshot


PR_SET_CHILD_SUBREAPER = 36
SCOPE = "linux-original-subreaper-current-descendants"


def durable_json(path, value):
    temporary = path + ".new"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        folder = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(folder)
        finally:
            os.close(folder)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def birth(row):
    return (row["kind"], row["pid"], row["euid"], row["ruid"],
            row["bootId"], row["startTicks"])


class Supervisor:
    def __init__(self, directory):
        self.directory = directory
        self.record_path = os.path.join(directory, "record.json")
        with open(os.path.join(directory, "launch.json"), "r", encoding="utf-8") as stream:
            self.launch = json.load(stream)
        with open(self.record_path, "r", encoding="utf-8") as stream:
            self.record = json.load(stream)
        if self.record["phase"] != "intent" or self.record["attempted"] is not True:
            raise RuntimeError("job_intent_unconfirmed")
        self.boot = linux_boot_id()
        self.uid = os.geteuid()
        self.ruid = os.getuid()
        self.streams = {}
        self.threads = []
        self.child = None
        self.known = {}
        self.output_lost = False
        self.record_lock = threading.Lock()

    def persist(self, **fields):
        with self.record_lock:
            self.record = {**self.record, **fields, "generation": self.record["generation"] + 1}
            durable_json(self.record_path, self.record)

    def identity(self, pid):
        return linux_identity(pid, self.uid, self.ruid, self.boot)

    def children(self, pid):
        task_path = f"/proc/{pid}/task"
        tids = os.listdir(task_path)
        if not tids or any(not tid.isdecimal() for tid in tids):
            raise RuntimeError("job_threads_unconfirmed")
        values = []
        for tid in tids:
            with open(f"{task_path}/{tid}/children", "r", encoding="ascii") as stream:
                raw = stream.read(65536).strip()
            values.extend([] if not raw else int(value) for value in raw.split())
        if any(value <= 1 for value in values) or len(values) != len(set(values)):
            raise RuntimeError("job_children_unconfirmed")
        return values

    def scan_once(self):
        rows = {}
        parents = [(os.getpid(), self.children(os.getpid()))]
        while parents:
            parent, children = parents.pop()
            for pid in children:
                if pid in rows:
                    raise RuntimeError("job_children_unconfirmed")
                try:
                    row = self.identity(pid)
                except UnknownSnapshot:
                    # A child can remain in its live parent's children list
                    # after exit. Only a readable pidfd proves it is dead;
                    # other identity failures keep the observation unknown.
                    descriptor = os.pidfd_open(pid, 0)
                    try:
                        if not select.select([descriptor], [], [], 0)[0]:
                            raise
                    finally:
                        os.close(descriptor)
                    continue
                if row["ppid"] != parent or birth(self.known.get(pid, row)) != birth(row):
                    raise RuntimeError("job_member_identity_changed")
                rows[pid] = row
                parents.append((pid, self.children(pid)))
        return rows

    def scan(self):
        first = self.scan_once()
        second = self.scan_once()
        if first != second:
            raise RuntimeError("job_descendants_changed")
        self.known.update(second)
        return list(second.values())

    def reap(self):
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return True
            if pid == 0:
                return False

    def observe(self):
        try:
            self.reap()
            members = self.scan()
            return {"verified": True, "unknown": False, "retired": False,
                    "members": members, "count": len(members), "scope": SCOPE,
                    "resultUnknown": True, "outputLost": self.output_lost}
        except (UnknownSnapshot, OSError, RuntimeError, ValueError, KeyError):
            return {"verified": False, "unknown": True, "retired": False,
                    "reason": "job_descendants_unconfirmed", "scope": SCOPE}

    def relay_output(self, pipe, name):
        connection = self.streams[name]
        connection.settimeout(1)
        try:
            while True:
                data = os.read(pipe.fileno(), 65536)
                if not data:
                    break
                if connection is not None:
                    try:
                        connection.sendall(data)
                    except (OSError, socket.timeout):
                        self.output_lost = True
                        self.persist(outputLost=True, resultUnknown=True)
                        connection.close()
                        connection = None
        finally:
            pipe.close()
            if connection is not None:
                connection.close()

    def relay_input(self):
        connection = self.streams["stdin"]
        try:
            while True:
                data = connection.recv(65536)
                if not data:
                    break
                self.child.stdin.write(data)
                self.child.stdin.flush()
        except (OSError, BrokenPipeError):
            pass
        finally:
            self.child.stdin.close()
            connection.close()

    def start(self):
        if self.record["phase"] != "ready" or set(self.streams) != {"stdin", "stdout", "stderr"}:
            raise RuntimeError("job_start_already_attempted")
        self.persist(phase="launch_intent")
        self.child = subprocess.Popen([self.launch["command"], *self.launch["args"]],
                                      cwd=self.record["workspace"], env=self.launch["env"],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, close_fds=True)
        leader = self.identity(self.child.pid)
        if leader["ppid"] != os.getpid():
            raise RuntimeError("job_leader_unconfirmed")
        self.known[leader["pid"]] = leader
        self.persist(phase="running", bridgeIdentity=leader)
        for target, args in ((self.relay_input, ()),
                             (self.relay_output, (self.child.stdout, "stdout")),
                             (self.relay_output, (self.child.stderr, "stderr"))):
            thread = threading.Thread(target=target, args=args, daemon=True)
            thread.start()
            self.threads.append(thread)
        return {"verified": True, "identity": leader, "pid": leader["pid"]}

    def signal_members(self, members, number):
        for row in members:
            try:
                descriptor = os.pidfd_open(row["pid"], 0)
            except ProcessLookupError:
                continue
            try:
                current = self.identity(row["pid"])
                if birth(current) != birth(row):
                    raise RuntimeError("job_member_identity_changed")
                signal.pidfd_send_signal(descriptor, number, None, 0)
            except ProcessLookupError:
                continue
            finally:
                os.close(descriptor)

    def stop(self):
        if self.record["phase"] not in ("ready", "running", "launch_intent", "stop_intent"):
            raise RuntimeError("job_stop_state_unconfirmed")
        if self.record["phase"] != "stop_intent":
            self.persist(phase="stop_intent", resultUnknown=True)
        if "stdin" in self.streams:
            try:
                self.streams["stdin"].shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        for number in (signal.SIGTERM, signal.SIGKILL):
            for _ in range(20):
                self.reap()
                members = self.scan()
                if not members and self.reap():
                    self.persist(phase="retired", resultUnknown=True, outputLost=self.output_lost)
                    return {"verified": True, "retired": True, "unknown": False,
                            "members": [], "count": 0, "scope": SCOPE,
                            "resultUnknown": True, "outputLost": self.output_lost}
                self.signal_members(members, number)
                time.sleep(0.05)
        return {"verified": False, "retired": False, "unknown": True,
                "reason": "job_members_still_live", "scope": SCOPE}

    def serve(self):
        if ctypes.CDLL(None, use_errno=True).prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
            raise RuntimeError("job_subreaper_unavailable")
        own = self.identity(os.getpid())
        self.persist(phase="ready", supervisorIdentity=own)
        directory_fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        path = f"/proc/self/fd/{directory_fd}/control.sock"
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(path)
        os.chmod(path, 0o600)
        listener.listen(8)
        try:
            while True:
                connection, _ = listener.accept()
                connection.settimeout(5)
                try:
                    raw = b""
                    while b"\n" not in raw and len(raw) < 4096:
                        part = connection.recv(4096)
                        if not part:
                            break
                        raw += part
                    request = json.loads(raw.split(b"\n", 1)[0])
                    if not hmac.compare_digest(request.get("capability", ""), self.launch["capability"]):
                        raise RuntimeError("job_capability_unconfirmed")
                    operation = request.get("op")
                    if operation in ("stdin", "stdout", "stderr"):
                        if self.record["phase"] != "ready" or operation in self.streams:
                            raise RuntimeError("job_stream_unavailable")
                        connection.sendall(b'{"verified":true}\n')
                        connection.settimeout(None)
                        self.streams[operation] = connection
                        connection = None
                    elif operation == "start":
                        response = self.start()
                        connection.sendall((json.dumps(response) + "\n").encode())
                    elif operation == "observe":
                        response = self.observe()
                        connection.sendall((json.dumps(response) + "\n").encode())
                    elif operation in ("stop", "recheck"):
                        response = self.stop() if operation == "stop" or self.record["phase"] == "stop_intent" else self.observe()
                        connection.sendall((json.dumps(response) + "\n").encode())
                        if response.get("retired"):
                            break
                    else:
                        raise RuntimeError("job_operation_invalid")
                except (UnknownSnapshot, OSError, RuntimeError, ValueError, KeyError, TypeError):
                    if connection is not None:
                        try:
                            connection.sendall(b'{"verified":false,"unknown":true,"retired":false,"reason":"job_operation_unconfirmed"}\n')
                        except OSError:
                            pass
                finally:
                    if connection is not None:
                        connection.close()
        finally:
            listener.close()
            os.unlink(path)
            os.close(directory_fd)


if __name__ == "__main__":
    if sys.platform != "linux" or len(sys.argv) != 2:
        raise SystemExit(2)
    try:
        Supervisor(sys.argv[1]).serve()
    except BaseException:
        # The caller sees an absent/unconfirmed supervisor; never leak launch data.
        raise SystemExit(2)
