# 协作工作树模块契约

`server/worktrees.mjs` 负责本机 Git 工作树登记、核验、差异、合入和清理；Core、Workflow、执行租约和 Codex 插件已接线。界面与真实模型端到端验收仍须另行完成，不能仅凭模块测试认为 P3-ISOLATE 全部完成。

## 建立与持久状态

由可信 Core 创建 `createWorktreeManager({ store, rootDir, authorizeMerge })`。`rootDir` 必须已存在，是应用专用的绝对私有目录（POSIX 权限不向组和其他用户开放），与项目仓库不能重叠；模块只在其下用随机 UUID 生成工作树路径。项目绑定目录必须恰为 Git 仓库根目录。登记写在模块自有 SQLite `worktree_registry` 表，记录项目 ID、任务 ID、角色、请求幂等键、仓库真实路径及 Git common-dir、原分支、完整 base commit、`codex/` 分支、工作树路径和状态。

`create({ projectId, taskId, role, requestId, expectedBase })` 要求主工作区干净，`expectedBase` 与当前 HEAD 精确相同，并在 Git 命令前持久写入 `creating`。相同请求键和参数只返回原登记；参数不同则冲突。`reconcile(id)` 在启动后重验 Git worktree/分支/HEAD 身份：可确认的创建中断会续建或转为 `ready`；路径上有未知文件、分支偏离、目录或项目绑定变化时保留现场并拒绝。`list({ projectId })` 返回登记，`inspect(id)` 返回当前 HEAD、是否脏、Git 状态、相对 base 的文件差异与最多 1 MiB 的补丁；未跟踪文件列在状态中，不会伪称已包含在 Git 补丁中。

## 人工审查与合入

`prepareMerge({ id, expectedTargetHead, reviewId })` 不接受客户端的布尔 `reviewed`。Core 必须注入 `authorizeMerge({ reviewId, projectId, taskId, role, branch, baseCommit, sourceHead, targetHead })`，只在真实人工审查记录精确对应源、目标 commit 时返回 `{ authorized: true, reviewId, sourceHead, targetHead }`。模块在等待审查回调之前，在同一个 SQLite 事务内核查活动租约、协作成员和运行中任务，持久插入项目级 `worktree_fences` 记录。执行租约在自身事务内检查该围栏，所以同项目根目录和各工作树的新执行与合入互斥。模块在回调后再次核对分支、HEAD 和两个工作区均干净，才持久登记 `merging` 并执行 `git merge --no-ff --no-commit`。冲突保留主工作区的索引、冲突标记和 `MERGE_HEAD`，登记为 `conflict`；不会自动 `reset`、`abort` 或覆盖用户文件。

人工解决冲突并暂存后，Core 可提供已审查的 `expectedIndexTree` 调用 `finalizeMerge({ id, expectedIndexTree })`。模块要求 `MERGE_HEAD`、原目标 HEAD、分支、源 HEAD 和索引 tree 精确匹配，没有未解决、未暂存或未跟踪文件；实际提交前在同一个事务内再次核验当前任务的内容版本、人工验收和原审查收据。任务内容变化使旧收据失效时保留合入现场，必须对当前任务重新人工验收，再以当前索引 tree 补记新的 owner 审查收据。最后核验与 Git commit 之间没有异步等待。重启后 `reconcile` 可凭 `MERGE_HEAD` 或精确的两父合并提交恢复登记；只有核实提交结果后才清除围栏。审查记录、源 commit、目标 commit 和合并 commit 保留在登记中。

`cleanup(id)` 仅清理自己的登记路径及分支。工作树必须干净，并且仍在原 base，或已合入且没有后续提交；未知身份、未合入提交、冲突和未保存修改一律拒绝。清理在首个 Git 写操作前取得相同的持久围栏，活动的同项目执行会阻止清理。它调用 Git 的非强制 `worktree remove` 与 `branch -d`，不递归删除外部目录。中途退出保留 `removing` 与围栏，下次核实后续清理；不确定的 Git 结果不会自动解除围栏。

## Core 与界面契约

