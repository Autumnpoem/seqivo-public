# 执行前状态核验 / Execution-write validation

## 当前范围

候选代码将 Core 的只读执行状态暴露为按项目/任务绑定的短时门控。Hub 投影校验字段并在接受新消息、继续任务或新对话前检查授权、快照新鲜度、任务版本和门控状态；界面在提交前再次读取状态。缺字段、过期、未知或阻止状态均不允许新提交。明确拒绝保留草稿；结果不确定时继续核对同一个命令 ID，不自动重发。

The candidate exposes a read-only, short-lived execution gate bound to the project/task. The Hub validates the projected gate and checks authorization, snapshot freshness, task version and gate state before accepting a new message, continuation or conversation. The UI reads state again before posting. Missing, stale, unknown or blocked state prevents a new write. A definite rejection retains the draft; an uncertain result is checked against the same command ID and is not resent automatically.

## 已完成的限定验证

- 候选源码：`d656fe5d1a1f64d6ea02ea67e66e2b4a86be1475`。Core/Hub 定向门控与旧策略回归、独立代码审查通过，范围见[机器结果](execution-write-test-results.json)。
- 实际 React 界面在合成 API 场景验证了 unknown/过期阻止提交、409 保留草稿、读取期间切换目标不产生 POST；没有 provider 调用。UI759 另补两项固定延迟场景：切换项目后不误发且保留草稿；退出 A 并登录 B 后，迟到的 A 响应不覆盖 B，也不带入 A 的草稿。一次明确提交的对照仅产生一个 409，未自动重试；首个手动等待超时的尝试单列为无结论。上述场景不是 Core/Hub 集成或 Android 原生验收。
- 旧 d656fe5 首启停滞和 75 秒退出 unknown、以及 PACKAGE751 首次 ⌘Q/Core close 失败均作为历史保留；RECOVERY776 在备份后中断，数据未变但锁保留，不是正常退出。DELIVERY780 随后将 e22946ad 安装到原应用位置，数据未变。NATIVE785 首次启动 ready，原看板的 2 个项目和 62 个任务行（忽略临时执行门控字段）保持一致并观察到 62 个新鲜门控；正常 ⌘Q 后 App 退出、6 个观察进程消失、锁不存在，Core/file bridge 在 33 ms 完成且未强制杀进程；新 boot 同数据重开成功。该范围为空闲退出/重开，不覆盖活动 AI 或终端。首次空会话测试在保留候选中生成 4 个 Python bytecode 文件；精确缓存已隔离，清单/签名恢复，后续隔离测试禁用了 bytecode 写入。DELIVERY784 随后将 e22946ad 部署至 Hub，执行与部署后检查均 exit 0，144 个运行文件核对通过，既有身份保持。Android APP782 当前已完成首轮、人工接管、一次实际文件追加、现场核对及显式交还；第二轮只提交一次后以 `command_approval` 停止，业务结果 unknown、无最终答复且 stop proof 未核实；不重发。APP737 的空会话退出和 TCC 请求链尝试是历史，不代表 APP782 当前状态。
- 单独的 headless 两轮执行诊断完成且无活动租约，但没有复现审批流程；它不能清除 APP682 既有的第二轮 unknown。此前 `3ce4686` 上的空闲退出/重开（RECOVERY742）和 PACKAGE751 的中断均是独立历史。BUILD771 的源码与包内 worker 测试、e22946ad 空闲原生启动/退出/重开已限定通过；这不解释 PACKAGE751 早先 file-bridge/scandir 问题，也不代表活动 AI/终端退出或交还通过。

## 尚未通过

兼容的 Core 与 Hub 门控已随 e22946ad 部署；DELIVERY784 的部署后检查和 144 个运行文件核对通过。NATIVE785 的空闲首次启动、正常 ⌘Q/Core 关闭及新 boot 同数据重开限定通过；PACKAGE751/RECOVERY776 的失败保留为历史。APP782 已在普通 v13 模拟器完成首轮和人工文件修改/显式交还；一次第二轮请求已提交后以 `command_approval` 停止，结果 unknown、无最终答复且 stop proof 未核实；不重发。活动 AI/终端退出、暂停/恢复组合和正式分发仍待验。UI759 的账号/跨项目场景是合成 API 检查，不替代原生客户端的组合验证。APP682 的 unknown 保持原样、不重放；人工验收与整体 M3 均未完成。

上述局部结果不改变权限，也不是同步锁或离线授权；门控的新鲜度窗口不能代替 Core 最终执行检查。较旧 Hub 不提供此 DTO 时必须拒绝新写入，直到兼容服务可用。
