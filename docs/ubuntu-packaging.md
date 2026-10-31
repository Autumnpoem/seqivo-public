# Ubuntu `.deb` 打包状态

当前仅配置了 Ubuntu/Debian 包的额外运行依赖，**尚未构建或安装 Ubuntu 原生应用**。Tauri CLI 2.11.5 会在 `bundle.linux.deb.depends` 的 `python3`、`tmux` 后追加 WebKitGTK 4.1、GTK 3 及按启用功能选择的托盘库依赖；该配置不影响其他平台或 RPM。打包脚本在 Linux 上不会内置 tmux，也不会内置仅支持 macOS arm64 的预览 Python。

首个隔离构建需 Ubuntu 22.04 x86_64、Node.js 24、pnpm 11.25.0、稳定版 Rust/Cargo、`pkg-config`、`patchelf` 与 Tauri Linux 开发库（WebKitGTK 4.1、GTK 3、AppIndicator、rsvg；若链接要求则有 OpenSSL 开发库）。构建时提供与 Node 版本匹配的本地 `NODE_LICENSE_PATH`，并保持 `SEQIVO_PREVIEW_PYTHON_ARCHIVE` 未设置。完成依赖准备后在隔离源码和 target 中运行：

```sh
pnpm install --frozen-lockfile
pnpm build
NODE_LICENSE_PATH=<已核实的本地许可证路径> pnpm desktop:prepare
CARGO_TARGET_DIR=<隔离的 target 路径> pnpm exec tauri build --bundles deb
```

包生成后应检查 `dpkg-deb -f <包路径> Depends`、安装到隔离 Ubuntu 桌面环境并验证窗口、sidecar、tmux 会话及退出。`python3` 是系统解释器依赖，基础看板不依赖 Codex 自动继续插件；因此 `.deb` 未将 Python 3.12 设为整包安装门槛。[桌面构建文档](desktop-build.md#本地依赖)将 Python 3.12 列为该可选插件桥接进程的目标版本，并允许在插件设置中指定解释器；当前插件代码只查找系统 `python3` 或指定路径，没有显式的 3.12 版本校验。Ubuntu 22.04 默认的 Python 3.10 对该插件的兼容性尚未验证，不能仅凭整包安装成功宣称自动继续可用。

依据：[Tauri 2.11.5 CLI 实现](https://docs.rs/tauri-cli/2.11.5/src/tauri_cli/interface/rust.rs.html#1386-1453)、[Tauri Debian 打包说明](https://v2.tauri.app/distribute/debian/)。
