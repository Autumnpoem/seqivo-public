# Remote Hub protocol (v0.3)

The desktop node keeps the authoritative task database. The Hub stores only an explicitly selected, redacted projection and a durable command queue. The node initiates outbound HTTPS requests; the Hub does not call the node. Public registration creates isolated account spaces; existing owners can bind an account without moving their projects. See [account and conversation setup](accounts-and-conversations.en.md).

## Start and pair

Run with Node.js 24 or newer. Create a tenant once:

```sh
node server/hub/index.mjs bootstrap --data-dir /path/to/hub-data --tenant-id my-tenant
```

The command prints the **path** to a newly created 0600 owner-token file, never the token. Keep that file private. Start the service with `node server/hub/index.mjs serve --data-dir /path/to/hub-data --dist-dir /path/to/dist --host 127.0.0.1 --port 4318`. Binding outside loopback requires `--tls-key` and `--tls-cert`; clients reject plain HTTP outside loopback and HTTP redirects. A public deployment must supply an appropriate domain, trusted certificate, network controls and backup policy. No deployment target is configured by this implementation.

Authenticated routes use an expiring HttpOnly account cookie or `Authorization: Bearer <token>`; credentials are never accepted in URLs. The owner creates one-use pairing codes with `POST /api/admin/pairings` and JSON `{role:"node"|"viewer"|"controller",projectIds:["id"],ttlSeconds:600}`. TTL is 30–3600 seconds. `POST /api/pairings/redeem` accepts `{code,projectIds?}`; the node selects a nonempty subset of the paired projects. Redemption atomically consumes the code and returns a new subject token, subject/node ID, epoch and grants. A bad subset does not consume the code. Node credentials are saved atomically in a local 0600 file; the local remote state API omits the token. Registration, password login, account status, credential-based node pairing, and code redemption are public endpoints with authentication rate limits. Public registration can be disabled with `--disable-registration`.

Owner-only routes:

| Method and route | Purpose |
| --- | --- |
| `GET /api/admin/subjects` | List subject IDs, roles, grants, epochs and revocations (no tokens) |
| `POST /api/admin/grants` | Grant `{subjectId,projectId}` |
| `DELETE /api/admin/grants/:subjectId/:projectId` | Remove a grant |
| `POST /api/admin/subjects/:subjectId/revoke` | Revoke a subject |
| `POST /api/admin/leases/reconcile` | After verifying an old revoked node stopped, release its unknown continue lease with `{projectId,taskId,confirmStopped:true,reason}`; an audit row records owner and old command |

Grant changes increment a node's epoch and invalidate its project ownership. Revocation rejects subsequent requests and expires queued commands. A claimed command becomes `unknown` when its controller or node is revoked; revocation never claims to have stopped an executing local turn. The old continue lease remains after node revocation. A replacement node cannot continue that task until the owner explicitly confirms the old process stopped and reconciles the lease; this is recorded in `lease_reconciliations`.

## Phone and node API

`GET /api/state` returns the allowed project/task projection to an owner, viewer or controller. It includes `connection.mode="hub"`, last-seen time and offline indicator. No local directories, plugin configurations, evidence references, conversation or turn IDs, or raw local errors are projected. Each task exposes only a Boolean `hasExecutionBinding` so the phone can enable or disable continue/pause without receiving the local conversation ID. A viewer cannot create commands. An owner or controller sends `POST /api/commands` with `{commandId,projectId,taskId,action,expectedRevision,expiresAt,body,queueOffline?}`. Actions are `continue`, `pause`, `update`, `evidence`, `review`, `message`, and `create_conversation`; their bodies are restricted to fields accepted by the local task routes. `GET /api/commands/:id` returns a durable status and redacted receipt. Only the creator or owner can inspect a command. `commandId` is an idempotency key: repeating an identical command returns its existing status; changed payload or creator returns 409.

Normally a command needs a snapshot received within 60 seconds. An offline command needs `queueOffline:true` and expiry within five minutes; without that explicit flag it is rejected. All commands expire within an hour. The Hub binds each command to its tenant, project, current node and epoch, task revision, controller, and expiry. One outstanding `continue` lease exists per tenant/project/task even when callers use different command IDs. A queued `pause` expires a queued `continue`; a verified pause releases a running lease. `unknown` keeps the lease until the outcome is reconciled by a verified terminal snapshot or pause.

The node uses `GET /api/node/session`, `POST /api/node/snapshot`, `GET /api/node/commands`, `POST /api/node/commands/:id/claim`, `POST /api/node/commands/:id/sending`, `POST /api/node/commands/:id/validate`, and `POST /api/node/commands/:id/receipt`. Snapshots carry an increasing sequence and ownership epoch. The Hub rejects stale or conflicting sequences and projects outside current grants. Claim, sending, and validate each recheck controller/node grants, ownership, epoch, expiry, and snapshot freshness. The node also checks the actual local task revision and selected project immediately before calling a fixed local task route. Hub statuses progress from `queued` to `received` to `sending`; only a confirmed local callback receipt sets `running`. The node persists these phases before the possible local call. If it crashes, loses the Hub, or cannot determine the local outcome, it records `unknown` and never blindly resends that command. A receipt reporting `running` confirms only that the local continue request was accepted, not that task work is complete.

