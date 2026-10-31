# 验证待办

当前全部剩余工作与验收方法见[待实现与待验证工作计划](remaining-work-plan.md)（2026-10-18）。下文 32 条及机器清单是早期版本快照，不是当前未完成数量；后续执行时按总计划逐项核对并更新实际看板，保留用户已有勾选、证据和人工验收历史。

任务详情中的“部分验证”必须能够回答：还差哪一步、怎么检查、什么结果算通过、目前缺什么条件。

## 在界面里怎么看

“测试验证”下方先展示**验证待办**。每项待办显示名称与类型，展开后查看操作步骤、通过标准和当前条件；首项默认展开。

- **待验证**：能力已有实现，还缺真实环境或完整场景的测试证据。
- **待实现**：对应功能尚未做完，先实施，再按步骤验证。
- **待确认**：需要先确定功能范围或测试前提。

原始大项的覆盖数与子待办数分别显示。例如，一个“工具适配”验收标准可以拆成 Claude 真实会话、Cursor 真实会话、暂停与权限、工具版本展示四项待办；仍有缺口时，该大项不计为完整验证。

点击具体待办旁的圆圈可在“未验证”和“已办结”之间反复切换：办结时圆圈填充，再次点击恢复为空心。列表保留已办结项并显示完成数量，刷新或重启后继续保留状态。键盘也可使用 Tab 聚焦后按空格切换；点标题仍用于展开说明。

办结表示用户对该子待办的人工标记，不会改写整项任务的测试结论、覆盖范围或人工验收。补齐证据后再更新整项验证记录。旧任务没有具体方法时显示“待补充验证计划”；这种占位说明不能勾选。任务版本改变后，旧计划需要重新确认，旧版圆圈暂不能更改。

## 当前项目的计划

[机器可读清单](verification-backlog.json)为原始 23 项需求中的 12 项未完成任务列出 **32 条待办：25 条待验证、6 条待实现、1 条待确认**。文件只含公开需求编号，不含个人任务 UUID、真实会话或本机证据。

| 任务 | 待办数 | 具体范围 |
| --- | ---: | --- |
| M01 三系统能力验证 | 2 | Windows 原生环境；Ubuntu 与 Wayland |
| M06 Codex 会话适配 | 2 | 连续多轮与重启衔接；真实断线与额度边界 |
| M07 悬浮窗与托盘 | 3 | macOS 焦点组合场景；Windows；Ubuntu |
| M09 五小时自动继续 | 2 | 真实恢复后只发送一次；等待期间人工暂停 |
| M11 手机查看与控制 | 3 | 实体手机 HTTPS 查看；控制与撤销；断网与过期 |
| M12 通用 MCP | 2 | 第二个真实宿主；真实宿主权限边界 |
| M13 完整场景 | 3 | 额度恢复闭环；跨系统闭环；实体手机交付闭环 |
| M14 安装与发布 | 3 | macOS、Windows、Ubuntu 各自安装到卸载 |
| E01 Claude / Cursor | 4 | 两种真实会话；暂停、审批与断线；实际版本展示 |
| E02 多模型协作 | 3 | 工作树隔离；费用预算；真实多模型独立审查 |
| E03 云服务与节点 | 3 | 节点迁移；注册计费；公网运维恢复 |
| E05 原生手机 App | 2 | 确认原生需求；实现并在设备验证 |

该清单没有把以上测试标为已完成。现有 11 项人工验收结果、原始目标和验收标准不因补充计划而改变。按当前用户选择，Claude/Cursor 真实任务、第二个宿主登录和云端 CI 暂不执行。

0.2.2 的待办展示功能通过了 130 项自动化测试、Chromium/WebKit 的 6 组相关界面流程，以及 macOS 原生界面与重启保存检查。这里验证的是待办功能本身，32 条后续待办仍未完成；详见[该版本验证记录](verification-backlog-test-results.json)。

