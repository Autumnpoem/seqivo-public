# 自动继续计划首次启用绑定

## 中文

首次启用自动继续计划时，插件会固定当时的任务版本与执行上下文：内容版本、对话、项目、工作目录/工作树及交还状态。额度等待和实际派发前都会复核该绑定；重复点击启用不会刷新绑定。若任务或执行位置在首轮开始前改变，计划停止，不发起自动轮次。

插件只有在观察到首个自动轮次已启动，并将运行状态与确认标记一起持久保存后，才解除这次绑定。之后的合法任务版本变化按常规自动继续规则处理。缺少明确首轮确认记录的旧计划不会从手动命令收据推断成功；需要显式重新开始。人工继续入口仍可用。

**验证范围有限。** 固定源码版本的 fake-provider 测试为 32/32 通过、0 跳过；目标场景为 2/2。REVIEW489 对该变更的独立静态审查没有发现新的已证实 P1/P2。它们验证的是绑定和停止规则，不代表真实 Codex/额度恢复/原生作业或完整应用验收通过。

## English

On first enable, the plugin binds the plan to the current task revision and execution context: content version, conversation, project, workspace/worktree, and handoff state. It rechecks that binding while waiting for quota and before dispatch. Re-enabling an already-started plan does not refresh the binding. A pre-start task or execution-context change stops the plan without dispatching an automatic turn.

The one-time binding is cleared only after the first automatic turn is observed as started and its running state and confirmation marker are persisted together. Later valid task revisions follow the normal continuation rules. A legacy plan without explicit first-turn confirmation is not inferred from a manual command receipt; it requires an explicit restart. Manual resume remains available.

**Limited verification only.** The pinned fake-provider suite passed 32/32 with no skips; the targeted cases passed 2/2. REVIEW489's independent static review found no newly confirmed P1/P2. These results cover the binding and stop rules only, not real Codex, quota recovery, native jobs, or full-app acceptance.

See the [machine-readable test record](autocontinue-plan-binding-test-results.json).