Local `disconnect()` calls authenticated `POST /api/node/revoke` before deleting the token. A revoked old token receives HTTP 401. If the Hub cannot be reached, the node retains the credential and reports `offline` with an instruction to ask the Hub owner to revoke it; it does not claim disconnection. Re-pairing an already paired node also revokes the old subject first. Hub project ownership does not automatically move to a new node while the old subject is active.

Remote review callbacks include a trusted `remoteActor:{tenantId,subjectId,role:"controller"}` derived from the authenticated Hub command, so the local audit can attribute the reviewer. The local core must accept this field **only** from its trusted remote adapter; browser-supplied review JSON cannot impersonate a remote actor.

## Storage and limitations

### Verification checklist projection

Verification records may include `pendingChecks` and an `unverified` status for plans that have not been executed. Each checklist item defaults to `shareWithRemote: false`: the projection retains its type and criterion association but replaces its ID and all descriptive text with local-only placeholders. This prevents local test paths or blocker errors from being uploaded incidentally. Only an owner-written item explicitly marked `shareWithRemote: true` sends its reviewed title, steps, pass condition, and blocker text to already-authorized devices. Such text must exclude secrets and local evidence; the normal `verification.reference` field is always redacted. Remote controllers and MCP reporters cannot write verification records or enable this sharing flag.

Each item also carries `completed` (default `false` for legacy records). This manual bookkeeping state is projected even when descriptions stay local. Hub devices display it read-only; the owner-only local checklist endpoint changes it without altering test evidence, test status, or human acceptance.

The Hub uses Node 24 `node:sqlite` and a WAL database in its data directory. Owner tokens, pairing codes and subject tokens are stored by SHA-256 hash, not in plaintext. The node stores its issued token and command receipt journal in `remote-link.json` at mode 0600. Back up both data directories securely. A snapshot is a deliberately limited projection, and excludes local evidence references, raw provider identities and hidden reasoning. Owner/controller conversation watches add bounded visible replies and tool output, which may contain source code or secrets. Viewer devices cannot access conversation output. This protocol has been tested on loopback with fake local callbacks; deployment TLS, physical phone access, and real AI turn execution require separate validation in the target environment.

## Account and conversation endpoints

`POST /api/auth/register` and `/login` accept `{username,password}` and return user metadata plus an HttpOnly session cookie, never a session token in JSON. `POST /api/auth/claim` accepts the same fields and an existing owner Bearer token, binding the account to that space. `/api/auth/me`, `/logout` and `/password` manage identity and sessions. Password changes invalidate browser sessions; already paired devices must be revoked separately. Mixing a Bearer with a cookie uses only the Bearer identity; it cannot modify the cookie account password.

Desktop `POST /api/remote/login` validates selected local projects and exchanges credentials through Hub `/api/auth/node-pairing`; the password is never saved. Hub `POST /api/conversations` accepts `{projectId,title,message,commandId}` and queues a guarded project-local creation request. `message` commands accept only `{message}` with the current task revision. Neither route accepts arbitrary working directories or shell invocations. Reused IDs cannot change payload or replay an unknown execution.

Owner/controller `GET /api/tasks/:id/conversation` watches that authorized task for 60 seconds. Node sessions list at most 5 watched task IDs. Snapshots add bounded conversations and `capabilities.conversations`; older nodes return `NODE_UPDATE_REQUIRED`. The browser and node poll about every two seconds; this is eventual synchronization rather than a WebSocket stream. New requests remain subject to provider approval gates.

## Inbox projection and actions (v0.4)

Nodes advertise `capabilities.inbox`. Snapshots add sanitized `inbox.items`, scoped to selected projects; Hub responses filter these again by the requesting subject's grants. Local dedup keys, raw provider metadata, private decision/check text and private supplements are not sent. Inbox item IDs stay stable. Large projections prioritize active items within a 1.8 MB transport budget and report `inbox.omitted: [{projectId,open,history}]`; local durable history remains intact. An omitted remote item cannot be acted on through an old snapshot.

`inbox_action` uses the existing command envelope with `queueOffline:false`, current task revision, and body `{itemId,expectedItemRevision,action,answer?,optionId?}`. Allowed actions are `acknowledge`, `answer` and `supplement`, validated against item type; unknown and private items reject all remote mutations. `commandId` becomes the local idempotency key. Successful receipts use `status: "completed"`, with only task/item IDs and revisions. A lost permission or transport response is not success and must not discard the original command ID.

A timed-out inbox command may later accept a matching definitive receipt from its original authorized node/epoch. The node can only resend a durable completed receipt; receiving an unknown command never launches the action again. Hub-generated unknown cards can refer to a project even before a new conversation's task appears. These cards are read-only. This does not change the conservative unknown semantics for provider execution.
