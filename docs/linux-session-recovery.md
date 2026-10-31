# Ubuntu 原终端会话恢复 / Original terminal recovery

> **最新范围指针（LINUX1078）**：本文以下内容记录 LINUX1073 底层 tmux/身份恢复历史；后续应用接入和当前剩余范围见[LINUX1075 Core 接入历史](linux-core-integration.md)，最新 Linux Codex 执行器与原受管 Shell 交还的窄范围结果见[LINUX1078 执行器接入说明](linux-executor-integration.md)和[测试结果](linux-executor-test-results.json)。LINUX1078 验证的是同一 Core 存活期间的受控停止/恢复闭环，不是 Core 崩溃后的执行器持久恢复，也不覆盖真实 AI provider、Ubuntu 桌面/安装、Windows 或打包安装部署。

最新进展：LINUX1075 已接通 Core 的受管会话创建、注册与跨控制进程重连，并通过真实 Ubuntu 检查。以下保留 LINUX1073 底层实现记录；当前范围和剩余事项见[应用后端接入](linux-core-integration.md)。

LINUX1073 已打通底层受管 tmux 会话的准备、一次性启动、持久记录、重新连接和身份核对。普通账户的真实 Ubuntu 测试确认：新的控制进程能恢复原 shell 与 tmux pane，恢复输入后只写入一次测试文件；再次启动同一记录会被拒绝。这批代码尚未安装到桌面版或部署到服务。

Linux 使用独立的进程身份，包含系统启动 UUID、进程启动时的原始计时值、用户与进程组。每次读取同一进程目录的 stat/status/stat，再进行第二次完整观察；进程消失、身份改变或读取不完整时仍显示无法确认。计时值以字符串保存，避免整数精度丢失。内核字段定义见 [proc_pid_stat(5)](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html)、[proc_pid_status(5)](https://man7.org/linux/man-pages/man5/proc_pid_status.5.html) 与 [boot_id 文档](https://docs.kernel.org/admin-guide/sysctl/kernel.html)。

Linux 私有记录为 v2；Mac 原有 v1 记录格式保留。两种记录不能混用。重连仍须核对原进程、原 tmux 实例与 pane，以及私有连接凭据。重新连接先冻结输入，确认后才恢复；输出缺口继续单独报告。

实测同时修复了 `LC_ALL=C` 下 tmux 将列表分隔符替换为下划线的问题。会话与 pane 的元数据查询现在明确使用 UTF-8 输出，保留分隔符和中文目录。tmux 的非 UTF-8 输出处理见 [官方源码](https://github.com/tmux/tmux/blob/3.2a/cmd-queue.c#L764-L773)。

| 检查环境 | 通过 | 失败 | 按平台跳过 |
| --- | ---: | ---: | ---: |
| macOS，真实隔离 tmux | 14 | 0 | 3 个 Linux 用例 |
| Ubuntu 22.04 x86_64，普通账户，tmux 3.2a | 13 | 0 | 4 个 Mac 用例 |

测试包括身份变化与缺失、跨平台记录拒绝、一次性启动、跨控制进程重连、实际写入及中文路径。原始失败、修复和最终结果均列在[测试记录](linux-session-test-results.json)。测试目录已清理，正式服务、用户会话和防火墙未改变。

**还未完成：** 全进程及 AI 停止核验、Ubuntu 桌面界面、安装与升级。Linux 会话注册和 Core 重连随后在 LINUX1075 完成；仍不能把后端恢复通过当成完整人工接管或三系统适配完成。

## English

LINUX1073 implements the low-level managed tmux record lifecycle on Linux: prepare, one-shot start, durable identity, reconnect and verification. An unprivileged Ubuntu test recovers the original shell and tmux pane from a separate controller process, resumes input and confirms exactly one marker write. A repeated start is rejected. This code has not been installed or deployed.

Linux v2 records use a boot UUID and the original uint64 process start ticks as a decimal string, plus UID and process-group identity. Two complete observations must agree. Missing, changed or incomplete identities remain unverified. Existing macOS v1 records remain compatible on macOS; records cannot cross platforms. Reconnection also checks the original tmux instance, pane and private capability, initially freezes input, and continues to report output gaps.

Native testing exposed C-locale tmux output sanitization. Metadata queries now explicitly request UTF-8 output to preserve tab separators and Unicode paths. Final targeted results: macOS 14 passed / 3 Linux-only skips; Ubuntu 22.04 x86_64, unprivileged account, tmux 3.2a: 13 passed / 4 Mac-only skips. Disposable fixtures were removed; production services, user sessions and firewall settings were unchanged.

LINUX1075 subsequently completes the bounded Registry/Core integration; see [Core integration](linux-core-integration.md). UI, full process inventory, AI stop proof and Ubuntu desktop installation/update remain pending. This result does not establish complete Linux takeover or Windows support. See the [historical low-level test record](linux-session-test-results.json).
