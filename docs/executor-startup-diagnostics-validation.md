# Executor startup diagnostics validation

## 中文

这项本机诊断记录用于排查受管执行器启动身份核验，不参与放行、拒绝或执行决策，也不进入任务状态、插件 RPC 或远程 API。记录只接受固定阶段、检查阶段、结果和原因枚举；任务记录 ID 只保存截短的 SHA-256。诊断目录权限为 `0700`，文件为 `0600`，当前与轮换文件各不超过 64 KiB。写入失败会被忽略，不会改变原核验结果，也不能把拒绝改为放行。

验证结果：纯单元测试 17/17、无跳过；真实 macOS Core→worker→launchd→fake 协议会话创建 1/1、无跳过，session `created`、只启动一个 thread、未请求 model turn。另一次真实 Codex 启动只创建一个 session，未请求 model turn。后两次会话验证均观察到四个核验阶段成功；独立只读退休复核确认原执行器已退出且正式应用进程仍在，清理错误为空。REVIEW492 与修正夹具清理后的 REVIEW494 独立审查均未发现已证实 P1/P2。

**限制：**实际 Codex 结果只证明这次 session 创建和启动身份诊断，不解释或追溯解决既有 Android 启动失败原因；未覆盖真实模型 turn、Android App、忙任务暂停或 GUI 退出。较早于 observer 的启动异常也不在这组阶段记录范围内。诊断是本机私有排障资料，不是产品能力或远端状态接口。

## English

These local diagnostics help investigate managed-executor startup identity checks. They do not authorize, reject, or execute work and are not included in task state, plugin RPC, or remote APIs. Records accept only fixed phase, stage, result, and reason enums; task record IDs are stored only as truncated SHA-256 values. The directory is mode `0700`, each file is `0600`, and the current and rotated files are each capped at 64 KiB. Write failures are ignored and cannot change the underlying verification result or turn a refusal into admission.

Results: pure unit tests passed 17/17 with no skips; a real macOS Core→worker→launchd→fake-protocol session-creation test passed 1/1 with no skips (`created`, one thread start, no model turn requested); a separate real Codex startup created one session and requested no model turn. The two session runs each observed four successful verification phases. A separate read-only retirement check confirmed the original executor was gone while the regular app process remained; cleanup errors were empty. Independent reviews REVIEW492 and, after the fixture-cleanup correction, REVIEW494 found no confirmed P1/P2.

**Limits:** the real-Codex result validates only this session creation and startup diagnostic path. It does not explain or retroactively resolve the earlier Android startup failure, and does not cover a real model turn, the Android app, pausing a busy task, or GUI exit. Startup failures that occur before the observer are outside these phase records. These are private local diagnostic data, not a product feature or remote status API.

See the [machine-readable test results](executor-startup-diagnostics-test-results.json).
