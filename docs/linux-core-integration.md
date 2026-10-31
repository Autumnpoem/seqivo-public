# Ubuntu 受管终端应用接入 / Managed terminal Core integration

> **最新范围指针（LINUX1078）**：本文下方是 LINUX1075 历史记录，不应单独用于判断 Linux Codex 执行器交还的当前状态。后续同一 Core 存活期间的 Ubuntu 普通 UID 受管 Shell 交还、停止与恢复原 Shell 输入检查见[LINUX1078 执行器接入说明](linux-executor-integration.md)和[测试结果](linux-executor-test-results.json)。LINUX1078 的原生证据使用假 Codex 协议进程，不代表真实 AI provider、Core 崩溃后执行器持久恢复、Ubuntu 桌面/安装、Windows 验收或可交付安装包；没有打包、安装或部署。本历史页中早期测试数和范围仍按当时结果保留。

LINUX1075 把 Linux 原会话恢复接入了应用后端：创建受管终端、登记原进程、输入命令、关闭控制程序后由新的控制进程重新进入同一个 shell。真实 Ubuntu 测试确认 shell 的进程号、系统启动标识与启动时刻不变，私有会话记录仍只有一条。

这是后端接入完成，**尚未打包、安装或部署，也未完成 Ubuntu 桌面界面验收**。Mac 现用版、DELIVERY1074 候选和 Android 安装包保持原状。Linux 的 AI 停止确认与交还、接入任意已有会话、已结束会话核验仍未开放；普通 SSH 远程终端不受这项限制影响。

## 本次检查

| 环境与版本 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| Ubuntu 最终候选，普通账户、真实 tmux | 8 | 0 | 8 个 Mac 专属用例 |
| Mac 首轮受影响的 Core、终端管理器和写入者检查 | 34 | 0 | 0 |
| 最终修改后的 Mac 定向复查 | 3 | 0 | 1 个 Linux 专属用例 |

Ubuntu 实测包含跨控制进程恢复、原始进程身份被篡改时拒绝恢复、未登记的会话不能接管，以及交还结果保持“无法确认”、AI 不能启动。代码仅允许受管模式使用这条 Linux 路径；用另一种“接入已有会话”入口选择同一个已登记会话也会被拒绝。

写入者检查只确认当前用户可见的项目文件占用，不宣称所有后台进程已停止。原 shell 的后代及精确登记的基础进程可被识别；同一监督进程下的其他子进程、转发进程的子进程不会因此获权。进程出生信息、父子关系、当前写入者或原 pane 变化时拒绝确认。检查最多覆盖 128 个选定进程、每条祖先链 32 层，每次调用现有身份工具最多 8 个进程。

独立审查发现的两处问题均先复现再修复：一是祖先授权范围过宽，二是 Linux 已登记会话可绕入不支持的控制模式。初始失败、修复后的原生结果、文件哈希和未验证项保存在[测试记录](linux-core-test-results.json)。所有临时测试目录已清理；没有调用真实 AI、修改正式服务或防火墙，也没有更改用户任务的人工验收。

下一步是把这批源码纳入统一安装包，完成 Ubuntu 界面与安装测试，再单独实现 AI 停止及交还证明。Windows 原生 Shell 与 WSL tmux 仍需独立实现和验证。

## English

LINUX1075 connects Linux managed-session creation, registration, input and recovery to the application Core. An unprivileged Ubuntu test starts a real managed tmux session, closes the Core, then recovers the same shell from a separate controller process. PID, boot ID and start ticks remain unchanged, with one private record retained.

This slice is **implemented and tested, but not packaged, installed or deployed**. Ubuntu desktop UI acceptance remains pending. Linux AI stop/return proof, arbitrary existing-session takeover and retired-session proof remain unsupported. The separate general-purpose SSH terminal is unchanged.

Final Ubuntu results: 8 passed, 0 failed, 8 macOS-only skips. The initial affected macOS suite passed 34 tests; the final focused check passed 3 with 1 Linux-only skip. Negative native cases reject changed process birth and unregistered sessions, keep AI fenced after an unconfirmed return, and reject the existing-session mode even for a registered managed pane.

Writer inspection covers current-user-visible workspace writers only. It authorizes original shell ancestry and exact recorded infrastructure processes, not sibling writers or relay descendants. Identity, parentage, writer-set or original-pane changes remain unconfirmed. The inspection is bounded to 128 selected processes and 32 ancestry levels, with batches of at most 8 identities.

Both independent-review findings were reproduced before repair. See the [test record](linux-core-test-results.json) for source hashes, raw evidence and remaining gaps. Disposable fixtures were removed without changing production services, firewall settings or human acceptance. No real AI provider was invoked.
