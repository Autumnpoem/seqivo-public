# Start AI on the Existing Task

This feature starts an unbound task in its existing task record. The task ID stays the same, so progress, evidence, and later review remain attached to that task.

## Steps

1. Open the target task in the project from the phone or Hub.
2. For a planned task without a Codex session, select **Start AI**.
3. Review the task goal and acceptance criteria, then enter clear startup instructions.
4. Select **Start this task with AI**. Opening the form does not send anything; the project computer starts work only after explicit submission.
5. Wait for the receipt and task state to update. Output appears in the task’s conversation area, where you can continue checking progress and evidence.

**New conversation** still creates a separate task and session. Starting an existing task reuses its original ID and does not create another task.

## Requirements and uncertain results

- The task must be planned, unbound, and configured for Codex.
- The phone must be online and connected to a project computer that supports this action. An owner/controller role is required. View-only access, an offline connection, or an older computer that lacks the capability will show why the action is unavailable.
- If the result is unknown or still being checked, **do not submit again**. Check the same original task and its receipt first. The original request remains locked while its result is unknown to prevent duplicate starts.
- A failed request keeps its draft. The submitted draft is cleared only after a matching success receipt.

## Verification status

Starting AI on an existing task passed an isolated browser test: it started once, kept the same task, and generated three Web files. AI then requested permission. Its process stopped, but the final outcome of that turn remains unknown.

Historical FLOW1103 record: after verifying process stop, the test took over through the UI, opened real tmux, edited README, reviewed the single file change, and explicitly handed control back. Five takeover tests and eight control-state tests passed; one legacy test failed during setup because Python was not configured. At that time, the board marked only this bounded human-control check as verified; the complete workflow remained pending.

Historical FLOW1103 pending items were to explicitly end the old AI attempt while preserving its unknown outcome, support same-device reconnect after disconnect, and resolve the unconfirmed backend shutdown. That section records the then-current state; FLOW1104 adds later bounded test evidence below.

Historical FLOW1103 delivery snapshot: fix commit `0abd6b3`. BUILD1103 updated the plugin resource in BUILD1102 and re-signed the package; package checks passed. At the time it had not been installed or launched, Mac ran BUILD1097, and Web/Hub was DELIVERY1102. This snapshot is not the current delivery status. The latest same-task Android flow still needs verification. See the [test record](same-task-ai-start-results.json) for historical versions, scope, and evidence hashes.

See [Accounts and remote Codex conversations](accounts-and-conversations.md) for account setup and conversation details, and [Task, conversation, and project-terminal navigation](task-terminal-navigation.md) for terminal access.

## FLOW1104: Explicit old-turn disposition (one controlled flow verified)

During human takeover, explicitly select “End these old turns; outcomes remain unverified.” The confirmation lists tasks and original turn IDs. Only precisely identified executions proven physically stopped may be disposed. The old outcome stays unknown, the old instruction is not replayed, and automatic continuation stays off. A normal reviewed handback and the exact Hub receipt acknowledgement are required before a separate new instruction.

An isolated Mac test with real Core, plugin worker and OS jobs, plus a controlled fake AI provider, passed one old-turn disposition, human takeover, reviewed return and one new instruction. Exactly two starts occurred overall, the old outcome remained unknown, and explicit Core close succeeded. This case passed 1/1; the isolated regression passed 96/96; typecheck and Web build passed. This validates one controlled old turn, not multiple turns or a real-AI workflow. Earlier environment failures remain in the results record.

Mac still has BUILD1097 installed; the signed BUILD1104 candidate is verified but not installed or launched. Web/Hub DELIVERY1104 is deployed. The deployment check verified 220 manifest entries, 14 current Web assets, TLS, unauthenticated status 401, and the active firewall; configuration, commands, recovery records and leases remained unchanged. FLOW1104 is not in the installed Mac build. Multiple old turns, the real provider, phone reconnect and the complete AI → preview → manual acceptance workflow remain unverified. The overall goal is not complete. See [FLOW1104 results](unknown-turn-disposition-results.json).
