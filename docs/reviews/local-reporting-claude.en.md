# Local project onboarding review

Read-only remote review completed on 2026-10-31. Review snapshot b4c48f4a04c508411d4d511c258b3a2634f284ca. Existing Chinese code was read under the user-approved exception; instructions and report were English. No source files changed remotely. Remote checking was syntax-only; behavioral tests were run locally.

I found no blockers. There are two medium issues, both found by reading the code. I did not reproduce either one at runtime.

## Findings

**1. Medium — a new inbox sort can fail on a file the AI is still renaming (found in code, not reproduced)**
- **Where:** `server/file-bridge-worker.mjs:48-49`.
- **Trigger:** The new sort calls `lstat` on every inbox entry, including `.tmp` files. The instructions tell the AI to write `<id>.tmp` and then rename it to `<id>.json` (`server/file-reporting.mjs:10`). If the rename happens between `readdir` and `lstat`, `lstat` fails with ENOENT. That fails the whole `Promise.all`, so the `list` call fails. The same happens if an AI deletes an inbox file it has already handled.
- **Consequence:** `server/files.mjs:172-175` sets `state.problem`. The phase switches to `attention` and the UI shows a raw ENOENT path error. No events are processed that tick. It recovers on the next tick (about 900 ms), but the UI polls every 2 s, so a false failure may show during the normal reporting flow.
- **Minimal fix:** Keep only `.json` entries before calling `lstat`, and drop any entry whose `lstat` fails with ENOENT instead of failing the whole list.

**2. Medium — an edited `REPORTING.md` rewrites both snapshots every tick and keeps the status at "attention" (found in code; the existing test reaches this state but doesn't check for the repeated writes)**
- **Where:** `server/file-bridge-worker.mjs:76`, `server/files.mjs:161-175` and `server/files.mjs:122-124`.
- **Trigger:** The user adds text to the generated `.taskboard/REPORTING.md` or replaces it. The test for this is `tests/file-reporting.test.mjs:63-73`.
- **Consequences:**
  - `writeReporting` throws on every tick. The catch block sets `this.pending = true` and `prepared` never becomes true, so `tasks.json` and `CONTEXT.md` are rewritten about every 900 ms for as long as the file stays edited. That means constant file-change noise for file watchers and IDEs in the user's repo.
  - The phase stays at `attention` even after reports are accepted, so a working setup never shows `connected`.
  - `state.problem` takes priority over `lastReport.error` (line 124). The UI hides the problem when it equals the report error (`src/ProjectConnection.tsx:73`), so a real rejection reason can be hidden behind the REPORTING.md message.
  - The old issue of overwriting user text is fixed: the file is kept as-is.
- **Minimal fix:** Treat a differing REPORTING.md as a separate, non-fatal flag such as `instructionsCustomized`. Still set `prepared = true`, don't set `pending`, and calculate the phase from `lastReport` only. Show the flag as its own notice.

**3. Low — any future wording change will flag every existing project (concern, not tested)**
- **Where:** `server/file-bridge-worker.mjs:76`.
- **Trigger:** The check is an exact string comparison. If a later release changes `reportingInstructions` at all, every existing project's untouched generated file no longer matches.
- **Consequence:** After that upgrade, every project goes into the state from finding 2, and users are told to move a file they never edited.
- **Minimal fix:** A marker comment already exists (`server/file-reporting.mjs:5`) but nothing reads it. Add a version or hash to it, and replace the file only when its content matches a known earlier generated version.

**Product requirements (from reading the code):**
- **No fake setup task:** The setup creates no task. The core test checks that the task count is 0 and that acceptance stays `unverified`.
- **No acceptance or execution permission claimed:** The instructions say that evidence or `submitted` does not mean human acceptance, and that reporting does not start or resume an AI (`server/file-reporting.mjs:40`).
- **User rules kept:** The instructions tell the AI to keep existing AGENTS.md and CLAUDE.md files unchanged (`server/file-reporting.mjs:6`).
- **Owner only:** The status endpoint is owner-only (`server/core.mjs:948`), and the nav entry is hidden for hub and non-owner roles in both the desktop and mobile menus (`src/App.tsx:747`).

## Usability suggestions
1. Once finding 2 is fixed, replace the generic "needs checking" pill for an edited REPORTING.md with a short notice, for example "Using your existing REPORTING.md".
2. In `src/ProjectConnection.tsx`, `unavailable` includes any status-read error, so a failed status read also disables "Choose folder" and "Bind folder". Binding should not depend on that read succeeding.
3. In the "New project" dialog, the project goal is required, which slows down connecting an existing folder. Also, entering a folder that is already bound quietly returns the existing project and ignores the typed name (`server/store.mjs:124`). Make the goal optional, or at least show a message when an existing project is reused.

## Checks and limits
- I ran `node --check server/files.mjs`. It exited without errors, so the file's syntax is valid. It does not execute or test anything.
- I couldn't record the Node version: my combined command (`node --version` plus the check) was blocked by the permission settings, so I ran the check on its own and didn't try to get around the block. A separate grep command was also blocked; I used the Grep tool for it instead.
- I ran no behavioral tests, no TypeScript or Vite build, and no browser checks. Those results are only from your local runs.
- I edited no files.
- I did not verify any platform, installed build, AI provider, or the product as a whole.

## Local follow-up

The temporary-file sorting failure and repeated unchanged snapshot exports were each reproduced with failing tests, fixed locally, and independently reviewed. Customized instructions remain visible without stopping normal reporting. v0.4.1 also adds safe upgrades for recognized untouched generated instructions, folder-derived names, an optional project goal, clear reuse/error feedback, and explicit preview-before-append project rules. The local follow-up review additionally reproduced and fixed forged public receipt files incorrectly marking a connection as successful: accepted status and timestamps now come from private database records.

The final local targeted suite passed 30/30. Browser checks covered the new setup, real file receipts, direct task navigation, preserved project rules, and narrow light/dark layouts. These are local follow-up results, not a second remote Claude review. Native installation and release evidence are recorded in `docs/local-reporting-results.json`.
