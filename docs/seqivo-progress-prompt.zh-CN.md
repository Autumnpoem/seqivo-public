# 序程本地进度汇报说明

把本文件复制到需要管理的项目根目录，命名为 `SEQIVO_PROGRESS.md`，并明确要求当前 AI 对话遵循它。它是文件汇报约定，不安装插件，也不授予额外执行权限。

## 使用前

序程应已运行，并把本项目目录绑定到一个项目。先读取 `.taskboard/CONTEXT.md` 和 `.taskboard/tasks.json`。文件不存在时，说明接入尚未完成，告诉用户在序程里新建项目并选择当前目录，不要伪造快照。

以用户原始要求为准；保留现有项目规则、文件和配置。不要读取无关目录或账户资料。将已确认的需求拆成能验收的小任务，先核对已有清单，避免重复创建。

## 何时更新

开工、完成一个小功能、遇到阻碍、结束本轮时，分别写明具体进展。每项记录只用短句说明“已经做到什么、还差什么、下一步做什么”，附必要的实现思路。没有证据的结果明确写未验证。

## 怎样写入

每次提交是一份独立 JSON 对象，放到 `.taskboard/inbox/<唯一事件ID>.json`。先写同目录的临时文件（例如 `.tmp` 后缀），写完后重命名为 `.json`。每个事件使用新 UUID；重试完全相同的一次提交可保持原 ID，不能用同一 ID 改写内容。

新增任务示例：

```json
{
  "eventId": "请生成新的UUID",
  "type": "task.create",
  "payload": {
    "title": "统计文件类型",
    "goal": "输入文件名列表，得到每种扩展名的数量。",
    "example": "a.txt、b.txt、c.png 应显示 txt 2 个、png 1 个。",
    "summary": "已明确要求，尚未开始。",
    "criteria": ["txt 和 png 分别统计正确", "无扩展名文件单独计数"]
  }
}
```

新建任务的初始状态为 `planned`。提交成功后，从最新 `tasks.json` 或回执读取真实 `taskId` 与 `revision`；不要把下面占位值原样提交，也不要把任务标题当成 ID。

更新进度示例：

```json
{
  "eventId": "请生成新的UUID",
  "type": "task.update",
  "taskId": "从快照读取的真实任务ID",
  "expectedRevision": 1,
  "payload": {
    "status": "running",
    "summary": "已写好统计函数，正在检查没有扩展名的文件。",
    "approach": "按扩展名分组计数，不移动原文件。",
    "nextStep": "执行两个用例并保存测试结果。"
  }
}
```

`expectedRevision` 必须替换为刚读取的修订号。状态使用 `planned`（未开始）、`running`（进行中）、`blocked`（受阻）、`failed`（执行失败）、`submitted`（已交付待验收）。受阻时附 `blockedReason`。不自行覆盖用户的暂停或取消决定。

汇报允许更新 `summary`、`approach`、`nextStep`、`status`、`implementationRef`、`blockedReason`、`sourceConversation`。修改原始目标、验收标准、执行会话绑定或执行工具，需要用户在看板确认。若记录来源会话，仅填写确实知道的工具和会话信息；不知道就省略。

完成本项后，先用 `task.update` 提交最终摘要并把状态设为 `submitted`；再次读取最新修订号，再追加证据：

```json
{
  "eventId": "请生成新的UUID",
  "type": "evidence.add",
  "taskId": "从快照读取的真实任务ID",
  "expectedRevision": 3,
  "payload": {
    "summary": "两项统计测试通过；尚未测试移动文件。",
    "reference": "reports/count-files-test.txt"
  }
}
```

证据应指向确实存在的测试报告、产物或操作记录，写清验证范围和没测的部分。仅添加证据不会自动标成“已验证”，也不等于人工验收通过。后续修改任务内容可能使旧证据和验收失效，应补充当前版本证据。

## 每次必须核对回执

等待 `.taskboard/receipts/` 出现对应结果，按其中的 `eventId` 找到提交。成功为 `status: "accepted"`，会返回 `taskId`、`revision`。也可按事件路径定位：文件名为字符串 `/inbox/<事件文件名>.json` 的 UTF-8 base64url 编码，再加 `.json`。

遇到 `rejected`，读取 `error` 并修正。修订冲突时重新读取快照，对比最新内容后再用新事件 ID 提交，不覆盖其他对话更新。若暂时没有回执，先确认序程正在运行，保留原事件核查，不连续创建重复任务。

服务通常约每秒检查一次；收到回执后再确认任务快照和预期一致。不要直接编辑 `.taskboard/tasks.json`、`.taskboard/CONTEXT.md` 或序程数据库；不要删除原进度和历史。

## 交接与保密

结束本轮前更新下一步；新对话继续先读本文件、CONTEXT.md 和 tasks.json。不要把密码、令牌、私钥、私用服务器地址或完整私密聊天写进进度记录。文件汇报不能代替人工验收，也不能自动启动、暂停或继续外部 AI。
