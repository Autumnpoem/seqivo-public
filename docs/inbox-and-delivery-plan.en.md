# Inbox and delivery workflow

The v0.4 work starts from v0.3.0 commit `b256038`. The first stage adds an actionable inbox to the existing task, evidence, acceptance, account, remote conversation and execution-lock system.

The default page shows up to five prioritized decisions, acceptance requests, blockers and unknown outcomes. Cards lead with plain-language progress, what still needs attention and a next action. Full details, impact and task content version can be expanded. Recorded progress is not verification, and the task version is not a Git commit or a running build identifier.

- **Decisions:** choose an option with its tradeoff or enter an answer. The human decision becomes local handoff context; it does not start AI execution.
- **Acceptance:** open the existing evidence and review flow. Dismissing a reminder does not approve a task.
- **Blockers:** provide information or inspect the task. Additional information does not prove the blocker has cleared.
- **Unknown outcomes:** check the original operation receipt, then inspect the task and connection. Checks never replay the original action.

A disconnected phone can read already loaded content but cannot submit new actions until a fresh state read succeeds. This differs from an offline execution computer: the existing explicit queue option for supported task operations is retained; inbox actions and conversations are not automatically queued offline. Stable command IDs and task/item revisions protect against duplicate and stale actions. Lost authorization retains unresolved command IDs. A definitive late inbox receipt may resolve uncertainty without executing the action again. Private decisions and supplements remain on the desktop; phone projections show a masked notice. Large remote snapshots report omitted actionable/history counts instead of silently claiming the inbox is complete.

MCP adds `task_decision`; file events use `decision.request`. Both require a stable request ID, current task revision, title, description and impact. Options include an ID, label and consequence. Details are private unless `shareWithRemote: true` is explicitly set. AI can request a decision, but cannot answer or approve its own delivery. See the [Chinese guide](inbox-and-delivery-plan.md) for the JSON/API example.

Original-ID checks now read the computer's durable receipt or pre-dispatch marker to distinguish applied, not applied and still unknown. A crash without sufficient records, loss of the original node or revoked authorization can leave an operation blocked; no warning dismissal bypasses that restriction. See the [recovery guide](remote-operation-recovery.md). The client-offline guards cover tasks, inbox actions and remote execution, not the separate account/pairing administration flows. User feedback found the original wording too technical. After viewing the revised Android card on the physical phone, the user confirmed it is understandable. This completes the displayed-card clarity check only; it does not grant whole-P0 or other functional acceptance.

## Stage gates

| Stage | Scope | Release condition |
| --- | --- | --- |
| P0 | Baseline, existing mobile flow, durable inbox, phone-first UI, upgrade/rollback | Automated checks, actual iPhone/Android evidence and user confirmation that the inbox reduces log reading |
| P1 | One verified Mac terminal, separate permissions, human takeover and handback | Confirm real process quiescence before transferring the workspace; demonstrate disconnect/reconnect and safe handback |
| P2 | Authenticated registered Web preview, version-linked feedback drafts, explained revalidation | P1 gate and security review; no arbitrary proxy targets or public development ports |
| P3 | Other native platforms, another provider, guarded continuation, isolation | Evidence per platform/provider; real quota conditions and explicit permission boundaries |

This table records historical release gates. Current implementation status and engineering order are maintained in the [remaining-work plan (Chinese)](remaining-work-plan.md); isolated local development may proceed while product acceptance and target-environment checks remain separate. Existing automatic continuation is preserved. Fake protocol tests do not count as real provider validation, and a directory is not an OS sandbox.

P1-06 specifies a bottom tmux session picker: list existing sessions, switch the current view, explicitly set a default, and attach that default on every new connection. It depends on P1-02/03/04. Local Shell, switching and explicitly authorized writable adoption now have partial implementation and test evidence; final integrated recovery, cross-device behavior and packaged UI still need verification. See the [session interaction contract](remote-terminal-sessions.md#english).

The [remote Shell and tmux implementation plan (Chinese)](remote-shell-implementation-plan.md) defines delivery batches, module boundaries, acceptance, rollout and platform-specific work. Some P0 descriptions below are historical; batch A reconciles them with the later validation report without inventing user acceptance.

Task authors and AI integrations should write `summary` in plain language: what the user can do now and what is still missing. Put the concrete next action in `nextStep`; keep commands, file paths and protocol details in evidence. For example: “The phone can ask the computer to edit code and show the result. Safe recovery after losing the connection still needs testing.” A progress summary is a recorded claim, not automatic verification or human acceptance.

## Physical-phone acceptance

Use a disposable project and the existing account/space. Test Safari on iPhone and Chrome on Android; one complete chain must use Wi-Fi and another cellular data. Record phone OS/browser, desktop version, network and time.

1. Log in, confirm old tasks and acceptance records, sign out and back in.
2. Create a Codex conversation, verify an actual test-file edit on the computer, send a follow-up and verify a second edit in the same conversation.
3. Pause a test run and inspect the actual provider result. Preserve unknown results; a pause acknowledgement alone does not authorize terminal takeover.
4. Answer a decision and confirm it applies once. A competing stale page must require refresh.
5. Inspect current evidence, accept or return a test delivery, and check inbox/history consistency. Missing evidence must block acceptance.
6. Test airplane mode, recovery, screen lock and refresh. Writes remain disabled offline and commands are not replayed automatically.
7. Check light/dark appearance, large text, touch targets and whether the next decision can be found within a minute.

Report each step as passed, failed or unverified. Browser viewport automation is separate from physical-device acceptance.

## Data and rollback

Close the desktop cleanly, back up the full application data directory and retain the old bundle. Use SQLite online backup for a running database; copying only its main file can miss WAL data. The Hub keeps its existing backup service, firewall and HTTPS configuration.

The additive migration preserves original task fields and backfills only the currently known review into history. Earlier overwritten reviews cannot be reconstructed. Rehearse against a read-only source:

```sh
node scripts/verify-inbox-upgrade.mjs /path/to/board.sqlite /path/to/report.json
```

For rollback, stop the new application, preserve its newer data separately, then restore the complete pre-upgrade database/connection files and old bundle. This returns to the backup time. Portable archive import intentionally removes executable bindings and invalidates old acceptance; it is not an exact rollback mechanism.

Android follow-up: the repaired offline controls and reconnection data comparison passed on-device for the recorded scope. Lock/unlock recovery and an already-open edit form also passed with unchanged task revisions, acceptances and file contents. Reconnection retained the draft without automatically submitting it. Android has also passed logout/relogin, offline decision and review guards, missing-evidence rejection, evidence submission, and pass/return of a disposable card. Stale review drafts are now blocked on the physical Android device. The user also confirmed add-evidence/cancel touch with enlarged system text; the exact font scale was not recorded. A physical stale-decision submission conflict and the remaining iPhone checks are still pending; see the validation report.
