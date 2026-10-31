# 插件子进程边界

`createIsolatedPlugin({entry,manifest,context,dataDir,pluginDir})` 将一个本地插件装入独立 Node 子进程。宿主与子进程经专用 stdin/stdout 交换单行 JSON RPC；插件的 `console` 输出转到 stderr，且不会回传到公开状态。单条消息最多 1 MB；初始化、常规方法和执行方法分别有时限。崩溃、无效协议帧或超时会将实例标为不可用。`createSession`、`resume`、`pause` 的结果在断线后标为未知，宿主不会自动重发。

插件可请求的宿主回调只有 `getTask`、`getProject`、`updateTask`、`authorizeExecution`、`emit`。读取需要清单中 `task.read`／`tasks.read`／执行相关权限；更新需要 `task.write`／`tasks.write`／`task.resume`／`task.pause`。只有通用写权限可修改任务内容；执行相关权限只能提交 `status` 和 `blockedReason`，核心继续检查任务修订与状态。`authorizeExecution({taskId,commandId})` 仅供声明 `task.resume` 的插件在持久化命令后、真正发送前调用；回调抛错或返回 `maySend: false` 时不能发送。Codex 插件的会话创建需要通用写权限来绑定用户指定任务；`thread.create` 声明允许插件侧创建会话，但不会单独扩大核心写权限。所有回调错误保留 `status` 和 `code`。

`close()` 先等待插件自身关闭，再停止并确认子进程退出。Codex 插件必须由自身 `close()` 确认其另建进程组中的 app-server 子进程已停止；无法确认时抛错，核心不应把数据目录锁当作安全关闭后释放。若工作进程先崩溃或 RPC 超时，无法证明脱离工作进程组的子孙进程已清理，后续 `close()` 会明确报 `SHUTDOWN_UNCONFIRMED`。Windows 使用 `taskkill /T /F` 确认进程树；其他平台对工作进程组执行有界终止。执行期间超时也会停止工作进程，外部动作仍按未知结果处理。

这是崩溃与故障隔离，**不是恶意代码的操作系统沙箱**。本地可信插件的 Node 代码仍可能直接使用文件系统和网络；清单权限只限制正常 RPC 回调，不能约束任意 Node API。不要安装来源不明的插件，也不要把此机制宣传为任意第三方插件的权限隔离。
