# Workflow engine API

`createWorkflow({store, executors, now?, emit?})` builds a local, durable scheduler. It does not create agents, change global model settings, manage Git worktrees, or invoke a provider on construction. The caller supplies a registered Store and a `Map` from provider ID to `{start(request), pause(request), inspect(request), canStart?(request)}`. The first three methods are required for a plan. Optional `canStart({taskId,workspace})` is synchronous; `false` or an accidental Promise defers dispatch so the host can enforce a global execution lease. `now` returns epoch milliseconds; `emit` is an optional state-change callback. All mutating methods are asynchronous. The factory returns `state()`, `createPlan(input)`, `start(planId)`, `tick()`, `pause(planId)`, `reconcile(planId,input)`, and `close()`.

The owner creates a plan with:

```json
{
  "projectId": "registered-project-id",
  "members": [
    { "taskId": "implementation-task-id", "role": "worker", "provider": "codex", "model": "optional-provider-model", "dependsOn": [] },
    { "taskId": "review-task-id", "role": "reviewer", "provider": "codex", "dependsOn": [], "reviewOf": "implementation-task-id" }
  ],
  "maxConcurrent": 2,
  "maxStarts": 5,
  "budgetMinutes": 60
}
```

Limits are 1–100 members, 1–3 concurrent starts, 1–20 total starts, and 1–120 wall-clock minutes. The budget clock starts when the plan first starts; pausing does not reset it. A start attempt is counted and persisted **before** calling the executor, even if the call later fails. `tick()` is explicit so the host can invoke it on a bounded timer and after task changes. It does not retry a command whose outcome is unknown. A project must have a bound directory; each member captures that registered directory, and a changed binding prevents dispatch. Every member in the same workspace is serialized, even if `maxConcurrent` is greater than one. Across plans, a durable task/workspace lease prevents a second start while the first is sending, running, pausing, or unknown.

The executor `start` request has `{taskId,expectedRevision,commandId,role,model?,workspace,instructions,evidenceOnly,reviewOf}`. The command ID and `sending` record are durable before the call. `start` returning `{status:"running"}` records a confirmed running request; `{status:"waiting_quota"}` records a blocked, confirmed non-start and consumes an attempt; any other result or exception becomes `unknown` and retains the lease. The selected provider must match the task's persisted `executionProvider` when that field exists. A model value is only forwarded to the selected executor. A bounded, nonempty provider-reported `actualModel` is persisted separately on the member; absent provider metadata remains unknown.

`tick()` first calls `executor.inspect({taskId,commandId})` **outside** the SQLite transaction for each running or unknown member. `inspect` must return `{status:"running"|"completed"|"failed"|"paused"|"not_started"|"waiting_quota"|"unknown",actualModel?}` based on the durable owned command and live provider state. Local task status alone is not proof that the external turn stopped. A manually submitted or accepted task keeps its workspace lease while the provider still reports `running` or `unknown`. Confirmed `completed`, `failed`, or `paused` releases that lease; provider-confirmed `not_started` or `waiting_quota` also releases it, marks the member `blocked`, and never treats it as completed or automatically retries. A completed task enters `awaiting_review` only when its local status is `submitted`; otherwise it is failed without automatic retry. If its title, goal, example, or acceptance criteria changed during execution, it becomes `stale` rather than complete. The host should make provider inspection bounded; the scheduler never resends a command during inspection.

Dependencies require current human acceptance (`acceptance:"passed"` with a matching human review of the current content version). A `reviewOf` target instead becomes eligible when that task is submitted **and its provider turn has been confirmed complete**, so independent review can run before final acceptance. The review must be another task in the same plan, use a different role, and, when the provider is the same, have a separately bound session. Its executor request carries an evidence-only brief. The engine itself never calls `Store.review`; only an authorized human endpoint can pass acceptance. A submitted task becomes `awaiting_review`, not complete. It becomes complete only after provider completion and current-version human acceptance.

`pause(planId)` records an immediate in-memory stop intent, so an already queued slow start cannot dispatch the next member before the pause request runs. It then persists `pause_pending` and calls `executor.pause` for running members. It records `paused` and releases a lease only when the executor returns `{status:"paused"}`. An exception or uncertain reply becomes `unknown`, retains the lease, and leaves the plan `pause_pending`. On restart, persisted `sending`, `pausing`, or `running` entries become `unknown` without another start. A later `inspect` may recover their actual status. `close()` rejects new work, waits for the current serialized call to drain, and prevents any further launch; it does not claim to stop external AI work or call `pause` automatically.

`reconcile(planId,{taskId,confirm:true})` is an owner-only recovery operation for an `unknown` member. It invokes the executor's read-only `inspect` method and succeeds only when the provider confirms a non-unknown result. It never accepts a claimed outcome from local task status or blindly retries an external start. If the provider cannot establish the result, the lease remains held and the API returns `UNKNOWN_RESULT`.

The state is kept under `metadata.workflow.v1` in the Store's transactional SQLite database, including plans, role/provider/model requests, command IDs, attempts, deadlines, statuses, and leases. Store journal triggers include these metadata changes in backup/replay. No provider token, full chat, or hidden model claim is stored by this engine.

For HTTP integration, expose owner-only `GET /api/workflow` → `state()`, `POST /api/workflow/plans` → `createPlan(body)`, and `POST /api/workflow/plans/:id/start|pause|reconcile` → the matching method. Keep `tick()` internal to the host scheduler. The host must pass only registered executor adapters and enforce the reviewer evidence-only permission at its provider/callback boundary; the prompt is a behavioral instruction, not a security boundary.
