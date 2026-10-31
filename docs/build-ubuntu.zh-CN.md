# Ubuntu 24.04 LTS x64：从源码构建与使用序程

本文介绍在带图形桌面的 Ubuntu 24.04 LTS x64 上运行开发版，或自行构建 `.deb` / AppImage。目前公开发布为 **v0.4.1-r2**（应用版本仍为 **0.4.1**），提供 Mac Apple Silicon 和 Android 包；Windows/Ubuntu 需本机构建。Ubuntu 有构建工作流配置，但没有已发布或已在 Ubuntu 实机验收的安装包。请不要把“构建配置”当作完整兼容性结论。

基础任务看板和 `.taskboard/` 文件汇报不要求 Hub 账号、AI API 密钥、业务 API 或业务数据库。桌面版使用当前系统 Node.js 作为本机服务 sidecar；Ubuntu 上的终端依赖系统 Python 3 和 tmux。

## 1. 安装系统依赖

打开终端，安装 Tauri、node-pty 和应用运行需要的 Ubuntu 软件包：

```sh
sudo apt update
sudo apt install -y \
  git build-essential python3 pkg-config curl wget file \
  libwebkit2gtk-4.1-dev libgtk-3-dev libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf tmux
```

`build-essential` 和 `python3` 用于编译 node-pty；WebKitGTK 4.1、GTK、AppIndicator、rsvg 等是 Tauri 图形应用的开发库。应用 `.deb` 声明依赖系统 `python3` 和 `tmux`；构建脚本不会把 tmux 打进 Linux 应用。

安装 [Node.js 24 LTS x64](https://nodejs.org/en/download)，然后安装仓库固定的 pnpm 版本：

```sh
npm install --global pnpm@11.25.0
```

按 [Tauri Rust 前置条件](https://v2.tauri.app/start/prerequisites/)安装 Rust stable 工具链：

```sh
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
source "$HOME/.cargo/env"
rustc --version
cargo --version
```

检查版本：

```sh
node --version
pnpm --version
python3 --version
tmux -V
```

## 2. 下载源码

```sh
git clone https://github.com/Autumnpoem/seqivo-public.git
cd seqivo-public
```

应用源码版本为 0.4.1。查看[公开 Release](https://github.com/Autumnpoem/seqivo-public/releases/latest)；如果没有 Ubuntu 安装包，可在本机按本指南构建。

## 3. 运行桌面开发版

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm start
```

`pnpm start` 会构建前端、为当前 Linux 主机准备 Node.js sidecar 并运行 Tauri 开发桌面应用。保持终端打开；关闭应用后按 `Ctrl+C` 结束命令。首次安装依赖时 node-pty 会使用本机 C++ 编译工具。

若只需要本机浏览器中的看板，不需要 Rust/Tauri：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm server
```

在同一台电脑打开 <http://127.0.0.1:4317>，并让终端服务持续运行。首次使用时从源码目录 `.runtime/access.json` 读取 `owner` 访问令牌，输入看板登录页。不要把令牌放进网址、聊天或公开文件。该网页方式不需要 Rust、WebKitGTK 或 tmux；首次安装 node-pty 仍需要 `build-essential` 和 Python 3。

## 4. 构建安装包

在仓库根目录运行与项目工作流一致的命令：

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm desktop:prepare
pnpm exec tauri build --bundles deb,appimage
```

打包脚本会把当前 Node.js 可执行文件作为 sidecar，并准备 Node.js 许可证。若本机没有许可证文件且无法访问 Node.js 官方下载站，构建会失败；此时可从与当前 Node 版本匹配的官方发行包取得完整 `LICENSE` 文件，并显式设置 `NODE_LICENSE_PATH=/绝对路径/LICENSE` 后重新执行 `pnpm desktop:prepare`。

产物位于：

```text
src-tauri/target/release/bundle/deb/*.deb
src-tauri/target/release/bundle/appimage/*.AppImage
```

推荐先用 `.deb`，由 apt 安装声明的系统依赖：

```sh
DEB_FILE="$(find "$PWD/src-tauri/target/release/bundle/deb" -maxdepth 1 -type f -name '*.deb' -print -quit)"
test -n "$DEB_FILE"
sudo apt install "$DEB_FILE"
```

随后从桌面应用菜单启动“序程”。若要直接试 AppImage：

```sh
APPIMAGE="$(find src-tauri/target/release/bundle/appimage -maxdepth 1 -type f -name '*.AppImage' -print -quit)"
test -n "$APPIMAGE"
chmod +x "$APPIMAGE"
"$APPIMAGE"
```

AppImage 不会自动安装 Ubuntu 系统依赖；首次使用仍需安装本节前述图形库、Python 3 和 tmux。也可以不打包，直接使用上一节的开发版。

## 5. 第一个项目与数据位置

启动序程后点击“新建”，选择 AI 正在读写的本地项目文件夹。项目名会从文件夹名自动填写，目标选填；点击“继续接入”，再复制“项目接入”页面准备好的提示词，粘贴到现有 Codex、Claude 或其他 AI 对话中。序程本身不会启动 AI。

AI 按 `.taskboard/REPORTING.md` 把进度写入 `.taskboard/inbox/`。只有序程处理后写出回执并显示“汇报已接收”，该进度才进入看板。点击“查看对应任务”核对工作；证据、测试和人工验收分开记录，最终由你决定通过或退回。换新对话时继续使用同一个项目目录并读取其背景和任务快照。

完整操作和隔离演示截图见[新电脑图文指南](new-computer-guide.zh-CN.md)及 [README 第一个项目步骤](../README.md#第一个项目)。截图中的项目是虚构数据，不是 Ubuntu 实机结果。

桌面应用数据默认存于 `$XDG_DATA_HOME/com.autumnpoem.tuijin`；未设置 `XDG_DATA_HOME` 时通常是 `~/.local/share/com.autumnpoem.tuijin`。源码网页模式的数据默认在仓库 `.runtime/`。删除源码目录不会自动清除桌面应用数据；迁移前先备份。

## 6. Ubuntu 能力与验收范围

- Linux 打包不内置 tmux；`.deb` 声明依赖系统 `tmux` 与 `python3`，AppImage 用户需自行准备它们和图形运行库。
- 固定的受控网页预览 Python 只支持 macOS Apple Silicon，Linux 构建不会准备它。
- Ubuntu 可以配置 Linux 本机终端代码路径，但本地编译成功不等于 tmux、托盘、启动/退出和所有真实任务流程已经验收。
- 当前没有 Ubuntu 原生包的完整实机构建、安装和使用验收证据。GitHub Actions 文件定义 Ubuntu 24.04 构建 job，但工作流定义本身不代表已产生或验证安装包。

如构建失败，记录完整首个错误、Ubuntu 版本、`node --version`、`pnpm --version` 与 `rustc --version`，核对 Tauri 依赖是否安装后再处理。不要通过跳过 `desktop:prepare` 或忽略 sidecar 错误来宣称安装包有效。

## 官方构建资料

- [Tauri 2 Linux 前置条件](https://v2.tauri.app/start/prerequisites/)
- [Tauri Debian 打包说明](https://v2.tauri.app/distribute/debian/)
- [Tauri AppImage 说明](https://v2.tauri.app/distribute/appimage/)
- [Node.js 官方下载](https://nodejs.org/en/download)
- [node-pty Linux 编译依赖](https://github.com/microsoft/node-pty#dependencies)
- [桌面构建配置与数据目录](desktop-build.md)
