#!/usr/bin/env python3
"""tmux-pane stdio relay for a separately supervised PTY shell.

The token is consumed from a one-use 0600 file in a private directory. Only
the token-file path appears in the tmux pane argv. This process has no control
capability and cannot park, resume, or adopt a shell.
"""

import base64
import fcntl
import json
import os
import selectors
import signal
import socket
import stat
import struct
import sys
import termios
import tty

MAX_FRAME = 262144
MAX_INPUT = 16384


def token_once(path):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or
                stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size != 64):
            raise ValueError("invalid_relay_token_file")
        token = os.read(fd, 65)
        if len(token) != 64 or any(byte not in b"0123456789abcdef" for byte in token):
            raise ValueError("invalid_relay_token")
        current = os.stat(path, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError("relay_token_file_changed")
        os.unlink(path)
        return token.decode("ascii")
    finally:
        os.close(fd)


def send(sock, frame):
    sock.sendall((json.dumps(frame, separators=(",", ":")) + "\n").encode())


def size():
    raw = fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8)
    rows, cols, _, _ = struct.unpack("HHHH", raw)
    return max(5, min(rows, 100)), max(20, min(cols, 300))


def write_all(fd, data):
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]


def run(sock):
    old_tty = termios.tcgetattr(0)
    tty.setraw(0)
    resized = [False]
    old_winch = signal.getsignal(signal.SIGWINCH)
    signal.signal(signal.SIGWINCH, lambda *_: resized.__setitem__(0, True))
    try:
        selector = selectors.DefaultSelector()
        selector.register(sock, selectors.EVENT_READ, "socket")
        selector.register(0, selectors.EVENT_READ, "stdin")
        pending = bytearray()
        active = False
        epoch = None
        expected_offset = None
        while True:
            if resized[0] and epoch is not None:
                resized[0] = False
                rows, cols = size()
                send(sock, {"v": 1, "op": "resize", "rows": rows, "cols": cols})
            for key, _ in selector.select(0.15):
                if key.data == "socket":
                    data = sock.recv(65536)
                    if not data:
                        return
                    pending.extend(data)
                    if len(pending) > MAX_FRAME:
                        return
                    while b"\n" in pending:
                        line, _, rest = pending.partition(b"\n")
                        pending = bytearray(rest)
                        frame = json.loads(line)
                        if not isinstance(frame, dict):
                            return
                        kind = frame.get("type")
                        if kind == "relay_ready":
                            if type(frame.get("epoch")) is not int:
                                return
                            epoch = frame["epoch"]
                            active = frame.get("inputOpen") is True
                            expected_offset = frame.get("outputOffset")
                            if frame.get("gapBytes") or frame.get("gapUnknown"):
                                write_all(1, b"\r\n[managed pane: output gap while detached]\r\n")
                            rows, cols = size()
                            send(sock, {"v": 1, "op": "resize", "rows": rows, "cols": cols})
                        elif kind == "freeze":
                            active = False
                            epoch = frame.get("epoch")
                            send(sock, {"v": 1, "op": "freeze_ack", "epoch": epoch})
                        elif kind == "activate":
                            active = False
                            epoch = frame.get("epoch")
                            send(sock, {"v": 1, "op": "activate_ack", "epoch": epoch})
                            active = True
                        elif kind == "output":
                            raw = base64.b64decode(frame["data"], validate=True)
                            offset = frame.get("offset")
                            if expected_offset is not None and offset != expected_offset:
                                write_all(1, b"\r\n[managed pane: output gap]\r\n")
                            expected_offset = offset + len(raw)
                            write_all(1, raw)
                        elif kind == "child_exited":
                            # Supervisor sends this only after the PTY reached
                            # EOF and every earlier output frame was queued.
                            # A missing or reordered tail is not a clean exit.
                            if (type(frame.get("outputOffset")) is not int or
                                    frame["outputOffset"] < 0 or
                                    type(frame.get("exitCode")) is not int or
                                    not 0 <= frame["exitCode"] <= 255 or
                                    expected_offset != frame["outputOffset"]):
                                return
                            return
                        else:
                            return
                elif key.data == "stdin":
                    raw = os.read(0, MAX_INPUT)
                    if not raw:
                        return
                    if active and epoch is not None:
                        send(sock, {"v": 1, "op": "input", "epoch": epoch,
                                    "data": base64.b64encode(raw).decode("ascii")})
    finally:
        signal.signal(signal.SIGWINCH, old_winch)
        termios.tcsetattr(0, termios.TCSADRAIN, old_tty)


def main():
    if len(sys.argv) != 3 or not os.path.isabs(sys.argv[1]) or not os.path.isabs(sys.argv[2]):
        return 2
    try:
        token = token_once(sys.argv[2])
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(3)
        sock.connect(sys.argv[1])
        send(sock, {"v": 1, "op": "hello", "capability": token})
        sock.settimeout(None)
        run(sock)
        return 0
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        # Do not echo argv, the token, shell commands, or terminal content.
        return 2


if __name__ == "__main__":
    sys.exit(main())
