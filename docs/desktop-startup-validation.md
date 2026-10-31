# Desktop startup handshake / 桌面启动握手

**Scope:** the startup handshake for the desktop app built from `eeada3524eea703291a2374f47f327a1d24b9bc2`, plus bounded build, install, browser, and deployment observations. These results do not establish completion of broader app acceptance.

## Behavior

The Rust host owns a monotonic startup state (`starting`, `ready`, `failed`, `stopping`) and revision. A `ready` transition is accepted only from `starting`; later failure or shutdown cannot be overwritten by a delayed `ready` event. The desktop API bridge waits for `ready` before sending requests.

The web client subscribes to startup events before reading the current snapshot. It ignores stale revisions, performs the initial board-state read once on the first `ready`, and retries status observation if listener registration or status reads fail. A retry does not replay a mutation or repeat the initial board read.

## Verification

For commit `eeada3524eea703291a2374f47f327a1d24b9bc2`, the reported checks were:

- Rust startup and shutdown state checks: 14/14; no separate Cargo check result is claimed.
- Node startup, sidecar-shutdown and shutdown suites: 7/7 + 4/4 + 4/4 passed.
- TypeScript and Vite checks passed; existing Lucide warnings remained.
- Independent review found a listener-retry issue; the issue was fixed and verified.
- Build 652 completed all 10 reported steps with exit 0. The ad-hoc-signed app was installed in the canonical location.
- On first launch, the native startup screen appeared. The initial wait exceeded 10 seconds, then the original board loaded automatically without a retry click; the original two projects and 62 task payloads were unchanged.
- Normal Command-Q closed Core in 34 ms; the Core lock was absent and the app and sidecar processes were gone. Deployment 656 and its post-deployment checks exited 0 with the 142-entry manifest verified.
- In browser check 653, the app remained in `starting` beyond 10 seconds with no board GET; after `ready`, it loaded the board once without a GUI retry or write.

Two opt-in SSH shutdown tests were skipped and are not included in these totals.

## Limits / 未覆盖

The first-launch delay before the earliest recorded sidecar stage remains unresolved. Recorded stage timings (runtime verification 338 ms; ready 448 ms) begin after static imports, so they do not explain or eliminate the preceding delay. There is no evidence attributing the delay to Python. Same-data warm reopen automatically loaded the original board without a retry. These are bounded observations, not full native-app acceptance. The implementation does not replay queued operations automatically; a failure or timeout remains not ready/unknown until status is checked again.

The separate Documents-root preview read timeout remains unattributed; this startup-handshake result does not resolve it. Broader managed AI handoff, restart ownership, preview integration, and cross-platform acceptance remain open in the [remaining work plan](remaining-work-plan.md).

## Source map

- `src-tauri/src/startup.rs`: state transitions and Rust unit checks.
- `src-tauri/src/main.rs`: sidecar readiness, request gate, and status command.
- `src/lib/desktop-startup.ts`: event-before-snapshot ordering, revision filtering, and status retry.
- `tests/desktop-startup.test.mjs`, `tests/sidecar-shutdown.test.mjs`: startup gate and shutdown interaction coverage.
