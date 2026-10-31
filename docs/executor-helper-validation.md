# Native helper failure classification

## Current follow-up / 当前进展 (2026-10-21)

APP531 used source revision `71ab8de`; the same-source QA530 Mac-local ad-hoc app and ordinary v9 APK built, and Android v8→v9 `install-r` completed without clearing app data. The only UI session creation occurred in the Mac QA window. After two stable confirmation and revalidation checks each, `verify.first` stopped at `coalition_count_changed` after one sample (51 ms); no model turn, command, file, or final reply was produced. Android received no login or conversation operation in this run.

IMPL537 narrows retries to three fixed scan-churn reasons, within four samples/two seconds, while retaining seen process identities across invalid samples. Other failures remain fail-closed. Root's native host regression passed 17/17 with no skips and exit 0, including `/bin/cat` and verified retirement; REVIEW538 found no new confirmed P1/P2. This test scope does not establish an actual app/provider run. The app retest and final-reply check remain pending.

APP531's later menu-quit observation showed a UI exit code of 0, but plugins rejected shutdown after 33 ms and Core reported rejection after 37 ms; the user-facing result was unknown. Two read-only cohort observations later found count zero while the stop intent and host marker remained unchanged. Hub shutdown and process disappearance were observed, but this is not evidence of a normal Core close or a reopen check of the original app data. Native app/helper revalidation remains pending.

APP531 使用源码版本 `71ab8de`；同源码 QA530 本机 ad-hoc 应用及普通 v9 APK 构建成功，Android v8→v9 `install-r` 未清除数据。本轮只有 Mac QA 窗口创建过会话；此前 confirm 与 revalidate 各有两次稳定检查，之后 `verify.first` 在一次采样、51 ms 时因 `coalition_count_changed` 停止。没有模型回合、命令、文件或最终答复；Android 未登录或操作对话。

IMPL537 将重试限定为三种固定的进程扫描变化原因，最多四次采样、两秒，并在无效样本间保留已见进程身份；其他失败仍按拒绝处理。Root 原生宿主回归 17/17、零跳过、退出码 0，包含 `/bin/cat` 与已验证的退休流程；REVIEW538 未发现新的已确认 P1/P2。该范围不证明真实应用/提供方链路通过；App 复测及最终答复检查仍待完成。

APP531 后续菜单退出观察中，界面退出码为 0，但插件在 33 ms 后、Core 在 37 ms 后拒绝关闭，用户看到的结果为未知。两次只读 cohort 观察均为 0，stop intent 和 host marker 字节未变；随后 Hub 关闭、相关进程消失。这不等于 Core 正常关闭，也没有核验原应用数据重开。原生 App/helper 复验仍待完成。

## Earlier failure-classification evidence (historical) / 早期失败分类证据（历史）

Mac 原生进程核对工具会在失败时返回固定原因并以退出码 2 结束。此前宿主把这类正常的拒绝回执和启动失败一并显示为 `helper_unavailable`。当时的修复仅在退出码、信号状态和失败回执格式都符合要求时保留白名单原因；未知内容、超时、信号中断或伪造的成功形状仍拒绝，不输出原始 stderr、路径或参数。

那次变更只修正失败原因的传递，测试的三次重采规则适用于当时覆盖的情况。APP512 当时的原始失败信息没有保存，不能据此还原其原因。当前重试边界见本页顶部。

限定验证：

- `tests/executor-helper-reply.test.mjs`：5/5，包括真实 Node 子进程退出码 2 的异常形状、两种兼容原因的最多三次重采、错误内容和中断时拒绝。
- `tests/executor-startup-cohort.test.mjs`：13/13 通过；独立的原生 `/bin/cat` 可选用例未启用。
- `tests/executor-startup-diagnostics-native.test.mjs`：Mac 原生 Core 与假提供方 1/1，创建一次会话、没有模型回合，正常退休与关闭通过。
- 合计 19 通过、1 跳过；独立审查未发现新的已证实 P1/P2。真实 AI 两轮交接仍待复测。

## Earlier failure-classification evidence (historical) / 早期失败分类证据（历史）

The macOS process helper returns a fixed failure reason with exit code 2. The host previously folded that reply into `helper_unavailable`. That earlier fix preserved only an allowlisted, strictly shaped failure from an unsignalled exit 2. Unknown content, timeouts, signals and success-shaped failures remained rejected; raw stderr, paths and arguments were not exposed.

That change preserved failure information, not permission to run; its three-attempt rule applied to the cases covered then. APP512's original error was not retained, so its cause remains unknown. Current retry boundaries are described at the top of this page.

Validation: 5 helper-reply tests, 13 cohort tests and one macOS Core/fake-provider integration test passed. One separate native `/bin/cat` opt-in test was skipped. The integration created a session without a model turn and completed normal retirement/close. Independent review found no newly confirmed P1/P2 issues; real-AI two-turn handoff remains unverified on this version.
