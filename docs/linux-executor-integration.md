# Ubuntu 任务停止与原终端交还 / Linux executor handoff

LINUX1078 完成了应用后端的一条交还流程：暂停原受管终端，将工作目录交给任务进程，确认任务进程停止，再选择原 tmux 会话继续输入。普通账户的真实 Ubuntu 测试已走通这条流程，恢复前后的 shell 身份相同。

测试使用真实 Core、插件进程、Python bridge、tmux 和文件写入，但 Codex 响应来自受控协议脚本，**没有调用真实 AI 服务**。该源码尚未打包、安装或部署；现用 Mac、候选安装包、Android APK 和线上服务没有因本轮改变。整体项目仍未完成。

## 已完成的范围

- Linux 进程观察记录系统启动标识、进程启动时刻和父子关系；两次完整观察不一致或读取不完整时不能确认停止。
- 插件宿主向 Core 提供实际 worker 身份；Core 自行核对 worker、bridge 与 app-server，并绑定原任务、命令、工作目录及交还代次。普通插件不能声明这项授权。
- 停止确认同时依赖 worker 内的完整任务进程检查和 Core 对原受管终端现场的核对。仅返回暂停成功不能取得人工输入权。
- 人工接管后仍须选择原会话，才恢复原 shell 输入；不会自动重放命令。
- Linux 插件工作目录与检查工具不再被误认成项目写入者。原有相对 Python/Codex 路径、环境与配置文件的查找含义保持；未修改用户保存的配置。

这条路径依赖当前 Core 与插件进程中仍然有效的身份记录。进程崩溃或重启后，不会仅凭磁盘上的旧标记宣称任务已停止。任意 SSH 主机的普通终端继续使用独立入口。

## 验证结果

| 检查 | 通过 | 失败 | 跳过 | 说明 |
| --- | ---: | ---: | ---: | --- |
| Ubuntu 最终产品的相关测试批次 | 42 | 1 | 16 | 唯一失败是新增测试在接管后未显式选择原会话；16 项按平台跳过 |
| 修正测试流程及清理后的原生闭环 | 1 | 0 | 0 | 停止、原会话选择、恢复输入和清理均通过 |
| Mac 首轮相关回归 | 38 | 0 | 2 | 具体阶段、后续定向检查与哈希见测试记录 |

两个 Ubuntu 批次的产品文件相同，只有闭环测试夹具变化；没有把分次验证写成单次 59 项全部通过。后续 Mac 相对路径发现测试、既有 bridge 打开测试各通过 1 项。

另有两项 Mac 测试在未修改的基线与候选上均失败：插件隔离测试缺少受信启动授权，以及受管 tmux 正常退出超时。这两项保留为未解决，不能算作本轮通过。独立安全复审在本轮修改范围内未发现待处理 P1/P2。

测试过程确实发现并修复了 Linux 工作目录自我占用、相对可执行路径查找和 tmux 启动目录问题。详细初始失败、最终源码哈希、分次结果及本地证据路径见[测试记录](linux-executor-test-results.json)。测试目录已清理，没有修改正式服务配置、防火墙或人工验收结论。

## 仍需完成

1. 用真实 Codex 任务验证停止与交还，覆盖实际输出、暂停和结果不明。
2. 单独实现并验证异常退出后的任务进程恢复证明；当前内存绑定不提供这项能力。
3. 纳入 Ubuntu 安装包，从桌面界面验证任务、终端和交还；继续完成安装、升级与休眠恢复。
4. 解决上述既有 Mac 测试缺口，并分别完成 Windows 原生验证。

## English

LINUX1078 implements a live-Core managed handoff on Linux: park the original terminal, admit the task executor, prove it has stopped, then explicitly select and resume the original tmux shell. An unprivileged Ubuntu test exercises real OS processes, Core/plugin IPC, Python bridge, tmux and file writes. Codex uses a controlled protocol fixture; **no real AI provider was called**.

Core independently verifies the actual worker→bridge→app-server identities and binds them to the task, command, workspace and handoff generation. Workspace retirement requires both the worker's complete executor proof and Core's original managed-pane check. Stored markers cannot recreate this live capability after a crash. Linux-only working-directory changes preserve existing executable discovery and do not rewrite saved configuration.

The final product batch recorded 42 passes, 1 fixture-flow failure and 16 platform skips. After correcting explicit session selection and fixture cleanup, the native composite passed 1/1. Product hashes are identical between these batches; this is not a single all-green 59-test run. The early affected Mac batch passed 38 with 2 skips; final discovery and existing bridge tests each passed. Two Mac failures also reproduce on the unchanged baseline and remain unresolved. Independent review found no outstanding P1/P2 within this change's scope.

This source is **not packaged, installed or deployed**. Real-provider acceptance, crash recovery proof, Ubuntu native UI/install/upgrade and Windows delivery remain pending. See the [machine-readable record](linux-executor-test-results.json) and [current delivery status](current-delivery-status.json).
