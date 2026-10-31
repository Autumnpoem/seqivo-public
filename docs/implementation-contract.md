# 0.1 implementation contract

Root owns server/*, desktop/*, package and lockfiles, tests/core*, build configuration and docs. Frontend worker owns src/* and public/* only. Integration worker owns plugins/* and tests/plugin* only. Do not change another owner's files.

All API responses JSON. Errors: non-2xx `{error:string, code?:string}`. Browser uses same-origin /api. Electron preload `window.taskboard`: `request(method,path,body?)`, `subscribe(callback):unsubscribe`, `openFloating()`, `showMain()`, `chooseDirectory():Promise<string|null>`. Browser API wrapper fetch uses Bearer token from login entry; no fallback demo data. GET /api/state returns:

```
{projects: Project[], tasks: Task[], settings:{theme:'system'|'light'|'dark'}, plugin:PluginState, events:Event[], capabilities:{desktop:boolean, remote:boolean}, connection:{mode:'local',updatedAt:string}}
Project={id,name,goal,directory,createdAt}
Task={id,projectId,title,goal,example,summary,approach,nextStep,status,acceptance,criteria:[{id,text,passed}],evidence:[{id,summary,reference,source,contentVersion,createdAt}],issues:[{id,summary,open,kind}],revision,contentVersion,conversationId,blockedReason,updatedAt}
status=planned|running|paused|blocked|submitted|failed|cancelled
acceptance=unverified|passed|failed|stale
PluginState={id,name,version,enabled,available,status,lastError,upstream:{url,commit},quota:null|{windows:[{name,usedPercent,resetsAt,windowDurationMins}],blocked,checkedAt},config:{pythonPath,codexPath,graceSeconds,pollSeconds},policies:[{taskId,enabled,status,lastError,wakeAt,attempts,maxAttempts}],capabilities:string[]}
```

- POST /api/projects `{name,goal,directory?}`; POST /api/projects/import `{path}` imports `.taskboard/project.json` only on explicit path.
- POST /api/tasks `{projectId,title,goal,example?,summary?,approach?,criteria:string[],conversationId?}`.
- PATCH /api/tasks/:id `{expectedRevision,...changes}`. Allowed fields title,goal,example,summary,approach,nextStep,status,criteria,conversationId,blockedReason. Criteria can be string[]. Reject stale revision with 409. AI cannot set acceptance directly.
- POST /api/tasks/:id/evidence `{expectedRevision,summary,reference}`.
- POST /api/tasks/:id/review `{expectedRevision,decision:'pass'|'fail',summary}`. pass requires submitted status, evidence for current contentVersion, criteria, and no open issue. Human review marks all required criteria passed. fail adds confirmed open issue.
- POST /api/tasks/:id/issues/:issueId/resolve `{expectedRevision}` resolves discrepancy; still requires resubmission/review.
- GET /api/projects/:id/context returns `{markdown}`.
- PATCH /api/settings `{theme}`.
- GET /api/plugin returns PluginState; PATCH /api/plugin/config `{pythonPath,codexPath,graceSeconds,pollSeconds}`.
- POST /api/plugin/enable, /api/plugin/disable, /api/plugin/check. POST /api/plugin/policy `{taskId,enabled,maxAttempts?}`.
- POST /api/tasks/:id/continue `{expectedRevision,commandId}` queues scoped resume; POST /api/tasks/:id/pause `{expectedRevision}`. No fake success: result status explicit.
- GET /api/events SSE for authenticated browser; Electron subscribe invalidation uses IPC.

Desktop floating view recognized with query `?floating=1`. Native window controls via preload only. User theme saved server-side and applied using CSS; system mode follows matchMedia. UI default new installation is empty, import actual project to populate. Never create sample counts or simulated controls in production.

Plugin interface owned by integration worker: export `createPlugin({dataDir,pluginDir,getTask,getProject,updateTask,emit,now?})` from plugins/codex-autocontinue/host.mjs; returns `{state(),configure(config),enable(),disable(),check(),setPolicy({taskId,enabled,maxAttempts}),resume({taskId,expectedRevision,commandId}),pause({taskId,expectedRevision}),close()}`. Methods may be async. getTask(id) returns Task, getProject(id) Project, updateTask(id,patch,expectedRevision) applies validated core change, emit invalidates state. Root persists plugin config/policies via plugin dataDir; worker owns persistence implementation. Plugin only resumes explicitly bound conversationId and project directory. Python bridge uses vendored upstream code, stdio RPC. No credentials/config changes. Default disabled. Always preserve manual pause, require fresh quota, stop on approvals, avoid duplicates and unknown-result retries. All real turn execution requires a user action or explicitly enabled per-task policy; read-only checks may run.
