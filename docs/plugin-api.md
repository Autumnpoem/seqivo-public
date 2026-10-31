# 本地插件 API（产品 v0.2，接口版本 1）

插件放在内置 `plugins/<id>/` 或应用数据目录的 `extensions/<id>/`。启动时宿主读取 `plugin.json`，核对目录 ID、入口文件和 `apiVersion: 1`，然后把每个插件装入独立 Node 子进程。单个插件加载失败会显示为不可用，不阻止任务数据库和其他插件启动。安装、升级或回退插件后须重启应用。

```json
{
  "id": "my-extension",
  "name": "我的扩展",
  "version": "0.1.0",
  "apiVersion": 1,
  "entry": "host.mjs",
  "defaultEnabled": false,
  "permissions": ["tasks.read"],
  "capabilities": [],
  "configSchema": { "type": "object", "properties": {} }
}
```

入口模块导出 `async createPlugin(context)`。返回对象必须实现 `state()`、`configure(config)`、`enable()`、`disable()`、`check()` 和 `close()`；各方法可返回 Promise。`close()` 应停止插件自己的定时器和子进程，确认退出后才完成。执行类插件可实现 `createSession(input)`、`resume(input)`、`pause(input)`、`reconcile(input)`、`getExecution({taskId,commandId})`；自动继续插件还可实现 `setPolicy(input)`。在清单中声明相应能力，宿主才会把插件呈现为可用执行工具。`getExecution` 必须依据插件持有的命令记录及真实协议/进程状态报告结果；任务表的 `submitted` 字段本身不能证明外部执行已结束。确认可返回的终态包括 `completed`、`failed`、`paused`、`not_started` 和 `waiting_quota`；无法判定时返回 `unknown`，不能把未知发送结果重试成第二次执行。

`context` 包含独立的 `dataDir`、插件包路径 `pluginDir`、`getTask(id)`、`getProject(id)`、`updateTask(id, patch, expectedRevision)`、`authorizeExecution({taskId,commandId})` 和 `emit()`。插件应自行原子持久化配置、策略和命令 ID；不能直接写任务 SQLite。状态变化后调用 `emit()` 通知界面刷新。`updateTask` 还需通过核心的修订号和状态规则；会话归属、工作目录与任务内容版本必须由执行插件在发送前核验。

执行插件必须**先持久化命令，再紧贴不可逆外部发送调用** `authorizeExecution({taskId,commandId})`。回调会按插件 ID 核验当前执行租约；只有明确允许发送才可继续。回调抛错、返回 `maySend: false` 或结果不确定时，不能发送模型请求。重复的命令 ID 不得用不同负载再次发送。任务、项目或工作区已有执行租约时，核心拒绝新的并行执行；崩溃或超时后的 `unknown` 租约需要核实结果后才能释放。

宿主只接受以下回调，并按清单权限检查：

| 权限 | 宿主回调与限制 |
| --- | --- |
| `task.read` / `tasks.read`，或执行相关读权限 | `getTask`、`getProject` |
| `task.write` / `tasks.write` | `updateTask`，仍受核心修订与状态检查 |
| `task.resume` / `task.pause` | 可读取任务；`updateTask` 仅能修改 `status`、`blockedReason`；`task.resume` 可调用 `authorizeExecution` |

需要创建会话并写入 `conversationId` 等绑定字段的插件还须声明通用写权限；`thread.create` 声明本身不扩大任务写权限。`emit()` 不授予读写能力。清单权限约束正常宿主 RPC，**不是操作系统沙箱**：可信本地 Node 代码仍能自行访问文件和网络。子进程边界隔离崩溃、超时及协议错误；单条 RPC 消息上限为 1 MB。`createSession`、`resume`、`pause` 的 RPC 结果若在断线时无法确定，宿主按未知处理，不自动重发。详见 [进程隔离边界](plugin-isolation.md)。

无需修改核心即可创建和安装本地插件：

```sh
node scripts/plugin-tool.mjs create --id my-extension --directory /absolute/new-extension
node scripts/plugin-tool.mjs inspect --source /absolute/new-extension
node scripts/plugin-tool.mjs install --source /absolute/new-extension --target /absolute/app-data/extensions --sha256 INSPECTED_HASH --trust-local-code
```

`inspect` 输出待审查文件列表和 SHA256。`install` 要求显式信任本地代码、匹配所给哈希和接口版本；它拒绝包内符号链接、越界入口及超出大小/文件数限制的内容。升级时旧包被保留在返回值的 `previousPackage` 隐藏目录。回退须先对该目录重新执行 `inspect`，再以其哈希作为 `--sha256` 重复 `install`。自有插件状态位于独立的 `plugins/<id>/` 数据目录；同名内置插件冲突会报错，不会覆盖内置包。哈希只证明安装的是审查过的同一份本地代码，不证明来源可信。

`GET /api/plugins` 返回插件状态、权限、能力、配置 schema 与隔离类型。拥有者可用 `PATCH /api/plugins/<id>/config` 和 `POST /api/plugins/<id>/enable`、`disable`、`check` 管理生命周期。内置 Codex Auto Continue 的来源和修改范围见 [PROVENANCE](../plugins/codex-autocontinue/PROVENANCE.md)。
