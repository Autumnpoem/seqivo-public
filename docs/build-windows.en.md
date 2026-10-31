# Build and use Seqivo from source on Windows 10/11 x64

This guide covers running the desktop development build or creating an NSIS installer on Windows 10/11 x64. The current public release is **v0.4.1-r2** (the app version remains **0.4.1**) and provides Mac Apple silicon and Android packages. Windows and Ubuntu require local builds; the Windows build configuration does not mean it has been validated on Windows hardware. Run the commands in Windows PowerShell unless a step explicitly says otherwise. Do not run these steps in a WSL terminal.

The basic task board and `.taskboard/` file reporting need no Hub account, AI API key, business API, or business database. The source web app needs Node.js, pnpm, and native build tools for its terminal dependency. The desktop app also needs Rust, the Windows C++ toolchain, and WebView2.

## 1. Install the build tools

Install the following, then open a new PowerShell window:

1. Install [Git for Windows](https://git-scm.com/download/win).
2. Install **Node.js 24 LTS x64** from the [official Node.js download page](https://nodejs.org/en/download). This project requires Node.js 24 or later.
3. Install pnpm 11.25.0:

   ```powershell
   npm install --global pnpm@11.25.0
   ```

4. Install Python 3.12 x64 from [Python’s official Windows downloads](https://www.python.org/downloads/windows/) for the native `node-pty` build, then make sure `py -3 --version` works.
5. From the [Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) installer, select **Desktop development with C++**. Ensure the workload includes the MSVC x64/x86 tools and a Windows SDK. `node-pty` may need a local C++ compiler during dependency installation.
6. Install the stable Rust MSVC toolchain. Tauri documents this `winget` option:

   ```powershell
   winget install --id Rustlang.Rustup
   ```

   Open a new PowerShell window and run:

   ```powershell
   rustup default stable-msvc
   rustc --version
   cargo --version
   ```

7. Make sure the Microsoft Edge WebView2 Runtime is installed. Windows 11 and recent Windows 10 versions usually include it. If the app or installer reports that it is missing, install the Evergreen Runtime from [Microsoft’s WebView2 page](https://developer.microsoft.com/microsoft-edge/webview2/).

Check the installed tools:

```powershell
git --version
node --version
pnpm --version
py -3 --version
rustc --version
```

The Windows terminal uses the system shell. The Windows PTY support in `node-pty` requires Windows 10 version 1809 or later. Seqivo does not provide native Windows tmux. WSL tmux is a separate terminal target and requires an existing WSL distribution and tmux inside it; see the [WSL terminal guide (Chinese)](wsl-terminal.zh-CN.md).

## 2. Clone the public source

```powershell
git clone https://github.com/Autumnpoem/seqivo-public.git
Set-Location seqivo-public
```

The app version in this source is 0.4.1. See [GitHub Releases](https://github.com/Autumnpoem/seqivo-public/releases/latest); if there is no Windows installer, build it locally using this guide.

## 3. Run the desktop development build

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm start
```

`pnpm start` builds the frontend, prepares the Node.js sidecar for the current Windows host, and starts the Tauri desktop development app. Keep the terminal open. Close the app or press `Ctrl+C` to stop the development process. The first dependency install may compile `node-pty` and need the Visual Studio C++ tools.

To try the web board without compiling the desktop shell:

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm server
```

Open <http://127.0.0.1:4317> in a browser on the same computer and keep the server terminal open. On first use, read the `owner` access token from `.runtime/access.json` in the source directory and enter it on the login page. Do not put the token in a URL, chat, or public file. This path does not need Rust or WebView2, but installing `node-pty` still requires Node.js dependencies and the Windows C++ build environment.

## 4. Build and install an NSIS installer

Run from the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm desktop:prepare
pnpm exec tauri build --bundles nsis
```

This command builds Tauri’s NSIS `.exe` installer. It does not build an MSI, so WiX is not needed for this command. Tauri builds for the current Windows x64 host. The installer is normally placed under `src-tauri\target\release\bundle\nsis\`. List the generated file:

```powershell
Get-ChildItem .\src-tauri\target\release\bundle\nsis\*.exe
```

Run the listed `.exe` and follow its installer. This repository does not configure a Windows publisher signature, so Windows may display a security warning. Run the file only after you trust the source and build. This does not publish the installer.

## 5. First launch and first project

Launch **序程** from the Start menu. Click **新建** (“New”) and choose the folder the AI actually reads and edits. The project name defaults to the folder name; the goal is optional. Click **继续接入** (“Continue setup”) to open **项目接入** (“Project connection”). When the instructions are ready, copy the prompt into the Codex, Claude, or other AI conversation already working on that project. Seqivo does not start the AI for you.

Following `.taskboard/REPORTING.md`, the AI writes progress events under `.taskboard/inbox/`. Progress reaches the board only after Seqivo processes an event, writes its receipt, and shows **汇报已接收** (“Report received”). Click **查看对应任务** (“View related task”) to check the content. Review the implementation, evidence, and acceptance criteria yourself, then manually pass or return the work. A new conversation can continue from the same project folder, project context, and task snapshot.

For the full illustrated walkthrough, see the [new-computer guide (Chinese)](new-computer-guide.zh-CN.md) and [README first-project steps](../README.md#第一个项目). The screenshots use an isolated fictional demo project; they are not Windows acceptance evidence.

Desktop app data is stored by default at `%APPDATA%\com.autumnpoem.tuijin`. Removing or moving the source folder does not remove this data. Back it up before a migration or reset.

## 6. Platform capabilities and unverified areas

- Basic projects, tasks, human acceptance, and file reporting are separate from AI command execution. You can copy a reporting prompt and receive file reports without configuring the Codex plugin.
- The native Windows terminal uses the system shell; native tmux is not supported. WSL is a separately installed and configured target, not part of the Seqivo installer.
- The fixed controlled web-preview Python runtime supports macOS Apple silicon only; it is not prepared on Windows.
- A complete Windows desktop build, install, real terminal, tray, and permission flows have not passed full hands-on acceptance. This guide helps you try a build; it does not claim those features passed acceptance. If a step fails, keep the terminal error and record the Windows, Node, Rust, and app versions before retrying.

## Official build references

- [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Tauri Windows installers (NSIS / MSI)](https://v2.tauri.app/distribute/windows-installer/)
- [Microsoft WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
- [node-pty Windows support and build requirements](https://github.com/microsoft/node-pty#dependencies)
- [Desktop build configuration and data directory](desktop-build.md)
