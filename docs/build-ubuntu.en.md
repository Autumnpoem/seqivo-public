# Build and use Seqivo from source on Ubuntu 24.04 LTS x64

This guide covers running the desktop development build or creating a `.deb` / AppImage on Ubuntu 24.04 LTS x64 with a graphical desktop. The current public release is **v0.4.1-r2** (the app version remains **0.4.1**) and provides Mac Apple silicon and Android packages. Windows and Ubuntu require local builds. Ubuntu has a configured build workflow, but there is no released Ubuntu installer or hands-on acceptance evidence from an Ubuntu machine. A build configuration is not a full compatibility result.

The basic task board and `.taskboard/` file reporting need no Hub account, AI API key, business API, or business database. The desktop app uses the current system Node.js process as its local service sidecar. On Ubuntu, terminal features depend on system Python 3 and tmux.

## 1. Install system dependencies

Open a terminal and install the Tauri, node-pty, and runtime packages:

```sh
sudo apt update
sudo apt install -y \
  git build-essential python3 pkg-config curl wget file \
  libwebkit2gtk-4.1-dev libgtk-3-dev libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf tmux
```

`build-essential` and `python3` are used to compile node-pty. WebKitGTK 4.1, GTK, AppIndicator, and rsvg are Tauri desktop build libraries. The app’s `.deb` declares dependencies on system `python3` and `tmux`; the Linux build script does not bundle tmux.

Install [Node.js 24 LTS x64](https://nodejs.org/en/download), then install the pnpm version pinned by this repository:

```sh
npm install --global pnpm@11.25.0
```

Install stable Rust using the [Tauri Rust prerequisites](https://v2.tauri.app/start/prerequisites/):

```sh
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
source "$HOME/.cargo/env"
rustc --version
cargo --version
```

Check the tools:

```sh
node --version
pnpm --version
python3 --version
tmux -V
```

## 2. Clone the source

```sh
git clone https://github.com/Autumnpoem/seqivo-public.git
cd seqivo-public
```

The app version in this source is 0.4.1. Check [public Releases](https://github.com/Autumnpoem/seqivo-public/releases/latest); if no Ubuntu installer is available, build one locally using this guide.

## 3. Run the desktop development build

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm start
```

`pnpm start` builds the frontend, prepares the Node.js sidecar for the current Linux host, and starts the Tauri desktop development app. Keep the terminal open. Close the app and press `Ctrl+C` to end the command. The first dependency installation compiles node-pty with the local C++ toolchain.

If you only need the local browser board, you do not need Rust or Tauri:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm server
```

Open <http://127.0.0.1:4317> on the same computer and keep the server running. On first use, read the `owner` access token from `.runtime/access.json` in the source directory and enter it on the board login page. Do not put the token in a URL, chat, or public file. This web path does not need Rust, WebKitGTK, or tmux; the first `node-pty` install still needs `build-essential` and Python 3.

## 4. Build installers

Run the same packaging steps used by the repository workflow from the project root:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm desktop:prepare
pnpm exec tauri build --bundles deb,appimage
```

The packaging script copies the current Node.js executable as the sidecar and prepares its license. If no local license is found and the Node.js download host is unreachable, the step fails. For an offline build, get the complete `LICENSE` file from the official Node.js distribution matching your installed version, then set `NODE_LICENSE_PATH=/absolute/path/LICENSE` before rerunning `pnpm desktop:prepare`.

Artifacts are written to:

```text
src-tauri/target/release/bundle/deb/*.deb
src-tauri/target/release/bundle/appimage/*.AppImage
```

The `.deb` is the recommended first install because apt installs its declared system dependencies:

```sh
DEB_FILE="$(find "$PWD/src-tauri/target/release/bundle/deb" -maxdepth 1 -type f -name '*.deb' -print -quit)"
test -n "$DEB_FILE"
sudo apt install "$DEB_FILE"
```

Then launch **序程** from the desktop application menu. To try the AppImage directly:

```sh
APPIMAGE="$(find src-tauri/target/release/bundle/appimage -maxdepth 1 -type f -name '*.AppImage' -print -quit)"
test -n "$APPIMAGE"
chmod +x "$APPIMAGE"
"$APPIMAGE"
```

An AppImage does not install Ubuntu system dependencies. You still need the graphical libraries, Python 3, and tmux listed above. You can also use the development build without packaging it.

## 5. First project and data location

Launch Seqivo and click **新建** (“New”). Select the local project folder that the AI reads and edits. The project name defaults to the folder name and the goal is optional. Click **继续接入** (“Continue setup”), then copy the prompt from **项目接入** (“Project connection”) into the Codex, Claude, or other AI conversation already working in that folder. Seqivo does not start the AI.

Following `.taskboard/REPORTING.md`, the AI writes progress to `.taskboard/inbox/`. Progress reaches the board only after Seqivo processes the event, writes a receipt, and shows **汇报已接收** (“Report received”). Click **查看对应任务** (“View related task”) to review it. Evidence, tests, and human acceptance are recorded separately; you decide whether to pass or return the work. In a new conversation, use the same project folder and read its context and task snapshot.

See the [new-computer illustrated guide (Chinese)](new-computer-guide.zh-CN.md) and the [README first-project steps](../README.en.md#your-first-project) for the full walkthrough. Screenshots use fictional isolated demo data, not results from Ubuntu testing.

Desktop app data is stored under `$XDG_DATA_HOME/com.autumnpoem.tuijin`, or usually `~/.local/share/com.autumnpoem.tuijin` when `XDG_DATA_HOME` is not set. Source web mode stores data in the repository’s `.runtime/` folder by default. Removing the source directory does not automatically remove desktop app data. Back it up before migration.

## 6. Ubuntu capabilities and validation limits

- Linux packaging does not bundle tmux. The `.deb` depends on system `tmux` and `python3`; AppImage users must provide these and the graphical runtime libraries themselves.
- The fixed controlled web-preview Python runtime supports macOS Apple silicon only. Linux builds do not prepare it.
- Ubuntu has code paths for the local terminal, but a successful local compile does not prove tmux, tray, startup/shutdown, or every real task flow passed acceptance.
- There is no complete hands-on build, installation, and usage validation for an Ubuntu native package. The GitHub Actions file defines an Ubuntu 24.04 job, but a workflow definition alone does not show that an installer was produced or validated.

If a build fails, record the first full error plus the Ubuntu, Node, pnpm, and Rust versions. Check the Tauri dependencies before retrying. Do not skip `desktop:prepare` or ignore sidecar errors and then call the installer valid.

## Official build references

- [Tauri 2 Linux prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Tauri Debian packaging](https://v2.tauri.app/distribute/debian/)
- [Tauri AppImage guide](https://v2.tauri.app/distribute/appimage/)
- [Official Node.js downloads](https://nodejs.org/en/download)
- [node-pty Linux build dependencies](https://github.com/microsoft/node-pty#dependencies)
- [Desktop build configuration and data directory](desktop-build.md)
