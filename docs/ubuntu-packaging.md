# Ubuntu `.deb` 打包状态

仓库包含 Ubuntu 24.04 x64 的 Tauri 打包步骤，但截至本文更新，**没有本机 Ubuntu 构建、安装或完整桌面验收记录**。请把下文视为候选构建说明，不要将其描述成已验证的 Ubuntu 发布包。面向新用户的依赖、安装、运行和首次项目步骤见 [Ubuntu 24.04 构建指南](build-ubuntu.zh-CN.md) / [English](build-ubuntu.en.md)。

Tauri CLI 2.11.5 会在 `bundle.linux.deb.depends` 声明的 `python3`、`tmux` 后追加 WebKitGTK 4.1、GTK 3 及启用托盘所需的系统库依赖。Debian 配置不会影响其他平台或 RPM。Linux 的打包脚本不会把 tmux 内置到应用，也不会提供固定的预览 Python；该预览运行时目前只支持 macOS arm64。

仓库的 `.github/workflows/desktop.yml` 使用 Ubuntu 24.04 runner，依赖列表包括 WebKitGTK 4.1、build-essential、curl、wget、file、libxdo、OpenSSL、AppIndicator、rsvg 与 patchelf；workflow 还安装 Node.js 24、pnpm 11、Python 3.12 和 stable Rust，并请求生成 `.deb` 与 AppImage。workflow 配置只说明计划执行的命令，不构成 workflow 实际通过或产物可运行的证据。Node 许可证脚本会先尝试读取本机 Node 安装中的许可证，找不到时从匹配版本的 Node.js 官方地址下载；离线构建可用 `NODE_LICENSE_PATH` 提供对应完整许可证。

构建后仍需实际检查 `dpkg-deb -f <包路径> Depends`，安装到隔离的 Ubuntu 24.04 x64 图形桌面，再验证窗口、sidecar、文件汇报、终端/tmux 和退出流程。`.deb` 依赖系统 Python 3；基础任务看板不依赖 Codex 自动继续插件。可选 Codex 插件允许用户指定 Python 路径，但仅凭 Python 或安装包存在，不能据此宣称插件执行兼容。Windows/Ubuntu 全量原生功能验收仍未完成。

官方参考：[Tauri 前置条件](https://v2.tauri.app/start/prerequisites/) · [Tauri Debian 打包说明](https://v2.tauri.app/distribute/debian/) · [仓库桌面构建工作流](../.github/workflows/desktop.yml)。