全部 `/api/worktrees` 接口仅允许本机 owner。`GET /api/worktrees/base?projectId=…` 返回 `{projectId,targetHead,targetBranch,targetDirty}`，用于创建时提交精确 `expectedBase`；`POST /api/worktrees` 接收上述 `create` 参数；`GET /api/worktrees?projectId=…` 列登记；`GET /api/worktrees/:id` 返回详情，其中 `head` 是源 HEAD，`targetHead` 是主分支 HEAD，`dirty` 与 `targetDirty` 表示各自未提交状态，`status`、`nameStatus`、`patch` 表示工作树差异。冲突或解决中额外返回 `conflictFiles`、当前暂存补丁 `stagedPatch`、是否截断 `stagedPatchTruncated`，以及可写入树对象时的 `indexTree`；`reviewStatus:{valid,reason,reviewId}` 报告原收据是否仍适用于当前任务与索引，`reason` 为 `missing_receipt`、`task_review_stale`、`index_unresolved`、`index_changed` 或 `null`。其他阶段 `reviewStatus:null`。`cleanupEligible` 和 `cleanupBlockedReason` 说明清理条件。

`POST /api/worktrees/:id/review {sourceHead,targetHead,reviewId?}` 要求任务当前版本已被人类验收、两处工作区干净且 HEAD 精确一致；Core 生成或接受幂等 `reviewId`，在模块私有 `worktree_reviews` 表记录 owner、任务内容版本和两个 commit。冲突或合入准备中若任务内容已变化，应先重新人工验收当前任务，再查看服务端完整的 `stagedPatch`，使用同一路由提交 `{sourceHead,targetHead,expectedIndexTree,reviewId?}` 补记索引版本绑定的审查收据。`POST .../:id/merge {expectedTargetHead,reviewId}` 只在回调重新核验该收据、当前任务验收和源/目标版本后准备合入；其他活跃执行租约阻止合入。`POST .../:id/finalize {expectedIndexTree,confirmReviewed:true}` 要求 owner 明确确认当前 `indexTree`，并在提交前重新核对现场和审查收据。`POST .../:id/cleanup {}` 仅清理满足前述条件的登记工作树。

`POST /api/workflow/plans` 只有显式 `workspaceMode:'worktree'` 才启用独立工作树，每位成员须提供与其任务、角色一致的 `worktreeId`。省略该字段仍采用旧项目根目录和串行锁。`POST /api/tasks/:id/session` 可由 owner 提供 `{worktreeId,workspaceWrite:true}` 创建绑定工作树的 Codex 会话；已有根目录会话不能改向工作树。执行租约持久记录工作树身份与真实目录，只有同项目不同且不重叠的登记工作树可并行；根目录执行与任何同项目工作树执行互斥。Codex 在建会话和每次 turn 前重验登记目录、会话 cwd、任务/命令租约。

界面刷新后应调用 owner-only `GET /api/worktrees/:id/binding`，返回 `{worktreeId,taskId,conversationId,verified,status,resumable?}`。只有工作树登记、当前任务会话、插件持久创建记录，以及提供者实际线程 ID/cwd 全部一致时才返回 `verified:true,status:'bound'`；`resumable` 仅表示读取时线程空闲且没有待审批标志，仍须经过执行租约和最终校验。旧根目录会话或没有工作树会话时返回 `unbound`；提供者不可读、线程目录变化或任何身份核验失败时返回 `unconfirmed`，两者均不可当作可执行绑定。此接口不向远程任务投影添加私有目录信息，也不启动 turn。

## 工作树保存为审查版本

