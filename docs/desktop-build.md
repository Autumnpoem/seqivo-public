# 桌面构建与关闭

桌面端使用 Tauri 2，前端由 Vite 构建，任务服务运行在打包的 Node.js 24 sidecar 中。仓库定义了 macOS、Windows 和 Ubuntu 的构建工作流，用于在对应系统构建并上传测试产物，不发布或签名正式版本。

当前公开安装包为 v0.4.1 Mac Apple Silicon 版，下载见[公开 Release](https://github.com/Autumnpoem/seqivo-public/releases/latest)。GitHub 云端工作流仍暂停；Windows、Ubuntu 与 Intel Mac 没有本次已验证安装包。完整公开发行内容见[发行记录](public-release-status.json)。

下文的测试编号和关闭记录属于历史工程证据，只覆盖当时列出的范围，不能代替当前版本或新电脑的完整验收。
## 本地依赖

- Node.js 24、pnpm 11、稳定版 Rust 工具链。
- Python 3.12 用于 Codex 自动继续插件的桥接进程。运行时可以在插件设置里指定 Python 与 Codex 路径；缺少时插件会显示不可用，基础看板仍可使用。
- Ubuntu 需要 WebKitGTK 4.1、AppIndicator、rsvg、OpenSSL 等开发库，安装命令见 [Tauri 官方前置条件](https://v2.tauri.app/start/prerequisites/)。Windows 需要 WebView2；macOS 需要 Xcode 命令行工具。

从项目根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm desktop:prepare
pnpm exec tauri build
```

`desktop:prepare` 把当前系统的 Node 可执行文件复制为 Tauri sidecar，并把 Node.js 当前版本的官方 `LICENSE` 放入 `src-tauri/resources/licenses/Node.js-LICENSE.txt`。若本机无法访问官方 Node 仓库，可将匹配版本的完整许可证放在本机，并设置 `NODE_LICENSE_PATH` 后再执行。插件的上游许可证保留在 `plugins/codex-autocontinue/vendor/LICENSE`。构建还会把本项目 `LICENSE`、`NOTICE.md` 与 `docs/licenses/` 中的第三方许可说明放入应用资源；各组件保持原许可。

## 隔离本地数据

默认数据放在系统应用数据目录：macOS 为 `~/Library/Application Support/com.autumnpoem.tuijin`，Windows 为 `%APPDATA%/com.autumnpoem.tuijin`，Linux 为 `$XDG_DATA_HOME/com.autumnpoem.tuijin`（通常 `~/.local/share/com.autumnpoem.tuijin`）。测试时可指定一个绝对路径：

```sh
TUIJIN_DATA_DIR=/tmp/tuijin-qa pnpm start
```

这个目录保存任务数据库、访问令牌和连接信息。`TUIJIN_WORKSPACE` 可选，用于启动时导入含 `.taskboard/project.json` 的项目目录。隔离目录只改变本次进程的数据位置，不会修改用户原有数据。

## 关闭过程

新版在菜单、⌘Q 或托盘触发“请求退出”时，先阻止最终退出，把关闭指令交给后台线程；重复操作不重复发送，窗口线程不等待清理。任务服务同时关闭 HTTP 和核心，核心先封住终端输入、再关闭插件与终端。所有关闭阶段成功后，任务服务写出并完成刷新 `shutdown-complete` 回执。桌面端同时确认这份回执与实际进程正常退出，才放行最终退出。这样可避免最终退出事件中的 shell 插件先结束它管理的子进程。

超过 75 秒只提示“结果待核实”，不会自动结束任务服务或解除保护记录。若仅连接中断、没有实际进程退出证明，继续观察原请求；若已观察到进程退出但缺少安全关闭证明，用户可单独选择“退出界面”，未确认记录仍保留。它不等于 AI 已停止。较晚到达的结果会更新提示，不重复发送关闭。HTTP 已派发写入仍须完成，不能靠丢弃连接假装安全退出。

当前本机验证：状态与提示转换 11/11、真实隔离 sidecar 子进程 3/3、原关闭回归 4/4 及 Rust 编译检查通过，独立审查通过；见[测试记录](desktop-shutdown-test-results.json)。新子进程测试使用模拟插件，不含真实 AI 或 tmux。原生 QA 窗口的空闲关闭/重开仅有 APP541 限定通过；ACTIVE547 活动 AI 退出结果为 unknown，详见下文。托盘、Dock/系统终止、活动终端和正式交付仍待验。历史隔离 `b3d20e2` 包的 PTY/tmux 与 IPC 退出约 33/35 ms 只保留原范围；历史偶发 25 秒超时的完整触发原因仍未复现。

ACTIVE547 在 QA540 同源码 Mac QA 窗口进行了一个真实 AI 活动任务的退出观察：在前台 180 秒等待尚未结束时发起退出，插件和 Core 分别拒绝关闭，原任务没有可验证的最终 turn/stopProof；记录保留 `retirement_unknown`。测试操作在警告后选择“退出界面”；UI exit 0 不代表 Core 正常关闭。原始执行子进程消失、Hub 随后正常关闭，期限后 139 秒未见迟到写入，开始标记与既有文件未变，production/controller 身份保持。APP541 空闲关闭与重开仍是单独的限定通过。IMPL550 的限定后端测试现为 4/4、相关回归 16/16，零跳过；它覆盖关闭意图/unknown 围栏、同启动与模拟旧启动恢复及错误回执拒绝，不是实际操作系统重启或原生 UI/活动 AI 复验。REVIEW558 限定独立审查未发现新的已证实 P1/P2；新的 Mac 原生包验证与真实活动 AI 退出仍待验；M1 和人工验收未完成。见[机器记录](desktop-shutdown-test-results.json)。

QA545 清理核对：旧的 18 条 QA 应用启动服务注册已不再出现；QA540 测试应用已停止、移入废纸篓并注销。废纸篓没有清空，生产应用、数据和未知状态记录未改动；源码与构建缓存保留，也没有声称删除所有归档或构建产物。该次历史记录中的应用为 v0.4.0；当前公开版本请以上方发行记录为准。范围见[清理记录](desktop-shutdown-test-results.json)。

## Apple Silicon 本机临时签名测试

`scripts/sign-macos-local.mjs` 仅用于 macOS Apple Silicon 的本地 ad-hoc 测试包；它不是 Developer ID 签名或公证工具。必须从开始就把 Cargo 构建产物写入新的隔离目录，避免覆盖默认 `src-tauri/target` 中可能正在使用的 App；不要先运行 `pnpm desktop:pack` 再复制产物：

```sh
QA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/seqivo-macos-test.XXXXXX")"
pnpm build
pnpm desktop:prepare
CARGO_TARGET_DIR="$QA_DIR/target" pnpm exec tauri build --bundles app --config '{"bundle":{"macOS":{"signingIdentity":"-"}}}'
node scripts/sign-macos-local.mjs "$QA_DIR/target/release/bundle/macos/序程.app"
```

脚本要求应用已关闭、只接受本产品且拒绝替换团队签名；它会验证 ad-hoc 签名与 Node/PTY 探针。成功输出只证明本机临时包签名和运行时探针通过，不证明原生窗口验收、Developer ID 分发或公证。若签名中断，不要运行该副本；在新的隔离 target 重建后再试。

CI 流程定义于 `.github/workflows/desktop.yml`，分别运行测试、前端构建、sidecar 准备和 Tauri 打包。实际安装、托盘关闭、自动继续和系统权限仍需在目标系统上执行验收。

## 发布包的隐私检查

本地编译的可执行文件也可能保留编译机器的用户名和源码目录。v0.4.1 的重新打包将 Rust 构建路径映射到 `/build/user`，并在候选包内对 tmux、jemalloc 使用 `strip -S` 去掉调试信息，随后重新签名、验证真实 tmux 会话。只处理候选副本，不修改开发机安装的依赖。

以后发布前应扫描完整安装包和文档附件，确认没有构建者的个人目录、私用服务器地址、访问令牌、私钥或实际连接配置。Rust 的 `--remap-path-prefix` 应使用构建机实际家目录作为左侧路径；已有构建参数须保留。处理完二进制后需重新验证签名、运行时依赖和终端，不能只检查源码文本。包内第三方依赖的测试私钥夹具也不随产品分发。

真实 Codex 测试脚本可通过 `TUIJIN_CODEX_PATH`、`TUIJIN_PYTHON_PATH` 指定本机工具；未设置时沿用插件的自动发现机制。路径、测试账号和日志放在忽略的本地目录，不写入仓库。隐私检查针对当前源码和附件；历史提交需单独审查，后续公开仓库前不能直接沿用未经清理的历史。
