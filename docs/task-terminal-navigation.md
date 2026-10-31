# 任务、对话与项目终端

任务详情和已有对话里现在都有“项目终端”。打开后会显示正在处理的项目和任务，并提供“返回任务与证据”。处理完终端里的问题，可以直接回原任务补证据或验收。

- “远程终端”常用导航仍先打开 SSH 主机列表。
- “项目终端”进入本机与已绑定电脑的工作区，继续使用已有授权与人工接管流程。打开页面本身不会连接、暂停 AI 或执行命令。
- tmux 会话仍从真实会话列表中选择。任务与 Codex 对话没有可靠的会话绑定时，不自动猜测应接入哪个 tmux。
- 切换项目后移除旧任务提示；没有选择任务的新对话不显示任务快捷入口。

APP1079 已通过构建、独立代码审查和隔离浏览器导航检查，覆盖浅色、深色、320/390 像素手机布局及桌面督办表格。检查使用展示数据，没有执行真实 AI、SSH 或终端接管。两个初始展示服务数据格式错误已修正，仅修改了测试服务。

实际安装、网页部署和普通 Android App 复测分别见[交付状态](current-delivery-status.json)及[本次记录](task-terminal-navigation-test-results.json)。不将网页尺寸检查视为实体手机或完整 App 验收。

## English

Task details and existing conversations now have a **Project terminal** shortcut. The managed terminal shows the project and task, with a **Return to task and evidence** action. The regular terminal navigation still opens the SSH host library.

Opening this view does not connect, pause AI, grant access, or execute commands. Existing authorization and takeover controls remain in place. Users select a real tmux session explicitly; the UI does not infer a tmux mapping from a Codex conversation. Switching projects clears the previous task context.

APP1079 passed the build, independent code review and isolated browser navigation/layout checks, including light/dark mobile widths. These checks used disposable presentation data and did not exercise real providers, SSH or terminal takeover. Native installation, Web deployment and Android App verification are recorded separately in the linked delivery report.
