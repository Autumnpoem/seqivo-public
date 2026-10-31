# Bridge thread-read budget

## 中文

插件读取对话线程时，分页和兼容回退共用一次总预算：`min(配置的 RPC 超时, 8 秒)`。桥接在发送前、同步写入/flush 后、收到回包后及返回前检查剩余时间；同步写入和 flush 本身不可中断。超时只拒绝本次只读请求，不重发，也不单独停止任务。宿主原有 12 秒请求看门狗仍保留，若它先触发，仍会停止作业并留下 unknown 结果。

本机诊断只记录固定事件/原因/方法枚举、时间、哈希标识和限幅后的超时值。它是尽力记录，不参与授权或执行结果判断，也不进入公开 DTO。记录目录为 `0700`，最多两个轮换文件、每个不超过 `64 KiB`，文件为 `0600`；写入失败不会改变控制流程。

**限定验证（源码提交 `160f7672d7c909294514ae3a5aa6b4ceead2a222`）：**

- `tests/bridge-read-budget.test.mjs`：1/1 测试通过，覆盖 8 个内存场景，包括分页/回退共享预算、flush 耗时计入预算、超时后的迟到响应隔离。
- `tests/bridge-lifecycle-diagnostics.test.mjs`：4/4 通过，覆盖诊断记录的事件限制、边界和隐私约束。
- `tests/bridge-background-terminals.test.mjs` 与 `tests/plugin-group-shutdown.test.mjs`：合计 5/5 通过，真实 Python 桥接、假 provider、后台终端及进程组关闭回归。
- 分页协议定向回归：1/1 通过。
- REVIEW514 指出的 flush 后仍使用旧预算问题已修正，并以原红例/新绿例核对；最终独立审查已完成，未发现新的已证实 P1/P2。

这些结果不重新验证 APP496，也不能解释其第二轮或暂停为何为 unknown；第二轮首因仍未知。本改动没有通过真实 AI 复验，不能视为 M3、Mac 退出或完整应用验收通过。

## English

Thread reads share one overall budget across pagination and compatibility fallback: `min(configured RPC timeout, 8 seconds)`. The bridge checks the deadline before sending, after synchronous write/flush, after receiving a reply, and before returning. The synchronous write/flush itself cannot be interrupted. A timeout rejects only that read; it does not resend or independently stop the task. The host's existing 12-second request watchdog remains active and may still stop the job, leaving an unknown result.

Local diagnostics record only fixed event/reason/method enums, timestamps, hashed identifiers, and a capped timeout value. They are best-effort observations, not execution authority, and are not exposed in public DTOs. The directory is mode `0700`; at most two rotated files are kept, each capped at `64 KiB`, with files mode `0600`. A logging failure does not change control flow.

**Limited verification (source commit `160f7672d7c909294514ae3a5aa6b4ceead2a222`):**

- `tests/bridge-read-budget.test.mjs`: 1/1 test passed, covering eight in-memory cases including shared pagination/fallback budget, flush time counted against the deadline, and isolation of late replies.
- `tests/bridge-lifecycle-diagnostics.test.mjs`: 4/4 passed for diagnostic event restrictions, bounds, and privacy constraints.
- `tests/bridge-background-terminals.test.mjs` and `tests/plugin-group-shutdown.test.mjs`: 5/5 combined passed for the real Python bridge with a fake provider, background terminal, and process-group shutdown regression.
- Targeted pagination protocol regression: 1/1 passed.
- The post-flush stale-budget issue found by REVIEW514 was fixed and checked with the prior red case and a green rerun; final independent review is complete with no newly confirmed P1/P2 findings.

These results do not revalidate APP496 or explain why its second turn or pause became unknown; the original cause remains unknown. No real-AI retest was completed, so this is not an M3, Mac-exit, or full-application acceptance pass.
