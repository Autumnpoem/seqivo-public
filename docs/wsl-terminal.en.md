# Windows WSL tmux terminal

Windows terminal profiles now have a separate WSL tmux target. It connects to a WSL distribution selected by the user and runs tmux inside that distribution. A Windows native Shell profile remains independent and can be configured and used when WSL is unavailable.

## Configure and use

1. In the Windows owner's terminal settings, choose **WSL tmux**. The app lists installed distributions. Select one and enter an existing Linux absolute working directory in that distribution, such as `/home/alex/project`. Do not enter a Windows path or assume a drive is mounted at `/mnt/c`.
2. On save, the app reads the distribution's default Linux username and UID and checks that the directory exists. The profile is bound to that identity. If the distribution, tmux, or UID later becomes unavailable or changes, the connection is reported unavailable; review the configuration before continuing.
3. Connect to list existing tmux sessions, create a session, select the current session, set a default, or attach again. New sessions start in the configured Linux directory. Session references are bound to the distribution, user identity, and tmux server identity, so a changed target does not silently reuse an old reference.
4. Connecting from a phone still requires the existing device enrollment and grant flow. A WSL profile does not expand device permissions. For integrations, `GET /api/terminal/wsl` reports WSL support and installed distributions; `POST /api/terminal/profiles` creates or updates a profile with `runtime: "wsl"`, `wslDistro`, and `wslCwd`. Use the application's existing authentication and authorization path for these APIs.

Microsoft's reference covers listing installed distributions, selecting a distribution and Linux user, and running WSL commands: [Basic commands for WSL](https://learn.microsoft.com/en-us/windows/wsl/basic-commands). The app lists distributions already installed on the machine; it does not install a distribution or tmux.

## Boundaries

A WSL profile is an independent terminal and cannot be associated with a managed project. It does not support AI takeover, return, or host-process-stop proof. The Hub profile projection exposes only `runtime: "wsl"`; the Linux username, UID, and working directory remain in the local configuration. An independent WSL terminal is not a sandbox: programs can access data available to that Linux user. A working tmux connection does not establish managed-task authority or process isolation.

The synthetic Windows-owner browser fixture passed: native profile configuration remains independently saveable without WSL; a distribution can be selected; Windows paths are rejected while a Linux absolute path containing spaces is accepted; a new profile has no project binding; editing keeps runtime/distribution fixed and preserves cwd; WSL has no ordinary-Shell or AI-takeover option; and the dark 390px layout has no horizontal overflow. Three profile writes, screenshots, and an accessibility snapshot are recorded in the [browser fixture result](../.runtime/wsl1095/browser-result.json). This is not validation on a real Windows account, WSL distribution, or physical phone.

Automated tests use mocked WSL commands and local PTY/tmux fixtures. The final frontend build passed. This feature has not been packaged, installed, or deployed.
