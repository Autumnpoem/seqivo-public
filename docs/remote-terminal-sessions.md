# tmux 会话列表与默认连接

状态：**本机 A/B 默认与切换、程序保留、只读及明确授权写入已有局部测试，完整功能未验收**。2026-10-17 根据用户补充细化 P1-06；原有会话可写接入已有实现，最新恢复与跨设备偏好、最终安装包和手机完整流程仍待验证。本文是功能约定，不代表已正式交付远程 Shell。依赖 P1-02 的真实 PTY、P1-03 的执行协调和 P1-04 的授权通道。

全项目顺序见[待实现与待验证工作计划](remaining-work-plan.md)；终端模块边界、验收和三系统路线见[远程 Shell 与 tmux 实施计划](remote-shell-implementation-plan.md)。

## 用户看到的流程

首次连接已授权的电脑且尚未设置默认时，先显示列表，由用户选择一个现有 tmux 会话并设为默认，再进入终端。以后每次主动连接这台电脑，直接进入默认会话，无需手输 `tmux ls` 或 attach 命令。这里的“连接”指进入远程终端，不是账号登录或后台看板同步。

终端底部常驻紧凑入口，例如 `会话：开发主线 ▾`。点开后以抽屉列出已授权的真实存活会话，标明名称、当前会话、默认星标和是否已有客户端连接。点击一行切换当前画面；独立的“设为默认”操作决定下次连接的目标。抽屉可滚动，键盘弹出时仍可访问，不占用主要终端阅读空间。

| 场景 | 约定行为 |
| --- | --- |
| 主动新连接或断开后重新连接 | 自动进入已保存的默认会话。默认选择按账号、目标电脑及该电脑的终端连接配置保存，同账号的手机与桌面一致。 |
| 临时切换会话 | 只切换本次查看目标；不会悄悄改变默认，也不结束旧会话或重启其中的程序。 |
| 短暂断网、切后台后自动恢复同一次连接 | 仅在终端连接标识、授权及 server/会话身份仍有效时恢复当前会话；否则提示重新选择。不突然切回默认，不自动重发输入。主动新连接仍进入默认。 |
| 默认会话已结束、被删除或不再授权 | 明确提示并展开会话列表，等待重新选择；不随机选择其他会话，也不按同名偷偷创建替代会话。 |
| 尚无会话 | 显示空状态，提供“新建会话并设为默认”；用户确认后创建。未安装 tmux 时说明依赖，不显示假会话。 |
| 会话列表变化 | 展开时读取最新状态，连接期间更新；切换前再次检查目标存在和权限，失败不把输入送到其他会话。 |

这里的“会话”是 tmux session。会话中已有的 CLI/AI 程序继续保留；切换 tmux 不等于创建或切换应用内的 AI 聊天记录。普通聊天也不会因此自动迁移进 tmux。

只读查看与可写操作分别验收：只读附着允许查看已有会话，不能输入或新建；可写接入精确授权选中的会话，新增目标需明确扩展并重新核验。受管项目的输入须取得经核验的执行权；未知写入者会阻止接管。用户原有 CLI 的完整使用验收列为 P1-TMUX-EXISTING，不能为完成接管而重建或杀掉用户希望保留的程序。

## 实现约束

- 电脑端读取指定普通系统账号、已授权 tmux server/socket 的会话；保留用户现有会话，远程端只显示授权范围。先列出实际会话，再附着或切换本次客户端，不能强制踢掉其他客户端。
- 使用 tmux 的结构化格式和参数数组调用，不把显示名称拼进 shell 命令。活动目标绑定电脑、server 实例和会话 ID；名称用于显示。server 重启后不能把复用 ID 或同名会话当成原会话，须重新确认默认映射。
- 默认选择属于应用偏好，不能靠 tmux 自行挑选“最近使用”的会话代替。当前查看目标与默认目标分别保存。
- 查看、写入及接管权限分开。切换、设为默认、断开客户端都不代表旧工作区中的进程已停止；恢复 AI 写入前仍须核对实际进程和执行权。其他本地 tmux 客户端可能写入，不能声称仅靠应用锁就实现了系统级独占。
- tmux 会话并不以项目目录为安全边界；要限制文件范围，须依赖普通账号权限或隔离环境。会话列表、输出和输入通过已有账号授权及加密通道传递，不公开电脑 SSH 端口。
- 手机掉线可以保留电脑上的 tmux 进程；电脑重启后的进程恢复是另一项能力，不在此功能内承诺。

命令能力依据：[tmux 官方手册](https://man.openbsd.org/tmux)中的 `list-sessions`、`attach-session` 与 `switch-client`。实际版本兼容性仍须在目标电脑验证。

## 完整验收清单（局部已有证据，整项尚未通过）

下面每项包含多个条件。已有真实运行时及早期界面测试可复用对应证据，但最新接管改动后需要回归，跨设备和真机结论不能由局部结果代替。

1. 真实创建 A、B 两个可丢弃 tmux 会话；列表与电脑的 `tmux ls` 在授权范围内一致，当前与默认标记正确。
2. 默认 A：主动连接自动打开 A，手动切到 B，主动断开再连接仍进入 A；把 B 设为默认后，新连接进入 B，同账号另一设备一致。
3. B 中运行交互式程序，切换到 A 再回来：输出、程序及输入位置保留，不重启、不重复执行，不强制断开其他客户端。
4. 在非默认会话断网/锁屏再恢复：接回当前会话，不重发输入；主动新连接则进入默认。
5. 默认会话被删除、server 重启、权限撤销、空列表及缺失 tmux 分别给出明确状态；不误连其他会话或复用同名目标。
6. 特殊字符名称、并发切换、切换途中目标退出、两端同时连接，以及 AI/人工争用时，目标和权限正确；接管不能仅凭 tmux detach 或锁过期判定停止。
7. Mac 与 iPhone/Android 实机验证底部抽屉、长列表、软键盘和大字号；Windows 的执行环境与 Ubuntu 原生适配单独验证。

## English

**Partially integrated, with local A/B switching, read-only attachment and explicitly authorized writable adoption evidence; not accepted as a complete feature.** Adapter, UI, transport and takeover paths exist in the working tree. Writable adoption now has targeted local tests; final recovery integration, cross-device preferences, the packaged UI and physical mobile behavior still need validation. Read-only attachment does not grant input or task-control rights. P1-06 adds a bottom tmux session picker on top of the PTY, permission and takeover components. The first connection lets the user choose an existing authorized session as default. Every fresh connection attaches that default automatically. Tapping another session changes only the current view; “Set as default” separately updates the account/computer/terminal-profile preference across devices.

The first connection without a default opens the picker before attaching. “Connection” here means entering the remote terminal, not account login or background board sync. Transient recovery restores the current session only while the terminal connection, authorization and server/session identity remain valid, without replaying input; otherwise it requires selection again. A deliberate fresh connection opens the default. A missing, recreated or unauthorized default requires a new selection, never a silent substitute. Empty lists offer explicit creation; missing tmux is reported. Switching preserves existing processes and does not forcibly detach other clients. tmux sessions and application AI chats remain distinct.

Implementation must bind targets to the computer, server instance and session identity, avoid shell interpolation, and check permissions on every attach/switch. Disconnecting or switching is not proof that processes stopped; takeover must retain the existing real-process checks. A project directory is not a sandbox. Machine reboot recovery is outside this feature. None of the seven multi-condition acceptance cases above is complete; reuse applicable component evidence and record the remaining current-version and physical-device checks separately.
