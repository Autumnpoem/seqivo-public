"""Bounded stdio adapter from the taskboard to the Codex app-server.

The protocol is one JSON request/response per line. Notifications have an
``event`` key and no ``id``. This module never reads or changes credentials.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from vendor.codex_charge.parser import LimitWatcher, resolve_reset_at
from vendor.codex_charge.quota import RateWindow, discover_codex


def emit(value: dict[str, Any]) -> None:
    with OUTPUT_LOCK:
        sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


OUTPUT_LOCK = threading.Lock()
THREAD_READ_BUDGET_SECONDS = 8.0  # Below the host Bridge's 12-second watchdog.


class ThreadReadTimeout(TimeoutError):
    """The bounded read-only thread observation did not finish."""


def codex_executable(explicit: str | None, base_directory: str | None = None) -> str:
    if base_directory is not None:
        if not isinstance(base_directory, str) or not os.path.isabs(base_directory):
            raise ValueError("executableBaseDirectory must be absolute")
        previous_directory = os.getcwd()
        os.chdir(base_directory)
    try:
        if explicit:
            discovered = discover_codex(explicit)
        else:
            try:
                discovered = discover_codex()
            except FileNotFoundError:
                mac_app = Path("/Applications/ChatGPT.app/Contents/Resources/codex")
                if not mac_app.is_file():
                    raise
                discovered = str(mac_app)
        return os.path.abspath(discovered) if base_directory is not None else discovered
    finally:
        if base_directory is not None:
            os.chdir(previous_directory)


class AppServer:
    def __init__(self, executable: str, timeout: float) -> None:
        self.timeout = timeout
        command = [sys.executable, "-B", executable, "app-server"] if Path(executable).suffix.lower() == ".py" else [executable, "app-server"]
        self.proc = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        self.responses: dict[int, queue.Queue[dict[str, Any]]] = {}
        self.lock = threading.Lock()
        self.next_id = 0
        self.limit_watcher = LimitWatcher()
        self.paginated_history = False
        self.created_empty: set[str] = set()
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._drain_stderr, daemon=True).start()
        try:
            self.rpc("initialize", {
                "clientInfo": {"name": "taskboard-autocontinue", "version": "0.1.0"},
                # Background-terminal inspection/termination is explicitly
                # gated by this per-connection protocol capability. It does
                # not change the user's model, credentials or sandbox policy.
                "capabilities": {"experimentalApi": True},
            })
            self.notify("initialized", {})
        except Exception:
            self.close()
            raise

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "id" in msg and "method" not in msg:
                with self.lock:
                    target = self.responses.get(msg["id"])
                if target:
                    try:
                        target.put_nowait(msg)
                    except queue.Full:
                        pass
            else:
                method = str(msg.get("method", ""))
                if method:
                    params = msg.get("params") or {}
                    if method == "turn/started" and isinstance(params, dict):
                        self.created_empty.discard(params.get("threadId"))
                    emit({"event": "codexRequest" if "id" in msg else "codex", "method": method, "params": msg.get("params", {})})
                    if method in {"error", "turn/completed"}:
                        parsed = self.limit_watcher.feed(json.dumps(msg.get("params", {}), ensure_ascii=False))
                        if parsed:
                            params = msg.get("params") or {}
                            emit({"event": "limit", "threadId": params.get("threadId") if isinstance(params, dict) else None, "resetAt": parsed[0], "source": parsed[1]})
        with self.lock:
            waiting = list(self.responses.values())
        for target in waiting:
            try:
                target.put_nowait({"error": {"message": "codex app-server closed"}})
            except queue.Full:
                pass
        emit({"event": "closed"})

    def _drain_stderr(self) -> None:
        assert self.proc.stderr is not None
        for _ in self.proc.stderr:
            pass

    def notify(self, method: str, params: dict[str, Any]) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps({"method": method, "params": params}) + "\n")
        self.proc.stdin.flush()

    def rpc(self, method: str, params: dict[str, Any] | None = None, *, deadline: float | None = None) -> Any:
        with self.lock:
            self.next_id += 1
            req_id = self.next_id
            target: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=1)
            self.responses[req_id] = target
        try:
            assert self.proc.stdin is not None
            if deadline is not None and deadline - time.monotonic() <= 0:
                raise ThreadReadTimeout("Codex thread observation timed out")
            self.proc.stdin.write(json.dumps({"id": req_id, "method": method, "params": params or {}}) + "\n")
            self.proc.stdin.flush()
            wait_timeout = self.timeout
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ThreadReadTimeout("Codex thread observation timed out")
                wait_timeout = min(wait_timeout, remaining)
            try:
                msg = target.get(timeout=wait_timeout)
            except queue.Empty as exc:
                if deadline is not None:
                    raise ThreadReadTimeout("Codex thread observation timed out") from exc
                raise TimeoutError(f"codex RPC timed out: {method}") from exc
            if deadline is not None and time.monotonic() >= deadline:
                raise ThreadReadTimeout("Codex thread observation timed out")
            if msg.get("error"):
                error = msg["error"]
                raise RuntimeError(error.get("message", str(error)) if isinstance(error, dict) else str(error))
            return msg.get("result")
        finally:
            with self.lock:
                self.responses.pop(req_id, None)

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=2)

    def read_thread(self, thread_id: str, turn_ids: list[str] | None = None) -> Any:
        # A single observation must fit inside the host's 12-second watchdog;
        # pagination and includeTurns fallback do not receive fresh budgets.
        deadline = time.monotonic() + min(self.timeout, THREAD_READ_BUDGET_SECONDS)
        def observe(method: str, params: dict[str, Any]) -> Any:
            return self.rpc(method, params, deadline=deadline)
        def finish(result: Any) -> Any:
            if time.monotonic() >= deadline:
                raise ThreadReadTimeout("Codex thread observation timed out")
            return result

        # Codex does not materialize a fresh thread's history until its first
        # user message. Only threads created by this live bridge qualify.
        if thread_id in self.created_empty:
            result = observe("thread/read", {"threadId": thread_id, "includeTurns": False})
            if result.get("thread", {}).get("status", {}).get("type") == "idle":
                result["thread"]["turns"] = []
                return finish(result)
            self.created_empty.discard(thread_id)
        if not self.paginated_history:
            try:
                return finish(observe("thread/read", {"threadId": thread_id, "includeTurns": True}))
            except RuntimeError as exc:
                if "not supported" not in str(exc).lower():
                    raise
                self.paginated_history = True
        result = observe("thread/read", {"threadId": thread_id, "includeTurns": False})
        cursor = None
        turns = []
        missing = set(turn_ids or [])
        for _ in range(20):
            page = observe("thread/turns/list", {"threadId": thread_id, "limit": 100, "sortDirection": "desc", "cursor": cursor})
            if not isinstance(page, dict) or not isinstance(page.get("data"), list):
                raise RuntimeError("Codex turn history is unavailable")
            turns.extend(page["data"])
            missing.difference_update(turn.get("id") for turn in page["data"])
            cursor = page.get("nextCursor")
            if not missing or not cursor:
                break
        if cursor and missing:
            raise RuntimeError("Owned Codex turn is outside the bounded history window; manual verification required")
        result["thread"]["turns"] = list(reversed(turns))
        return finish(result)


def parse_windows(raw: Any, prefix: str) -> list[dict[str, Any]]:
    if not isinstance(raw, dict):
        return []
    windows: list[dict[str, Any]] = []
    for key in ("primary", "secondary"):
        item = raw.get(key)
        if not isinstance(item, dict) or item.get("usedPercent") is None:
            continue
        try:
            rate = RateWindow(
                used_percent=float(item["usedPercent"]),
                window_duration_mins=int(item.get("windowDurationMins") or 0),
                resets_at=int(item.get("resetsAt") or 0),
            )
        except (TypeError, ValueError):
            continue
        windows.append({
            "name": f"{prefix}{key}",
            "usedPercent": rate.used_percent,
            "windowDurationMins": rate.window_duration_mins,
            "resetsAt": rate.resets_at or None,
        })
    return windows


def normalize_quota(result: Any, grace_seconds: int) -> dict[str, Any]:
    if not isinstance(result, dict):
        raise RuntimeError("rate limit response is missing")
    buckets = result.get("rateLimitsByLimitId")
    snapshots = buckets if isinstance(buckets, dict) and buckets else {"codex": result.get("rateLimits")}
    windows: list[dict[str, Any]] = []
    backend_blocked = False
    for name, snapshot in snapshots.items():
        windows.extend(parse_windows(snapshot, f"{name}."))
        if isinstance(snapshot, dict) and (snapshot.get("rateLimitReachedType") is not None or snapshot.get("spendControlReached") is True):
            backend_blocked = True
    if not windows:
        raise RuntimeError("rate limit windows are unavailable")
    exhausted = [w for w in windows if w["usedPercent"] >= 100]
    reset_times = [w["resetsAt"] for w in exhausted if w["resetsAt"] is not None]
    if exhausted and len(reset_times) != len(exhausted):
        wake_at = None
    elif reset_times:
        wake_at, _ = resolve_reset_at(None, max(reset_times), grace_seconds)
    else:
        wake_at = None
    allowed = result.get("ordinaryUsageAllowed")
    blocked = bool(exhausted or backend_blocked or allowed is False)
    # Unknown backend permission is not evidence that usage has recovered.
    ready = not blocked and allowed is True
    return {"windows": windows, "blocked": blocked, "ready": ready, "wakeAt": wake_at, "checkedAt": int(time.time()), "ordinaryUsageAllowed": allowed}


def main() -> int:
    app: AppServer | None = None
    try:
        for line in sys.stdin:
            request: Any = None
            try:
                request = json.loads(line)
                req_id = request.get("id")
                method = request.get("method")
                if method == "close":
                    emit({"id": req_id, "result": True})
                    break
                if method == "open":
                    if app:
                        app.close()
                    timeout = float(request.get("timeoutSeconds", 8))
                    if not 0.5 <= timeout <= 30:
                        raise ValueError("timeoutSeconds outside 0.5..30")
                    app = AppServer(codex_executable(request.get("codexPath"),
                        request.get("executableBaseDirectory")), timeout)
                    result: Any = {"available": True, "appServerPid": app.proc.pid}
                elif app is None:
                    raise RuntimeError("bridge is not open")
                elif method == "quota":
                    result = normalize_quota(app.rpc("account/rateLimits/read"), int(request.get("graceSeconds", 30)))
                elif method == "thread":
                    result = app.read_thread(request["threadId"], request.get("turnIds"))
                elif method == "resumeThread":
                    result = app.rpc("thread/resume", {"threadId": request["threadId"], "cwd": request["cwd"]})
                elif method == "createThread":
                    params = {"cwd": request["cwd"]}
                    if request.get("workspaceWrite") is True:
                        params["sandbox"] = "workspace-write"
                    result = app.rpc("thread/start", params)
                    app.created_empty.add(result["thread"]["id"])
                elif method == "turn":
                    params = {
                        "threadId": request["threadId"],
                        "cwd": request["cwd"],
                        "clientUserMessageId": request["commandId"],
                        "input": [{"type": "text", "text": request["text"]}],
                    }
                    if request.get("model"):
                        params["model"] = request["model"]
                    if request.get("evidenceOnly"):
                        params["sandboxPolicy"] = {"type": "readOnly"}
                    elif request.get("workspaceWrite") is True:
                        params["sandboxPolicy"] = {
                            "type": "workspaceWrite", "writableRoots": [request["cwd"]],
                            "networkAccess": False, "excludeSlashTmp": True, "excludeTmpdirEnvVar": True,
                        }
                    result = app.rpc("turn/start", params)
                    try:
                        metadata = app.rpc("thread/read", {"threadId": request["threadId"], "includeTurns": False})
                        result["model"] = metadata.get("thread", {}).get("model")
                    except Exception:
                        pass  # A started turn remains started if metadata is unavailable.
                elif method == "interrupt":
                    result = app.rpc("turn/interrupt", {"threadId": request["threadId"], "turnId": request["turnId"]})
                elif method == "listBackgroundTerminals":
                    thread_id = request["threadId"]
                    if not isinstance(thread_id, str) or not thread_id:
                        raise ValueError("threadId is required")
                    params: dict[str, Any] = {"threadId": thread_id}
                    if "cursor" in request:
                        if request["cursor"] is not None and not isinstance(request["cursor"], str):
                            raise ValueError("cursor must be a string or null")
                        params["cursor"] = request["cursor"]
                    if "limit" in request:
                        limit = request["limit"]
                        if limit is not None and (type(limit) is not int or not 0 <= limit <= 0xFFFFFFFF):
                            raise ValueError("limit must be a uint32 or null")
                        params["limit"] = limit
                    result = app.rpc("thread/backgroundTerminals/list", params)
                    if not isinstance(result, dict) or not isinstance(result.get("data"), list):
                        raise RuntimeError("Codex background terminal list is malformed")
                    if "nextCursor" in result and result["nextCursor"] is not None and not isinstance(result["nextCursor"], str):
                        raise RuntimeError("Codex background terminal cursor is malformed")
                    if any(not isinstance(item, dict) or any(not isinstance(item.get(key), str) for key in ("processId", "itemId", "command", "cwd")) for item in result["data"]):
                        raise RuntimeError("Codex background terminal item is malformed")
                elif method == "terminateBackgroundTerminal":
                    thread_id, process_id = request["threadId"], request["processId"]
                    if not isinstance(thread_id, str) or not thread_id or not isinstance(process_id, str) or not process_id:
                        raise ValueError("threadId and processId are required")
                    result = app.rpc("thread/backgroundTerminals/terminate", {"threadId": thread_id, "processId": process_id})
                    if not isinstance(result, dict) or type(result.get("terminated")) is not bool:
                        raise RuntimeError("Codex background terminal termination result is malformed")
                elif method == "parseLimit":
                    parsed = app.limit_watcher.feed(str(request.get("text", "")))
                    result = None if parsed is None else {"resetAt": parsed[0], "wakeAt": resolve_reset_at(parsed[0], request.get("quotaResetAt"), int(request.get("graceSeconds", 30)))[0]}
                else:
                    raise ValueError(f"unsupported bridge method: {method}")
                emit({"id": req_id, "result": result})
            except Exception as exc:
                emit({"id": request.get("id") if isinstance(request, dict) else None, "error": {"type": type(exc).__name__, "message": str(exc)}})
    finally:
        if app:
            app.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
