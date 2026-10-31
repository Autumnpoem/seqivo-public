# Completed conversation cache / 已完成对话缓存

This change keeps a bounded, public transcript available after the task's original executor has retired. Before serving the stored transcript, the host verifies the exact task/thread/turn binding and a verified stop proof. It captures the final idle thread before retirement; a failed cache write restores the previous cache and does not prevent executor retirement. Offline history reads use the cache and do not start a new job.

The cache accepts at most 16 task entries and 4 MiB total; each transcript is limited to 700 KB. An oversized transcript drops older messages first to retain the newest answer. The global cache evicts older snapshots only when their original stop proof is verified; eviction does not change execution records. The public transcript excludes private reasoning and sanitizes local paths.

The snapshot test file covers exact binding, final-idle status, stop-proof requirements, size/count limits, newest-answer retention, cache eviction, and malformed restored data. The independent host and pure suites each passed 6/6 with no skips. Their process-retirement proof is mocked: this does not establish production OS retirement or a real provider run.

**Independent review:** REVIEW533 closed the cache-capacity finding and found no new confirmed P1/P2 issues in the reviewed scope.

**APP541 scoped result:** On source `2e9a0a76f9c890ef01ca5dd92a6e7065aa3b871c`, one real first turn completed on the ordinary v10 Android candidate. Its exact 15-byte file was verified, and the final reply appeared in both the Android UI and Mac QA window. The send was not replayed. A normal Core close completed in 56 ms; seven recorded QA app processes were absent afterward while the Hub intentionally remained live. The same-data Mac reopen showed the final reply without a new command. Android force-stop and cold restart preserved login and reopened the original conversation; the reply remained visible with no new commands. Cache and file stayed unchanged. Task acceptance remains unverified.

Before the UI quit, eight QA/controller process identities were captured. Native before/after comparison independently confirmed the seven original QA app/Core process births were gone. Only the production app's exact-birth continuity is unverified because its comparison baseline was captured after quit; do not infer that continuity from the checker exit code. APP531's earlier failure remains historical evidence.

**Still to verify:** Native close/reopen during an active AI task or busy terminal, a second turn and the remaining app flow. This idle one-turn result does not prove human acceptance, a complete handoff, or production release.

中文：此改动在原任务执行器退出后保留有界的公开对话记录。读取前会再次核对任务、会话、轮次绑定和已验证的停止证明；最终闲置对话在执行器退出前采集。缓存写入失败会恢复旧缓存，但不会阻止执行器退出。离线读取历史不会启动新任务。

缓存最多保留 16 个任务、总计 4 MiB；每份记录最多 700 KB。单份记录超限时先删较旧消息，保留最新完成答复；总缓存超限时只淘汰停止证明已验证的旧记录，不改变执行记录。公开记录会排除私有推理并清理本机路径。

快照测试文件覆盖绑定核对、最终闲置状态、停止证明、大小与数量上限、保留最新答复、缓存淘汰及损坏恢复数据。独立宿主测试和纯逻辑测试各 6/6 通过、无跳过；进程退出证明使用模拟对象，并非生产操作系统进程验收或真实模型运行。

**独立审查：** REVIEW533 确认缓存容量问题已关闭，限定范围内未发现新的已证实 P1/P2。

**APP541 限定结果：** 源码 `2e9a0a76f9c890ef01ca5dd92a6e7065aa3b871c` 对应的普通 v10 Android 候选完成一次真实首轮；精确的 15 字节文件已核实，最终答复在 Android UI 和 Mac QA 窗口均可见，且没有重发。正常 Core 关闭在 56 ms 完成，记录的 7 个 QA 应用进程随后消失，Hub 按计划保持运行。同数据 Mac 重开后可见最终答复且没有新命令；Android force-stop 后冷启动保留登录并打开原对话，答复仍可见、没有新命令，缓存与文件未变。任务人工验收仍未验证。

UI 退出前采集了 8 个 QA/控制器进程身份；原生前后比对独立确认原 7 个 QA 应用/Core 进程出生身份已消失。只有正式应用的精确出生身份连续性未验证，因为其对照基线是在退出后采集；不能从核对器退出码推断该连续性。APP531 失败仍作为历史保留。

**仍待验证：** 活动 AI 或忙终端下的原生退出与重开、第二轮及其余 App 流程。本次空闲单轮结果不证明人工验收、完整交接或正式发布。