0.2.3 的圆圈切换通过了 134 项自动化测试、Chromium/WebKit 点击与键盘流程，以及 macOS 实际点击、重启保留和撤销检查。测试后已恢复现有待办的原始状态；详见[切换功能验证记录](verification-toggle-test-results.json)。

## 如何维护

所有者通过现有 `POST /api/tasks/:id/verify` 接口提交完整验证记录。`pendingChecks` 中每项需要稳定 ID、类型、关联的当前验收标准 ID、标题、操作步骤及通过标准；`blockedReason` 说明缺少的条件。

```json
{
  "expectedRevision": 3,
  "status": "unverified",
  "summary": "尚未执行，仅记录设备验证计划。",
  "reference": "docs/verification-backlog.json",
  "criterionIds": [],
  "pendingChecks": [
    {
      "id": "phone-https",
      "kind": "test",
      "title": "实体手机通过 HTTPS 查看进度",
      "criterionIds": ["替换为当前任务的真实标准 ID"],
      "steps": ["在测试服务器配置有效 HTTPS，并给手机配对。", "更新电脑上的测试任务，在手机上核对结果。"],
      "expectedResult": "只有授权项目可见，进度与同步时间一致。",
      "blockedReason": "需要测试服务器、域名和实体手机。",
      "shareWithRemote": false,
      "completed": false
    }
  ]
}
```

示例中的修订号和标准 ID 必须从当前任务读取。`unverified` 表示计划尚未执行，不能填写已覆盖标准；已有部分测试的任务保留 `partial` 和真实覆盖范围。存在待办时不能提交 `passed`。省略 `pendingChecks` 会保留同版本已有清单；要结束或替换计划必须显式提交清单。旧版本仍有待办时，必须重新确认当前版本的清单，不能默默沿用。

只有本地所有者可更新验证记录；MCP reporter 和远程控制者不能自行改写验证结论。计划随任务记录持久化、备份恢复，并进入项目交接背景。

切换单项使用 `POST /api/tasks/:taskId/verification-checks/:checkId`，请求体为 `{"expectedRevision": 3, "completed": true}`；恢复未验证时传 `false`。修订号必须从当前任务读取，旧版本计划及并发冲突会被拒绝。该接口只更新指定待办、任务修订号和人工操作记录，不触发 AI 执行。旧数据缺少 `completed` 时按 `false` 处理。

## 远程范围

**待办详情默认仅在本地显示。** 手机可以看到待办数量、办结状态、类型和对应标准，但标题、操作步骤、通过标准和本机条件以“请在桌面查看”代替，避免把测试路径或本机错误附带上传。当前 Hub 手机页只读展示圆圈状态，切换需在项目电脑完成。

需要远程展示某项完整说明时，由所有者先检查文本，再在该项显式设置 `shareWithRemote: true`。这会把该项文字同步给已有项目授权的 Hub 与设备；不要放入令牌、个人路径或原始错误日志。验证证据引用仍始终在远程隐藏。当前界面不提供修改此开关的控件，须通过所有者验证接口维护。

## English overview

Task details now list actionable verification todos: what remains, the procedure, the pass condition, and missing prerequisites. Items distinguish testing, implementation, and decisions. Plans do not count as evidence or human acceptance; stale plans and missing legacy procedures are labeled explicitly.

Click a stored item's circle to toggle incomplete/completed, or focus it and press Space. Filled circles, completion counts, and changes persist after reload or restart. Manual completion does not change the task's test result, evidence, or human acceptance. Stale plans and generated placeholders cannot be toggled; Hub devices display the synced state read-only.

The [catalog](verification-backlog.json) contains 32 pending items across 12 incomplete requirements. Original goals and the 11 accepted tasks are preserved. Only the local owner can maintain verification records. Checklist details stay local by default; explicit per-item `shareWithRemote: true` allows reviewed text to reach the authorized Hub and devices. Evidence references remain local.
