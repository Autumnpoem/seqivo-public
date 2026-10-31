# Windows 10/11 x64：从源码构建与使用序程

本文介绍在 Windows 10/11 x64 上自行运行开发版或构建 NSIS 安装程序。目前公开发布为 **v0.4.1-r2**（应用版本仍为 **0.4.1**），提供 Mac Apple Silicon 和 Android 包；Windows/Ubuntu 需本机构建，且 Windows 的构建配置不代表已在 Windows 实机验收。所有命令都在 Windows 本机 PowerShell 中执行，除明确标注外不要在 WSL 终端运行。

基础任务看板和 `.taskboard/` 文件汇报不需要 Hub 账号、AI API 密钥、业务 API 或业务数据库。源码 Web 版只需 Node.js、pnpm 和终端模块的编译工具；桌面版还需要 Rust、Windows C++ 工具链和 WebView2。

## 1. 安装构建工具

先安装并完成以下项目，再打开一个新的 PowerShell 窗口：

1. 安装 [Git for Windows](https://git-scm.com/download/win)。
2. 从 [Node.js 官方下载页](https://nodejs.org/en/download)安装 **Node.js 24 LTS x64**。本项目要求 Node.js 24 或更新版本。
3. 安装 pnpm 11.25.0：

   ```powershell
   npm install --global pnpm@11.25.0
   ```

4. 从 [Python 官方下载页](https://www.python.org/downloads/windows/)安装 Python 3.12 x64（node-pty 的本机编译需要 Python），并确认 `py -3 --version` 可运行。
5. 从 [Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) 安装器中选择 **Desktop development with C++** 工作负载，确保包括 MSVC x64/x86 工具和 Windows SDK。node-pty 依赖本机 C++ 编译；没有这些工具时依赖安装可能失败。
6. 安装 Rust stable MSVC 工具链。Tauri 官方提供 `winget` 安装方式：

   ```powershell
   winget install --id Rustlang.Rustup
   ```

   新开 PowerShell 后执行：

   ```powershell
   rustup default stable-msvc
   rustc --version
   cargo --version
   ```

7. 确认 Microsoft Edge WebView2 Runtime 已安装。Windows 11 和较新的 Windows 10 通常已包含它；若应用不能启动或运行安装包时提示缺失，请从 [Microsoft WebView2 下载页](https://developer.microsoft.com/microsoft-edge/webview2/)安装 Evergreen Runtime。

检查版本：

```powershell
git --version
node --version
pnpm --version
py -3 --version
rustc --version
```

Windows 终端能力使用系统 Shell。node-pty 的 Windows PTY 支持要求 Windows 10 1809 或更新版本；序程不在 Windows 原生环境中提供 tmux。WSL tmux 是单独的终端目标，需要用户已有的 WSL 发行版和发行版内 tmux，详见 [WSL 终端说明](wsl-terminal.zh-CN.md)。

## 2. 下载公开源码

```powershell
git clone https://github.com/Autumnpoem/seqivo-public.git
Set-Location seqivo-public
```

仓库当前应用版本为 0.4.1。公开 Release 页面是 [GitHub Releases](https://github.com/Autumnpoem/seqivo-public/releases/latest)；若没有 Windows 安装包，请按本指南本机编译。

## 3. 运行桌面开发版

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm start
```

`pnpm start` 会构建前端、准备当前 Windows 的 Node.js sidecar，再启动 Tauri 桌面开发版。保持终端打开，关闭应用或按 `Ctrl+C` 停止开发进程。首次安装依赖时 node-pty 可能需要 Visual Studio C++ 工具链编译。

如果只想先运行网页看板、不编译桌面壳：

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm server
```

在本机浏览器打开 <http://127.0.0.1:4317>。保持服务终端运行；首次使用时从源码目录 `.runtime/access.json` 读取 `owner` 访问令牌并输入登录页。不要把令牌放进网址、聊天或公开文件。该方式不需要 Rust 或 WebView2，但安装 `node-pty` 时仍需要 Node.js 依赖和 Windows C++ 编译环境。

## 4. 构建并安装 NSIS 安装程序

在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm desktop:prepare
pnpm exec tauri build --bundles nsis
```

这条命令构建 Tauri 的 NSIS `.exe` 安装器；本指南不构建 MSI，因此不需要 WiX。Tauri 会使用当前 Windows x64 主机构建。安装程序通常位于 `src-tauri\target\release\bundle\nsis\`；列出生成文件：

```powershell
Get-ChildItem .\src-tauri\target\release\bundle\nsis\*.exe
```

运行列出的 `.exe` 并按安装向导操作。此仓库没有配置 Windows 发布者签名；自编译文件可能显示 Windows 安全提示。只有在确认源码和构建来源可信后再运行。此步骤不会替你发布安装包。

## 5. 首次启动和第一个项目

从开始菜单启动“序程”。点击“新建”，选择 AI 实际读写的项目文件夹；名称默认取文件夹名，目标可以留空。点“继续接入”进入“项目接入”，待说明准备好后复制提示词，粘贴到正在使用该项目的 Codex、Claude 或其他 AI 对话。序程不会替你启动 AI。

AI 按 `.taskboard/REPORTING.md` 的说明把进度写到项目的 `.taskboard/inbox/`。只有序程处理记录、写入回执并显示“汇报已接收”后，进度才进入看板；再点“查看对应任务”检查内容。完成后由你检查实际实现、证据和验收标准，并手动通过或退回。新对话继续使用同一个项目目录并读取项目背景与任务快照。

首次上手的详细流程和截图见[新电脑图文指南](new-computer-guide.zh-CN.md)和 [README 的第一个项目步骤](../README.md#第一个项目)。文档截图使用隔离的虚构演示项目，不是 Windows 验收结果。

桌面应用数据默认位于 `%APPDATA%\com.autumnpoem.tuijin`。删除或更换源码目录不会自动删除此数据；迁移或重置前先备份。

## 6. 平台能力和未完成验收

- 基础项目、任务、人工验收和文件汇报与 AI 命令行执行是不同能力；不配置 Codex 插件也能复制提示词并接收文件汇报。
- Windows 原生终端使用系统 Shell；原生 tmux 不支持。WSL 是另行安装、配置的独立目标，并非序程安装程序自动提供。
- 固定的受控网页预览 Python 运行时只支持 macOS Apple Silicon；Windows 上不会准备该预览运行时。
- Windows 桌面本机构建、安装、真实终端、托盘和所有权限流程尚未完成完整实机验收。本指南能帮助你尝试构建，不证明这些功能已通过验收。遇到问题时请保留终端错误、Windows 版本、Node/Rust 版本和应用版本，先停止重复安装或执行。

## 官方构建资料

- [Tauri 2 系统前置条件](https://v2.tauri.app/start/prerequisites/)
- [Tauri Windows 安装包（NSIS / MSI）](https://v2.tauri.app/distribute/windows-installer/)
- [Microsoft WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
- [node-pty Windows 支持与编译要求](https://github.com/microsoft/node-pty#dependencies)
- [桌面构建配置与数据目录](desktop-build.md)