保存预览与后端 API 已实现，并在冻结的本机真实 Core/Git 集成中通过有限回归。`WORKTREE346` 记录 56/56、零跳过；`IMPL341` r5 的 UI 类型检查、构建、浏览器 mock 与真实 Core/Git 浏览器流程均 exit 0；REVIEW349-R2 关闭两项 UI P2，限定复核未发现已证实 P1/P2。WORKTREE324 随后尝试真实 AI workflow（两次启动、零重发），但 A 返回 `server_overloaded`，B 中断时仍运行且退休状态未知，最终 thread 核验 predicate 仍未知；文件未变化、保存/审查/合入未启动，因此没有真实协作通过。IMPL356 后续完成有界诊断实现，fake-provider 定向 3/3、workflow 18/18、旧 host 回归 5/5 均 exit 0、零跳过；REVIEW360 未发现该范围内新确认的 P1/P2。此结果没有证明 WORKTREE324 的真实 provider 错误形状或根因已修复，原未知记录保留。详见[真实 workflow 记录](worktree-workflow-test-results.json)与[诊断回归记录](provider-completion-diagnostics-test-results.json)。入口限本机 owner：

- `GET /api/worktrees/:id/save-preview` 返回完整变更清单与 patch，涵盖受支持的 UTF-8 普通文件、新增、修改、删除及未跟踪文件。暂存文件、二进制、符号链接、子模块、`*.srl` 与超出限制的内容拒绝保存。
- `POST /api/worktrees/:id/save` 接受 `requestId`、`expectedHead`、`expectedTaskRevision`、`expectedContentVersion` 和 `expectedSourceDigest`。服务端重算当前预览并核对任务、工作树、版本及摘要。限定回归中成功时在原工作树分支建立新审查版本提交；回执以 `sourceHead` 标识新提交，`previousHead` 标识原 HEAD。
- `GET /api/worktrees/:id/save?requestId=…` 查询同一请求，状态包括 `not_found`、`not_saved`、`prepared`、`ready` 与 `saving_unknown`。结果不明时保留请求与围栏，不能自动发起另一保存。
- `POST /api/worktrees/:id/save/reconcile` 只核验或完成同一原请求的已准备保存，不创建新的请求或新提交。未能证明 Git 引用未改变时保持 `saving_unknown`，不重放 CAS。

WORKTREE346 的限定后端集合覆盖请求幂等/重启、文件新增修改删除、无关任务或审查状态不变、别名围栏、暂存/二进制/符号链接/配置过滤/路径限制拒绝、CAS 未执行时的 `not_saved`、任务编辑后的历史成功状态、CAS 结果未知时保留围栏且不重发、HEAD 切换拒绝，以及跨项目并行与重叠阻止。独立复核未发现已证实 P1/P2；异步准备 Git 子进程的关闭证明仍未等待确认，这一限制保留，尚未观察到迟到 CAS 路径。`IMPL341` r5 随后重跑并通过 mock 与真实 Core/Git 浏览器流程，源源码和测试哈希见[工作树保存验证记录](worktree-save-test-results.json)。早期固定 HEAD、定位和 patch 格式断言问题为测试预期修正，不是产品修复。REVIEW349 最初发现 ready 回执缺少工作树/previousHead 绑定、not_found 刷新会清除原请求；r5 修复后按原请求核对工作树 ID、source/previous HEAD、摘要及文件数。历史 ready 回执核验原保存身份，不要求当前 HEAD 仍停在旧值。not_found 刷新保留原请求锁；若始终没有可靠的否定回执，可能持续锁定并需人工恢复，不能自动新建请求。

浏览器 mock 与真实 Core/Git 浏览器流程均已通过，覆盖预览、明确确认和保存回执；新审查版本成为工作树 HEAD 并保持干净，目标 HEAD、任务状态、验收状态、内容版本及人工审查记录未改变。REVIEW349-R2 的限定 UI 独立审查已关闭两项 P2，未发现已证实 P1/P2；仍需完成真实 AI 双任务的最终合入及完整客户端验收。WORKTREE324 的首次 workflow 尝试未完成：A 遇到 `server_overloaded`，B 以 `interrupted` 结束且 `retirement_unknown` 保留，最终 thread 核验 predicate 仍未知；后续只读空队列/身份检查没有证明回合成功或清除未知记录。IMPL356 的有界诊断与 fake-provider 回归通过并经 REVIEW360 限定复核，但真实 provider 错误形状及此失败的根因仍未证实。该保存功能只保存为工作树上的审查版本，不标记任务完成、不进行自动审查、不更新主分支、不合入。

