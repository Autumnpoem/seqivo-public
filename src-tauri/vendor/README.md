# Pinned Tao macOS Quit patch

`tao-0.35.3` is the complete crates.io source archive already pinned by this
project. Archive SHA-256:
`d1c93047acf68669466a34690ac58cca7010bd1b201e1ec86f1fd0a75d3dd4a9`.
Upstream license and notices are retained in that directory. Upstream:
<https://github.com/tauri-apps/tao> (Apache-2.0).

Only these upstream files have local changes:

- `src/platform_impl/macos/app_delegate.rs`: registers the correctly typed
  `applicationShouldTerminate:` selector when Tao creates its existing delegate
  class, before `NSApplication.setDelegate:`. An installed application handler
  is called once per native request; AppKit receives `NSTerminateCancel` even if
  that handler panics. With no installed handler, AppKit's default approval is
  preserved. Three focused tests cover these replies.
- `src/platform_impl/macos/mod.rs`: re-exports the internal setter.
- `src/platform/macos.rs`: a single-registration, main-thread-only callback API.

Seqivo installs the callback before spawning its sidecar. Dock Quit and Quit
AppleEvents enter the same one-shot shutdown gate as the app menu and tray.
Only a flushed shutdown receipt **and** a normal sidecar exit permit a clean
`AppHandle::exit(0)`. Failed or uncertain shutdown keeps the existing warning
and unknown-state fences. There is no delegate replacement, runtime method
swizzle, new AppleEvent handler, force-kill, or timeout-based approval.

**System logout/restart:** this version immediately cancels the native request
and closes Seqivo through its own event loop after cleanup. A logout/restart
attempt may need to be repeated after Seqivo has closed. It does not use
`NSTerminateLater`, hold an unresolved AppKit reply, or claim that an interrupted
shutdown was clean. Forced OS termination remains outside this guarantee.

The direct macOS dependency and `[patch.crates-io]` must resolve to the same Tao
package as `tauri-runtime-wry`. On upgrades, compare the three files against the
new upstream delegate, run the focused Rust/sidecar tests, and exercise actual
Dock/OS Quit separately from menu Quit. A compilation pass is not native quit
acceptance. Windows and Linux implementations are unmodified.

References: [AppKit termination decision](https://developer.apple.com/documentation/appkit/nsapplicationdelegate/applicationshouldterminate%28_%3A%29),
[application termination](https://developer.apple.com/documentation/appkit/nsapplication/terminate%28_%3A%29),
[system logout lifecycle](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/Lifecycle.html).
