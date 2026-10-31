#!/usr/bin/env python3
"""One PTY shell, one direct parent, and one capability-authenticated local client.

This process deliberately proves only its direct child's lifecycle.  It does
not classify background jobs, other tmux clients, or workspace writers.  A
caller must establish those facts before treating a parked shell as harmless.
"""

import array
import base64
import errno
import fcntl
import hmac
import json
import os
import pty
import selectors
import signal
import socket
import sys
import termios
import time
import select

MAX_LINE = 65536
MAX_DATA = 16384
MAX_OUT = 1048576
MAX_REPLAY = 65536
VERSION = 1


def send_json(sock, value):
    payload = (json.dumps(value, separators=(",", ":")) + "\n").encode()
    sock.sendall(payload)


def winsize(fd, rows, cols):
    import struct
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def foreground_group(fd):
    value = array.array("i", [0])
    fcntl.ioctl(fd, termios.TIOCGPGRP, value, True)
    return value[0]


class Supervisor:
    def __init__(self, config):
        self.token = config["capability"]
        self.path = config["socketPath"]
        self.selector = selectors.DefaultSelector()
        self.client = None
        self.client_auth = False
        self.client_in = bytearray()
        self.client_out = bytearray()
        self.relay_enabled = bool(config.get("relayCapability"))
        self.relay_token = config.get("relayCapability")
        self.relay = None
        self.relay_auth = False
        self.relay_in = bytearray()
        self.relay_out = bytearray()
        self.relay_path = config.get("relaySocketPath")
        self.input_epoch = 1
        self.input_open = True
        self.output_offset = 0
        self.replay = bytearray()
        self.replay_dropped = 0
        self.output_gap_unknown = False
        self.pty_eof = False
        self.relay_end_announced = False
        self.child_state = "running"
        self.exit_code = None
        self.closed = False
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.path)
        os.chmod(self.path, 0o600)
        self.server.listen(2)
        self.server.setblocking(False)
        self.selector.register(self.server, selectors.EVENT_READ, "accept")
        if self.relay_enabled:
            self.relay_server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.relay_server.bind(self.relay_path)
            os.chmod(self.relay_path, 0o600)
            self.relay_server.listen(1)
            self.relay_server.setblocking(False)
            self.selector.register(self.relay_server, selectors.EVENT_READ, "relay_accept")
        self.child, self.master = pty.fork()
        if self.child == 0:
            try:
                os.chdir(config["cwd"])
                os.execvpe(config["shell"], [config["shell"], *config["args"]], os.environ)
            except BaseException:
                os._exit(127)
        winsize(self.master, config["rows"], config["cols"])
        os.set_blocking(self.master, False)
        self.selector.register(self.master, selectors.EVENT_READ, "pty")

    def poll_child(self):
        if self.child_state in ("exited", "unknown"):
            return
        flags = os.WNOHANG | os.WUNTRACED | getattr(os, "WCONTINUED", 0)
        while True:
            try:
                pid, status = os.waitpid(self.child, flags)
            except InterruptedError:
                continue
            except ChildProcessError:
                # Another reaper or lost parentage invalidates the direct-child
                # capability.  It says nothing about whether the shell stopped.
                self.child_state = "unknown"
                self.exit_code = None
                return
            if pid == 0:
                return
            if os.WIFEXITED(status):
                self.child_state = "exited"
                self.exit_code = os.WEXITSTATUS(status)
                self.queue({"type": "exit", "exitCode": self.exit_code})
                return
            if os.WIFSIGNALED(status):
                self.child_state = "exited"
                self.exit_code = 128 + os.WTERMSIG(status)
                self.queue({"type": "exit", "exitCode": self.exit_code})
                return
            if os.WIFSTOPPED(status):
                self.child_state = "stopped"
            elif hasattr(os, "WIFCONTINUED") and os.WIFCONTINUED(status):
                self.child_state = "running"

    def wait_state(self, desired, timeout=2.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.poll_child()
            if self.child_state == desired:
                return True
            if self.child_state == "exited":
                return False
            time.sleep(0.01)
        self.poll_child()
        return self.child_state == desired

    def queue(self, value):
        if self.client is None or not self.client_auth:
            return
        payload = (json.dumps(value, separators=(",", ":")) + "\n").encode()
        if len(self.client_out) + len(payload) > MAX_OUT:
            self.drop_client()
            return
        self.client_out.extend(payload)
        self.selector.modify(self.client, selectors.EVENT_READ | selectors.EVENT_WRITE, "client")

    def queue_relay(self, value):
        if self.relay is None or not self.relay_auth:
            return
        payload = (json.dumps(value, separators=(",", ":")) + "\n").encode()
        if len(self.relay_out) + len(payload) > MAX_OUT:
            self.drop_relay()
            return
        self.relay_out.extend(payload)
        self.selector.modify(self.relay, selectors.EVENT_READ | selectors.EVENT_WRITE, "relay")

    def maybe_finish_relay(self):
        # The child can be reaped before its final PTY bytes are read. Deliver
        # the end marker only after EOF, behind every queued output frame.
        if (self.relay_enabled and self.relay_auth and self.relay is not None and
                self.child_state == "exited" and self.pty_eof and
                not self.relay_end_announced):
            self.queue_relay({"type": "child_exited", "exitCode": self.exit_code,
                              "outputOffset": self.output_offset})
            if self.relay is not None:
                self.relay_end_announced = True

    def drop_client(self):
        if self.client is not None:
            try:
                self.selector.unregister(self.client)
            except Exception:
                pass
            self.client.close()
        self.client = None
        self.client_auth = False
        self.client_in.clear()
        self.client_out.clear()
        if self.relay_enabled:
            self.input_open = False
            self.input_epoch += 1
            self.queue_relay({"type": "freeze", "epoch": self.input_epoch})

    def drop_relay(self):
        if self.relay_auth:
            # Bytes written to the socket but not acknowledged by the relay
            # cannot be counted as delivered terminal output.
            self.output_gap_unknown = True
        if self.relay is not None:
            try:
                self.selector.unregister(self.relay)
            except Exception:
                pass
            self.relay.close()
        self.relay = None
        self.relay_auth = False
        self.relay_in.clear()
        self.relay_out.clear()
        if self.relay_enabled:
            self.input_open = False
            self.input_epoch += 1

    def reply(self, request, ok, result=None, error=None):
        self.queue({"type": "reply", "id": request.get("id"), "ok": ok,
                    **({"result": result} if ok else {"error": error})})

    def write_pty(self, data):
        remaining = memoryview(data)
        deadline = time.monotonic() + 1.0
        while remaining:
            try:
                written = os.write(self.master, remaining)
                remaining = remaining[written:]
            except BlockingIOError:
                import select
                if time.monotonic() >= deadline:
                    raise TimeoutError("pty_write_timeout_after_partial_input")
                select.select([], [self.master], [], max(0, deadline - time.monotonic()))

    def freeze_relay(self):
        self.input_open = False
        self.input_epoch += 1
        if self.relay is None:
            return
        epoch = self.input_epoch
        self.queue_relay({"type": "freeze", "epoch": epoch})
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline and self.relay is not None:
            readable, writable, _ = select.select([self.relay], [self.relay] if self.relay_out else [], [],
                                                   max(0, deadline - time.monotonic()))
            if writable:
                try:
                    count = self.relay.send(self.relay_out)
                    del self.relay_out[:count]
                except (BlockingIOError, BrokenPipeError, ConnectionResetError):
                    self.drop_relay()
                    break
            if readable:
                try:
                    data = self.relay.recv(MAX_LINE)
                except (BlockingIOError, BrokenPipeError, ConnectionResetError):
                    self.drop_relay()
                    break
                if not data:
                    self.drop_relay()
                    break
                self.relay_in.extend(data)
                if len(self.relay_in) > MAX_LINE:
                    self.drop_relay()
                    break
                while b"\n" in self.relay_in:
                    line, _, rest = self.relay_in.partition(b"\n")
                    self.relay_in = bytearray(rest)
                    try:
                        frame = json.loads(line)
                    except (ValueError, TypeError):
                        self.drop_relay()
                        break
                    if frame == {"v": VERSION, "op": "freeze_ack", "epoch": epoch}:
                        return
                    # Any input already delivered to this socket is old-epoch
                    # input. It is discarded, never deferred until resume.
                    if not isinstance(frame, dict) or frame.get("op") not in ("input", "resize"):
                        self.drop_relay()
                        break
        if self.relay is not None:
            self.drop_relay()
        raise ValueError("relay_freeze_unconfirmed")

    def activate_relay(self):
        self.input_epoch += 1
        if self.relay is not None:
            self.queue_relay({"type": "activate", "epoch": self.input_epoch})
            # Input remains closed until the relay acknowledges the fresh
            # epoch. A missed acknowledgement cannot authorize old bytes.
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline and self.relay is not None:
                readable, writable, _ = select.select([self.relay], [self.relay] if self.relay_out else [], [],
                                                       max(0, deadline - time.monotonic()))
                if writable:
                    try:
                        count = self.relay.send(self.relay_out)
                        del self.relay_out[:count]
                    except (BlockingIOError, BrokenPipeError, ConnectionResetError):
                        self.drop_relay()
                        break
                if readable:
                    try:
                        data = self.relay.recv(MAX_LINE)
                    except (BlockingIOError, BrokenPipeError, ConnectionResetError):
                        self.drop_relay()
                        break
                    if not data:
                        self.drop_relay()
                        break
                    self.relay_in.extend(data)
                    if len(self.relay_in) > MAX_LINE:
                        self.drop_relay()
                        break
                    while b"\n" in self.relay_in:
                        line, _, rest = self.relay_in.partition(b"\n")
                        self.relay_in = bytearray(rest)
                        try:
                            frame = json.loads(line)
                        except (ValueError, TypeError):
                            self.drop_relay()
                            break
                        if frame == {"v": VERSION, "op": "activate_ack", "epoch": self.input_epoch}:
                            self.input_open = True
                            return
                        if not isinstance(frame, dict) or frame.get("op") not in ("input", "resize"):
                            self.drop_relay()
                            break
            if self.relay is not None:
                self.drop_relay()
            raise ValueError("relay_activate_unconfirmed")
        # No relay is connected, so there is no input source to authorize.
        self.input_open = False

    def handle_request(self, request):
        op = request.get("op")
        self.poll_child()
        if op == "status":
            return {"state": self.child_state, "childPid": self.child,
                    "supervisorPid": os.getpid(), "exitCode": self.exit_code,
                    "relayConnected": self.relay_enabled and self.relay_auth and self.relay is not None,
                    "inputFrozen": self.relay_enabled and not self.input_open,
                    "inputEpoch": self.input_epoch,
                    "outputOffset": self.output_offset, "outputGapBytes": self.replay_dropped,
                    "outputGapUnknown": self.output_gap_unknown,
                    "reason": "child_parentage_lost" if self.child_state == "unknown" else None}
        if self.child_state == "unknown":
            raise ValueError("child_identity_unknown")
        if op == "input":
            if self.relay_enabled:
                raise ValueError("relay_mode_input_forbidden")
            if self.child_state != "running":
                raise ValueError("child_not_running")
            raw = request.get("data")
            if not isinstance(raw, str) or len(raw) > 4 * MAX_DATA // 3 + 8:
                raise ValueError("invalid_input")
            try:
                data = base64.b64decode(raw, validate=True)
            except (ValueError, base64.binascii.Error):
                raise ValueError("invalid_input")
            if len(data) > MAX_DATA:
                raise ValueError("invalid_input")
            self.write_pty(data)
            return {"written": len(data)}
        if op == "resize":
            rows, cols = request.get("rows"), request.get("cols")
            if not isinstance(rows, int) or not 5 <= rows <= 100 or not isinstance(cols, int) or not 20 <= cols <= 300:
                raise ValueError("invalid_size")
            winsize(self.master, rows, cols)
            return {"rows": rows, "cols": cols}
        if op == "park":
            if self.child_state == "exited":
                raise ValueError("child_exited")
            # Freeze the relay and confirm its ACK even when an external actor
            # has already stopped the shell. A stopped shell can still leave a
            # foreground job running in a different process group.
            if self.relay_enabled:
                self.freeze_relay()
            try:
                if foreground_group(self.master) != self.child:
                    raise ValueError("foreground_job_active")
            except OSError:
                raise ValueError("foreground_group_unavailable")
            if self.child_state == "stopped":
                return {"parked": True, "childPid": self.child}
            # This child has not been reaped.  If it exits between waitpid and
            # kill, its zombie still reserves the PID; no unrelated PID is hit.
            os.kill(self.child, signal.SIGSTOP)
            if not self.wait_state("stopped"):
                raise ValueError("stop_unconfirmed")
            return {"parked": True, "childPid": self.child}
        if op == "resume":
            if self.child_state == "running" and self.relay_enabled and not self.input_open:
                self.activate_relay()
                return {"resumed": True, "childPid": self.child}
            if self.child_state != "stopped":
                raise ValueError("child_not_parked")
            os.kill(self.child, signal.SIGCONT)
            if not self.wait_state("running"):
                raise ValueError("resume_unconfirmed")
            if self.relay_enabled:
                self.activate_relay()
            return {"resumed": True, "childPid": self.child}
        if op == "shutdown":
            if self.child_state != "exited":
                raise ValueError("child_still_alive")
            self.closed = True
            return {"closed": True}
        raise ValueError("unknown_operation")

    def read_client(self):
        try:
            data = self.client.recv(65536)
        except BlockingIOError:
            return
        except (ConnectionResetError, BrokenPipeError):
            self.drop_client()
            return
        if not data:
            self.drop_client()
            return
        self.client_in.extend(data)
        if len(self.client_in) > MAX_LINE:
            self.drop_client()
            return
        while b"\n" in self.client_in and self.client is not None:
            line, _, rest = self.client_in.partition(b"\n")
            self.client_in = bytearray(rest)
            request = None
            try:
                request = json.loads(line)
                if not isinstance(request, dict) or request.get("v") != VERSION:
                    raise ValueError("invalid_frame")
                if not self.client_auth:
                    candidate = request.get("capability")
                    if request.get("op") != "hello" or not isinstance(candidate, str) or not hmac.compare_digest(candidate, self.token):
                        self.drop_client()
                        return
                    self.client_auth = True
                    self.queue({"type": "hello", "childPid": self.child,
                                "supervisorPid": os.getpid(), "state": self.child_state})
                else:
                    if not isinstance(request.get("id"), int) or request["id"] < 1:
                        raise ValueError("invalid_request_id")
                    self.reply(request, True, self.handle_request(request))
            except (ValueError, TypeError, OSError) as error:
                if self.client_auth:
                    self.reply(request if isinstance(request, dict) else {}, False,
                               error=str(error)[:120])
                else:
                    self.drop_client()
                    return

    def read_relay(self):
        try:
            data = self.relay.recv(65536)
        except BlockingIOError:
            return
        except (ConnectionResetError, BrokenPipeError):
            self.drop_relay()
            return
        if not data:
            self.drop_relay()
            return
        self.relay_in.extend(data)
        if len(self.relay_in) > MAX_LINE:
            self.drop_relay()
            return
        while b"\n" in self.relay_in and self.relay is not None:
            line, _, rest = self.relay_in.partition(b"\n")
            self.relay_in = bytearray(rest)
            try:
                frame = json.loads(line)
                if not isinstance(frame, dict) or frame.get("v") != VERSION:
                    raise ValueError("invalid_relay_frame")
                if not self.relay_auth:
                    candidate = frame.get("capability")
                    if frame.get("op") != "hello" or not isinstance(candidate, str) or not hmac.compare_digest(candidate, self.relay_token):
                        self.drop_relay()
                        return
                    self.relay_auth = True
                    self.relay_end_announced = False
                    self.queue_relay({"type": "relay_ready", "epoch": self.input_epoch,
                                      "inputOpen": self.input_open and self.child_state == "running",
                                      "outputOffset": self.output_offset - len(self.replay),
                                      "gapBytes": self.replay_dropped,
                                      "gapUnknown": self.output_gap_unknown})
                    if self.replay:
                        self.queue_relay({"type": "output", "data": base64.b64encode(self.replay).decode(),
                                          "offset": self.output_offset - len(self.replay)})
                        self.replay.clear()
                        self.replay_dropped = 0
                        self.output_gap_unknown = False
                    self.maybe_finish_relay()
                    continue
                if frame.get("op") == "input":
                    raw = frame.get("data")
                    if not isinstance(raw, str) or len(raw) > 4 * MAX_DATA // 3 + 8:
                        raise ValueError("invalid_relay_input")
                    payload = base64.b64decode(raw, validate=True)
                    if len(payload) > MAX_DATA:
                        raise ValueError("invalid_relay_input")
                    self.poll_child()
                    if (self.child_state == "running" and self.input_open and
                            type(frame.get("epoch")) is int and frame["epoch"] == self.input_epoch):
                        self.write_pty(payload)
                    # Parked/unknown/exited input is never queued for later.
                elif frame.get("op") == "resize":
                    rows, cols = frame.get("rows"), frame.get("cols")
                    if not isinstance(rows, int) or not 5 <= rows <= 100 or not isinstance(cols, int) or not 20 <= cols <= 300:
                        raise ValueError("invalid_relay_size")
                    winsize(self.master, rows, cols)
                elif frame.get("op") in ("freeze_ack", "activate_ack"):
                    # ACKs are consumed synchronously by the control operation.
                    pass
                else:
                    raise ValueError("unknown_relay_operation")
            except (ValueError, TypeError, OSError):
                self.drop_relay()
                return

    def run(self):
        while not self.closed or self.client_out:
            self.poll_child()
            self.maybe_finish_relay()
            for key, mask in self.selector.select(0.15):
                if key.data == "accept":
                    conn, _ = self.server.accept()
                    if self.client is not None:
                        conn.close()
                    else:
                        conn.setblocking(False)
                        self.client = conn
                        self.selector.register(conn, selectors.EVENT_READ, "client")
                elif key.data == "relay_accept":
                    conn, _ = self.relay_server.accept()
                    if self.relay is not None:
                        conn.close()
                    else:
                        conn.setblocking(False)
                        self.relay = conn
                        self.selector.register(conn, selectors.EVENT_READ, "relay")
                elif key.data == "pty":
                    try:
                        data = os.read(self.master, MAX_DATA)
                    except BlockingIOError:
                        continue
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        data = b""
                    if data:
                        offset = self.output_offset
                        self.output_offset += len(data)
                        frame = {"type": "output", "data": base64.b64encode(data).decode(), "offset": offset}
                        if self.relay_enabled:
                            if self.relay is not None and self.relay_auth:
                                self.queue_relay(frame)
                            else:
                                self.replay.extend(data)
                                if len(self.replay) > MAX_REPLAY:
                                    excess = len(self.replay) - MAX_REPLAY
                                    del self.replay[:excess]
                                    self.replay_dropped += excess
                        else:
                            self.queue(frame)
                    else:
                        self.selector.unregister(self.master)
                        self.pty_eof = True
                        self.maybe_finish_relay()
                elif key.data == "client":
                    if mask & selectors.EVENT_READ:
                        self.read_client()
                    if self.client is not None and mask & selectors.EVENT_WRITE:
                        try:
                            count = self.client.send(self.client_out)
                            del self.client_out[:count]
                        except (BlockingIOError, BrokenPipeError, ConnectionResetError):
                            self.drop_client()
                        if self.client is not None and not self.client_out:
                            self.selector.modify(self.client, selectors.EVENT_READ, "client")
                elif key.data == "relay":
                    if mask & selectors.EVENT_READ:
                        self.read_relay()
                    if self.relay is not None and mask & selectors.EVENT_WRITE:
                        try:
                            count = self.relay.send(self.relay_out)
                            del self.relay_out[:count]
                        except (BlockingIOError, BrokenPipeError, ConnectionResetError):
                            self.drop_relay()
                        if self.relay is not None and not self.relay_out:
                            self.selector.modify(self.relay, selectors.EVENT_READ, "relay")
        self.drop_client()
        self.drop_relay()
        self.server.close()
        if self.relay_enabled:
            self.relay_server.close()
            os.unlink(self.relay_path)
        os.close(self.master)
        os.unlink(self.path)


def main():
    line = sys.stdin.buffer.readline(MAX_LINE + 1)
    if not line.endswith(b"\n") or len(line) > MAX_LINE:
        return 2
    try:
        config = json.loads(line)
        if (config.get("v") != VERSION or not isinstance(config.get("capability"), str) or
                len(config["capability"]) != 64 or not isinstance(config.get("socketPath"), str) or
                not isinstance(config.get("shell"), str) or not os.path.isabs(config["shell"]) or
                not isinstance(config.get("cwd"), str) or not os.path.isdir(config["cwd"]) or
                not isinstance(config.get("args"), list) or not all(isinstance(x, str) for x in config["args"]) or
                not isinstance(config.get("rows"), int) or not 5 <= config["rows"] <= 100 or
                not isinstance(config.get("cols"), int) or not 20 <= config["cols"] <= 300 or
                (config.get("relayCapability") is not None and
                 (not isinstance(config["relayCapability"], str) or len(config["relayCapability"]) != 64 or
                  not isinstance(config.get("relaySocketPath"), str)))):
            return 2
        supervisor = Supervisor(config)
        print(json.dumps({"v": VERSION, "ready": True, "childPid": supervisor.child,
                          "supervisorPid": os.getpid()}), flush=True)
        supervisor.run()
        return 0
    except Exception as error:
        # Startup diagnostics deliberately omit paths, commands and secrets.
        print("managed-pane startup failed: " + type(error).__name__ +
              (":" + str(error.errno) if isinstance(error, OSError) else ""),
              file=sys.stderr, flush=True)
        return 2


if __name__ == "__main__":
    sys.exit(main())