### 后续真实双工作树尝试与关闭复现

WORKTREE1005 使用冻结的 `719d67c` BUILD1000 打包 Core，在全新一次性项目中顺序运行两名真实 Codex worker；每人只启动一次、没有重发，提供者元数据均记录实际模型 `gpt-6.1-sol`，effort 未核实。两名 worker 均提交了各自工作树中指定文件的一行变更，A 经完整预览和明确批准保存为源分支提交，随后在可丢弃样本内调用验收接口并记录源版本审查；这不是用户亲自验收，也未由另一个模型独立审查。A 的合并只到 `merging`：目标 HEAD 仍为原 base，索引暂存仅 A 文件，B 保留独立脏工作树且未合入。`merge-a` 阶段的 Core 关闭返回“部分插件未能确认进程已停止”，未记录具体插件及嵌套原因；原 Core 锁标记 `uncleanShutdown`，合并围栏保留，索引复审和最终提交均未完成。该阶段不能算通过，也不能据此自动重试、清除围栏或声明用户验收完成。证据见[真实 workflow 记录](worktree-workflow-test-results.json)及本地一次性记录 `.runtime/worktree1005/diagnosis1019.md`。

WORKTREE1020 另用三套全新、未启用 provider 的一次性 Core 数据，分别在建树、保存 A、以及 A 暂存合并而 B 保持脏工作树后执行关闭；三次 Core/插件关闭均成功，锁文件随之消失。它没有运行模型 turn，也没有复现或解释 WORKTREE1005 的关闭失败，不能用来解除原锁与围栏。详见 `.runtime/worktree1020/report.md`。当前文档修订时 HEAD 为 `e4cf3e9`，与真实尝试使用的 `719d67c` 不同；经 `git diff --quiet` 核对，`server/worktrees.mjs`、`server/worktree-save.mjs`、`server/workflow.mjs`、`server/core.mjs` 和 `plugins/codex-autocontinue/host.mjs` 在两提交间未变。这只支持所列源码的版本比较，不等于当前提交已完成打包端到端验证或 M5 整体验收。

### 会话启动失败时的工作树核对

原生执行器记录可能先于 Codex 会话创建成功而保存。WORKTREE1029 暴露了一个退出路径问题：尚无已创建会话时，系统回退到主项目目录，误判原工作树已变化。W1037 修正为从执行器记录的工作树 ID 向 Core 重新核对任务归属和登记目录，再检查原路径、真实路径、内部记录根及进程退休证明；已经创建的会话仍必须与该记录一致。

目录核对通过不等于进程已经停止。无法证明原执行器退休、目录或归属变化、原记录丢失时，仍保留保护状态并拒绝恢复；不得重发原请求或仅凭进程标签消失删除记录。该修复的定向与回归证据见[真实 workflow 记录](worktree-workflow-test-results.json)。W1029 的原始启动失败及 W1005 的最终合入未完成状态分别保留。

### 已完成的隔离命令探针（不代表上述保存 API）

Codex CLI `0.162.0-alpha.17.2` 的无模型 `command/exec` 探针限定通过：在链接工作树当前目录创建普通文件成功；同一策略下 `git add` 因无法创建仓库外的 Git 索引锁而以 128 退出。基线 HEAD 未变、没有暂存项，临时仓库已清理，探针自己的 app-server 已退出。该结果只证明此 `command/exec` 策略下的 cwd 写入与 Git 索引写入边界；它不是模型 turn、产品保存流程或完整沙箱证明。被拒绝的探测不能成为放宽 sandbox 或改用未授权写入方式的理由。探针记录见[工作树保存验证记录](worktree-save-test-results.json)。

## 边界

工作树不是 OS 沙箱，进程仍可通过绝对路径访问别的目录。工作树隔离只约束本应用受管调度与受管会话；外部写入进程、用户手动 Git 操作和未登记的 Codex 线程不由此机制隔离。模块并不自动迁移既有计划、任务会话或项目。冲突解决保留 Git 现场，由人类在主仓库解决并暂存；缺少可核验的索引或审查收据时不合入。
