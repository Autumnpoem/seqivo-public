# 远程操作结果核实

手机提交修改后，如果电脑没有返回明确结果，序程会保留这次操作，在「需要我处理」中显示「结果待核实」。任务详情和对话页也可显示对应的核实入口。

点击 **核实这次操作**，电脑只检查原操作留下的记录。它不会重新发送指令、再次修改文件，也不会新建另一条对话。

| 核实结果 | 含义 | 接下来怎么做 |
| --- | --- | --- |
| 已找到执行记录 | 电脑保存了这次操作的明确回执 | 查看最新任务、输出和证据；执行过不等于已经完成或验收通过 |
| 确认没有执行 | 记录证明原操作未派发，或验收因条件不足已完整回滚 | 查看具体原因，补齐条件后自行决定是否重新提交；不会自动重试 |
| 仍无法确定 | 记录不足以证明执行了什么 | 保留限制，在项目电脑检查任务、会话和文件；不要用另一个设备重复提交 |

核实需要原项目电脑在线，并保留有效的项目授权。只有原操作者或空间拥有者可以请求核实。退出账号、失去权限或网络中断后，原操作编号仍保留；恢复原账号后继续查询，不会转给另一个账号处理。

同一任务的未决操作会阻止另一台设备提交新的修改。未确认的新建对话还会阻止该项目再次新建对话。暂停入口单独处理；暂停成功后，之前结果不明的操作仍保留未知与限制。收到暂停回执并不证明所有系统子进程都已停止，不能据此开放终端接管。

## 任务更新后重新核对

编辑、添加证据或验收的弹窗打开后，如果任务或账号发生变化，旧草稿会保留，但不能提交。请关闭弹窗，查看当前交付和证据，再重新打开；程序不会把旧说明自动套到新版本。

## 当前边界

缺少当前版本证据、没有验收标准、尚未提交成果或仍有交付偏差时，验收会明确说明需要补什么。只有电脑确认这次拒绝没有保存验收结论，才允许继续处理；“结果未知”仍保留限制。旧版本丢失原因的未知记录不会凭当前任务状态自动解锁。

电脑在操作生效后、写下明确回执前崩溃，或原电脑丢失、被撤销授权时，结果可能继续未知。系统不会把“找不到记录”“会话空闲”或人工点击按钮当作未执行的证明。旧版本缺少充分记录的操作也可能无法自动核实。

本功能不包含强制清除未知状态、自动重发，也不替代人工验收。剩余实机验证范围见[验证记录](inbox-validation.md)。

---

# Check a remote operation

If a phone submission has no confirmed result, Seqivo keeps its original operation ID and shows an **Outcome unknown** item in the inbox. Task details and conversations can also offer the check action.

Checking asks the original computer to read its saved receipt. It never resends the instruction, edits files again, or creates a second conversation.

| Result | Meaning | Next step |
| --- | --- | --- |
| Execution record found | The computer retained a confirmed receipt for this operation | Inspect the updated task, output and evidence. Execution does not imply completion or acceptance |
| Confirmed not executed | Durable records prove the operation was not dispatched, or a rejected review was fully rolled back | Read the reason, satisfy the prerequisites and decide whether to submit again; no automatic retry |
| Still unknown | The available records cannot establish the outcome | Keep the restriction and inspect the original computer; do not repeat the operation from another device |

The original computer and its project authorization must remain available. Only the original sender or workspace owner can request a check. Account changes and connectivity failures retain the original scoped ID. Unresolved task writes block new writes from other devices; unresolved conversation creation blocks another creation in the same project.

Missing current-version evidence, missing acceptance criteria, unsubmitted work or unresolved delivery issues produce a specific review rejection. Further work is allowed only after the computer confirms that no acceptance decision was saved. Unknown historical operations without that proof remain restricted.

A crash between the actual change and saving its receipt, missing historical records, or loss of the original computer can leave the result unknown. A missing record, an idle conversation, or a manual acknowledgment is not proof that nothing executed. A successful pause leaves previously unknown operations fenced and unknown. A pause receipt does not prove that all operating-system child processes have stopped and does not authorize terminal takeover.

If a task or account changes while an edit, evidence or review dialog is open, the draft remains visible but cannot be submitted. Close it, inspect the current delivery and evidence, then reopen. Old notes are never silently applied to the new version.

There is no forced unlock, automatic replay, or automatic acceptance. See the [validation record](inbox-validation.md) for remaining physical-device checks.
