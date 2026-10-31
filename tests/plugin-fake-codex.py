#!/usr/bin/env python3
"""A protocol-only app-server fixture. It never invokes Codex or an AI model."""

import json
import os
import subprocess
import sys
import time

scenario = json.loads(open(os.environ["TASKBOARD_FAKE_SCENARIO"], encoding="utf-8").read())
log_path = os.environ["TASKBOARD_FAKE_LOG"]
with open(os.environ["TASKBOARD_FAKE_PID"], "w", encoding="utf-8") as pid_file:
    pid_file.write(str(os.getpid()))
current_turn = None
command_child = None
command_text = None
terminal_list_calls = 0
new_turn_after_terminate = False

def reply(value):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()

for line in sys.stdin:
    scenario = json.loads(open(os.environ["TASKBOARD_FAKE_SCENARIO"], encoding="utf-8").read())
    request = json.loads(line)
    method = request.get("method")
    with open(log_path, "a", encoding="utf-8") as log:
        log.write(json.dumps(request) + "\n")
    if method == "initialized":
        continue
    if method == "initialize":
        if scenario.get("initializeError"):
            if scenario.get("initializeOrphan"):
                child = subprocess.Popen([sys.executable, "-B", os.environ["TASKBOARD_FAKE_CHILD_SCRIPT"],
                    os.environ["TASKBOARD_FAKE_LATE_WRITE"]], start_new_session=True,
                    cwd=os.environ["TASKBOARD_FAKE_CWD"],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                with open(os.environ["TASKBOARD_FAKE_CHILD_PID"], "w", encoding="utf-8") as child_file:
                    child_file.write(str(child.pid))
            reply({"id": request["id"], "error": {"message": "fixture initialize failed"}})
            continue
        if scenario.get("bytecodeChildOnInitialize"):
            subprocess.run([sys.executable, "-B", os.environ["TASKBOARD_FAKE_CHILD_SCRIPT"]],
                check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL)
        reply({"id": request["id"], "result": {}})
    elif method == "account/rateLimits/read":
        if scenario.get("quotaHang"):
            time.sleep(30)
            continue
        if scenario.get("quotaError"):
            reply({"id": request["id"], "error": {"message": "quota unavailable"}})
            continue
        now = int(time.time())
        used = scenario.get("used", [0, 0])
        reset = scenario.get("reset", [now + 100, now + 300])
        result = {
            "ordinaryUsageAllowed": scenario.get("allowed", True),
            "rateLimits": {
                "primary": {"usedPercent": used[0], "windowDurationMins": 300, "resetsAt": reset[0]},
                "secondary": {"usedPercent": used[1], "windowDurationMins": 10080, "resetsAt": reset[1]},
            },
        }
        reply({"id": request["id"], "result": result})
    elif method == "thread/start":
        if scenario.get("createCrash"):
            sys.exit(9)
        reply({"id": request["id"], "result": {"model":"fixture-model","thread":{"id":"new-thread","cwd":request["params"]["cwd"],"status":{"type":"idle"},"turns":[]}}})
    elif method == "thread/turns/list":
        turns = scenario.get("turns",[current_turn] if current_turn else [])
        offset = int(request["params"].get("cursor") or 0)
        limit = request["params"].get("limit",100)
        reply({"id":request["id"],"result":{"data":turns[offset:offset+limit],"nextCursor":str(offset+limit) if offset+limit<len(turns) else None}})
    elif method == "thread/read":
        if scenario.get("paginated") and request["params"].get("includeTurns"):
            reply({"id":request["id"],"error":{"message":"list_turns is not supported yet"}})
            continue
        requested = request["params"]["threadId"]
        dynamic_status = {"type": "active", "activeFlags": []} if new_turn_after_terminate or current_turn and current_turn["status"] == "inProgress" else {"type": "idle"}
        if current_turn and current_turn["status"] in ("completed", "failed", "interrupted"):
            dynamic_status = scenario.get("threadStatusAfterCompletion", dynamic_status)
        turns = scenario.get("turns", [current_turn] if current_turn else [])
        if new_turn_after_terminate:
            turns = [*turns, {"id": "foreign-new-turn", "status": "inProgress", "items": []}]
        thread = {
            "id": scenario.get("threadId", requested),
            "cwd": scenario.get("threadCwds", {}).get(requested, scenario.get("cwd", os.environ.get("TASKBOARD_FAKE_CWD"))),
            "status": scenario.get("threadStatus", dynamic_status),
            "turns": turns,
        }
        if scenario.get("missingThread"):
            reply({"id": request["id"], "result": {"thread": None}})
        else:
            reply({"id": request["id"], "result": {"thread": thread}})
    elif method == "thread/resume":
        reply({"id": request["id"], "result": {"thread": {
            "id": request["params"]["threadId"],
            "cwd": request["params"]["cwd"],
            "status": {"type": "idle"},
            "turns": [],
        }}})
    elif method == "turn/start":
        if scenario.get("sendCrash"):
            sys.exit(7)
        if scenario.get("sendHang"):
            time.sleep(30)
            continue
        current_turn = {"id": "fake-turn-1", "status": "inProgress", "items": []}
        if scenario.get("lingeringChild"):
            command_text = f'{sys.executable} -B {os.environ["TASKBOARD_FAKE_CHILD_SCRIPT"]} {os.environ["TASKBOARD_FAKE_LATE_WRITE"]}'
            child = subprocess.Popen([sys.executable, "-B", os.environ["TASKBOARD_FAKE_CHILD_SCRIPT"],
                os.environ["TASKBOARD_FAKE_LATE_WRITE"]], start_new_session=True,
                cwd=os.environ["TASKBOARD_FAKE_CWD"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            command_child = child
            with open(os.environ["TASKBOARD_FAKE_CHILD_PID"], "w", encoding="utf-8") as child_file:
                child_file.write(str(child.pid))
        if scenario.get("approval") and scenario.get("approvalBeforeTurnReply"):
            early_params = {"threadId": request["params"]["threadId"], "turnId": current_turn["id"]}
            reply({"id": 887, "method": "item/commandExecution/requestApproval", "params": early_params})
            time.sleep(0.05)
        reply({"id": request["id"], "result": {"turn": current_turn}})
        if not scenario.get("omitStarted"):
            reply({"method": "turn/started", "params": {"threadId": request["params"]["threadId"], "turn": current_turn}})
        if scenario.get("providerTerminal") and command_child:
            reply({"method": "item/started", "params": {"threadId": request["params"]["threadId"],
                "turnId": current_turn["id"], "item": {"type": "commandExecution", "id": "exec-fake-owned", "command": command_text}}})
        if scenario.get("shortCommandMs") is not None:
            time.sleep(max(0, float(scenario["shortCommandMs"]) / 1000) + 0.03)
        if scenario.get("completeStatus"):
            current_turn = {"id": "fake-turn-1", "status": scenario["completeStatus"], "items": [], "error": scenario.get("turnError")}
            reply({"method": "turn/completed", "params": {"threadId": request["params"]["threadId"], "turn": current_turn}})
        if scenario.get("approval") and not scenario.get("approvalBeforeTurnReply"):
            if scenario.get("approvalAfterGate"):
                gate = os.environ["TASKBOARD_FAKE_APPROVAL_GATE"]
                deadline = time.monotonic() + 15
                while not os.path.exists(gate) and time.monotonic() < deadline:
                    time.sleep(0.01)
                if not os.path.exists(gate):
                    continue
            approval_params = {"threadId": request["params"]["threadId"]}
            if scenario.get("approvalWithTurnId"):
                approval_params["turnId"] = current_turn["id"]
            reply({"id": 887, "method": "item/commandExecution/requestApproval", "params": approval_params})
    elif method == "turn/interrupt":
        if scenario.get("interruptHang"):
            time.sleep(30)
            continue
        if scenario.get("interruptError"):
            reply({"id": request["id"], "error": {"message": "interrupt rejected"}})
            continue
        if not current_turn or current_turn["id"] != request["params"]["turnId"]:
            reply({"id": request["id"], "error": {"message": "turn not found"}})
            continue
        current_turn = {**current_turn, "status": "interrupted"}
        reply({"id": request["id"], "result": {}})
        if scenario.get("notifyInterrupted"):
            reply({"method": "turn/completed", "params": {"threadId": request["params"]["threadId"], "turn": current_turn}})
    elif method == "thread/backgroundTerminals/list":
        terminal_list_calls += 1
        data = []
        if command_child and command_child.poll() is None and scenario.get("providerTerminal") and terminal_list_calls > scenario.get("omitTerminalFirst", 0):
            data.append({"itemId": "exec-fake-owned", "processId": "fake-terminal-1",
                "command": command_text, "cwd": os.environ["TASKBOARD_FAKE_CWD"], "osPid": None})
        if scenario.get("foreignTerminal"):
            data.append({"itemId": "exec-other-task", "processId": "other-terminal",
                "command": "other task", "cwd": os.environ["TASKBOARD_FAKE_CWD"], "osPid": None})
        reply({"id": request["id"], "result": {"data": data, "nextCursor": None}})
    elif method == "thread/backgroundTerminals/terminate":
        if request["params"].get("processId") != "fake-terminal-1" or not command_child:
            reply({"id": request["id"], "error": {"message": "terminal not found"}})
            continue
        if not scenario.get("terminateDoesNotStop"):
            command_child.terminate()
        if scenario.get("newTurnAfterTerminate"):
            new_turn_after_terminate = True
        reply({"id": request["id"], "result": {"terminated": True}})
    else:
        reply({"id": request["id"], "error": {"message": f"Unexpected method {method}"}})
