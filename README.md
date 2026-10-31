<div align="center">
  <img src="design/brand/seqivo/icon-light.svg" width="92" height="92" alt="序程图标" />
  <h1>序程 · Seqivo</h1>
  <p><strong>让 AI 的工作进度和交付证据有迹可循。</strong></p>
  <p>跨 AI 对话记录项目任务、进度、证据和人工验收。<br />本地优先；你决定 AI 做什么，也由你确认结果是否完成。</p>
  <p><strong>简体中文</strong> · <a href="README.en.md">English</a></p>
  <p><code>发行 v0.4.1-r2 · 应用 0.4.1</code> · <code>Mac · Android</code> · <a href="LICENSE">PolyForm Noncommercial 1.0.0</a></p>
  <p><a href="#安装">安装</a> · <a href="#第一个项目">第一个项目</a> · <a href="#可选接入">可选接入</a> · <a href="#文档">文档</a></p>
</div>

![序程项目看板示例](docs/assets/overview-light.png)

*界面截图使用独立的虚构演示数据，不是用户项目或产品效果保证。截图中的界面为中文。*

## 序程是什么

一个项目经常跨越多轮对话和不同 AI 工具。序程用一份持续更新的任务清单记录原始目标、已完成内容、下一步、证据和验收结论，帮助你在新对话里接着做。

序程不会自动读取所有 AI 聊天，也不会因为 AI 说“完成”就认定任务通过。AI 可以汇报进度和附上证据；测试状态与人工验收分别记录，最终由你核对当前结果。

**本地文件汇报流程不需要 Hub 账号、AI API 密钥或项目的业务 API／业务数据库。** 序程在本机保存自己的看板数据；项目文件夹中的 `.taskboard/` 文件用于 AI 与看板交换背景、进度和回执。是否使用 AI 以及如何登录 AI 工具，由你在对应工具里决定。

### 核心功能

| 功能 | 你可以做什么 |
| --- | --- |
| 项目与任务 | 跟踪目标、进度、阻碍、下一步和验收标准；按人工验收结果查看项目完成情况。 |
| 证据与验证 | 保存交付证据，记录测试覆盖及结果；测试记录和人工验收分开显示。 |
| 需要处理 | 集中查看待验收、受阻、待决定等事项，并由你作出决定。 |
| 对话交接 | 用项目背景和任务快照在新 AI 对话中继续工作。 |
| 外观与连接 | 支持浅色、深色和跟随系统外观；可选 Codex 执行插件、手机 Hub 和 SSH/tmux 终端。 |

Codex 执行、手机 Hub 和 SSH/tmux 属于可选连接，需单独配置；不同系统与连接方式的验证范围并不相同，见下文说明。

## 安装

| 平台 | 获取与安装 |
| --- | --- |
| Mac Apple Silicon | [ZIP 安装包](https://github.com/Autumnpoem/seqivo-public/releases/download/v0.4.1-r2/Seqivo-0.4.1-macos-arm64.zip)；下文有首次打开说明。 |
| Android 8.0+ | [签名 APK](https://github.com/Autumnpoem/seqivo-public/releases/download/v0.4.1-r2/Seqivo-0.4.1-android.apk)；[手机安装与连接指南](docs/mobile-install.zh-CN.md)。 |
| iPhone | Safari 网页／添加到主屏幕；[使用步骤](docs/mobile-install.zh-CN.md)。无原生 iOS 安装包。 |
| Windows 10/11 x64 | 暂无发布安装包；[从依赖安装到 NSIS 打包的完整指南](docs/build-windows.zh-CN.md)。 |
| Ubuntu 24.04 LTS x64 | 暂无发布安装包；[从依赖安装到 deb/AppImage 打包的完整指南](docs/build-ubuntu.zh-CN.md)。 |

**手机版需要你自己的 HTTPS Hub。** 没有内置公共服务地址；安装 APK 不会自动部署服务器或同步项目。见[手机指南](docs/mobile-install.zh-CN.md)。

### Mac Apple Silicon

当前发行编号为 **v0.4.1-r2**，应用版本仍为 **0.4.1**；本次沿用 v0.4.1 的同一 Mac 包。前往[最新 Release 页面](https://github.com/Autumnpoem/seqivo-public/releases/latest)，下载 Mac Apple Silicon ZIP，解压后将“序程.app”移到“应用程序”，再打开应用。

此安装包使用本地临时签名，未经过 Apple Developer ID 签名或公证。首次打开时 macOS 可能提示无法验证开发者；只有在确认下载来源可信后，按系统“隐私与安全性”中的提示允许打开。不要为此关闭 Gatekeeper 或降低系统安全设置。Intel Mac 当前没有对应安装包。

### Windows、Ubuntu 或其他系统

当前没有 Windows 或 Ubuntu 安装包。按 [Windows 指南](docs/build-windows.zh-CN.md)或 [Ubuntu 指南](docs/build-ubuntu.zh-CN.md)自行编译安装，也可以从源码启动本地 Web 看板；桌面原生应用也有构建配置，但 Windows、Ubuntu 和 Intel Mac 的原生安装与完整交互尚未全部验收。请勿把“可以构建”理解为这些平台已通过完整发布验证。

源码 Web 路径需要 Git、[Node.js 24 或更新版本](https://nodejs.org/)及 [pnpm 11](https://pnpm.io/installation)：

```sh
git clone https://github.com/Autumnpoem/seqivo-public.git
cd seqivo-public
pnpm install --frozen-lockfile
pnpm build
pnpm server
```

在同一台电脑打开 <http://127.0.0.1:4317>。首次使用时，从源码目录 `.runtime/access.json` 读取本机 `owner` 访问令牌，并在看板登录页输入；不要把令牌放进网址、聊天或公开文件。源码运行的是本机服务与数据库，不要求外部业务数据库。停止使用时，在运行服务的终端按 `Ctrl+C`。日常源码与桌面构建说明见[桌面构建指南](docs/desktop-build.md)。

<a id="ai-tools"></a>

### 可选：安装并登录 AI 工具

如果你已经在使用 Codex、Claude 或其他 AI，可以直接在当前对话里粘贴序程提示词，无需再安装命令行工具。若还没有 AI 工具，按提供方的官方步骤安装并登录；AI 账号与序程无关，**不要把 AI 密码或访问令牌填入序程**。

- **Codex CLI（macOS / Linux）：**按[官方 CLI 指南](https://learn.chatgpt.com/docs/codex/cli)运行安装命令 `curl -fsSL https://chatgpt.com/codex/install.sh | sh`。进入项目文件夹运行 `codex`；首次启动时选择 **Sign in with ChatGPT** 或其他可用登录方式。Windows 等系统请查看官方指南中的对应安装步骤。
- **Claude Code：**Anthropic 当前推荐原生安装。macOS、Linux 或 WSL 终端运行 `curl -fsSL https://claude.ai/install.sh | bash`，然后新开终端运行 `claude --version` 检查安装。进入项目文件夹运行 `claude`，首次使用按提示在浏览器登录；可使用 Claude 订阅、Anthropic Console（预付费额度）或受支持的云平台。Windows 等系统请按[官方 Quickstart](https://code.claude.com/docs/en/quickstart)选择对应安装方式。

这些 CLI 也可以直接在项目目录启动 AI 对话。**只用复制提示词做进度汇报时，不必配置序程的 Codex 执行插件。**若希望在序程中启动或控制 Codex，另见下方可选接入说明。

## 个人配置

首次只需选择项目文件夹，不必填服务器地址或 API Key。在桌面左下角“外观”切换浅色、跟随系统或深色；手机布局在顶部选择外观。项目放在 Mac 文稿或桌面文件夹时，按系统提示允许序程访问该文件夹即可，无需开启完全磁盘访问。新对话的持久汇报规则、执行插件和手机连接均可稍后按需启用。

## 第一个项目

以下流程适用于已安装的 Mac 应用；源码 Web 版也可以使用，手动输入项目文件夹的完整路径。

### 1. 选择 AI 正在使用的项目文件夹

在序程侧栏点击“新建”，选择代码所在的真实文件夹。项目名称会从目录名自动填写，可以修改；项目目标是选填的。点击“继续接入”后，序程会打开“项目接入”。如果该目录已经关联了项目，序程会打开原项目并保留已有任务。

![新建项目并选择本地文件夹](docs/assets/onboarding/create-project.png)

*图中为隔离演示目录。请选 AI 实际读写的同一个目录；不要照抄示例路径。*

基础文件接入无需先配置 AI 执行插件。序程会在项目目录准备 `.taskboard/REPORTING.md`、背景与任务快照；这些是序程生成的文件，不要直接编辑 `tasks.json` 或 `CONTEXT.md` 来更新看板。

### 2. 把汇报提示发给当前 AI

在“项目接入”确认路径正确，等页面准备好提示词后点“复制提示词”，然后粘贴到你正在使用这个项目的 Codex、Claude 或其他 AI 对话中。AI 需要能读写这个本地文件夹；只有聊天能力、没有本地文件权限的网页 AI，不能靠粘贴提示词直接接入。序程不会替你启动 AI。提示词会要求 AI 先读取项目汇报说明、项目背景和当前任务，再按真实进度汇报。

如果项目还没有任务，可以先告诉 AI 你要达成什么结果和如何判断完成，让它按项目说明创建任务；也可以在序程的任务清单中手动新建任务。比如在一个新文件夹里粘贴下面的请求，体验一个无需业务 API 或数据库的本地小项目：

> 请先阅读项目中的汇报说明，为这个本地文件扩展名统计工具建立 3 项任务：统计文件类型数量、预览统计结果、补充同名文件的处理测试。不要移动、覆盖或删除文件。为每项写清目标和验收标准；先实现第一项并运行实际可用的测试。按项目汇报说明记录进度、证据和下一步；没有运行的检查不要写成通过。

先写清目标和验收标准，之后的汇报才能对应到明确工作。

### 3. 确认汇报已收到并打开对应任务

AI 根据说明把进度事件写进项目目录的 `.taskboard/inbox/`。序程读取事件后处理，把结果回执写进 `.taskboard/receipts/`，再更新看板。接入页显示“已收到汇报”及最近接收时间时，代表这条进度已进入看板；点“查看对应任务”可核对内容。只看到 inbox 新文件还不代表接收成功。

![文件汇报进入看板](docs/assets/onboarding/progress-running.png)

*截图演示数据为隔离创建的虚构文件项目，不代表任意 AI 对话或任意项目都已自动接入。*

AI 可以创建任务、更新进度、提交证据。事件被拒绝时，展开技术详情，并让 AI 先读取失败原因和最新任务，再修正后提交；不要盲目重复旧事件。项目中的汇报说明若被你修改，序程会保留原内容，并提供可展开的内容对比。

### 4. 检查证据并人工验收

AI 提交“完成”或测试证据，表示工作已交付待检查，不代表验收通过。打开对应任务，核对原始目标、实现、下一步、证据和每条验收标准。你也可以自己添加实际测试报告或产物引用。

![任务进度和实现说明示例](docs/assets/onboarding/task-result.png)

![任务证据示例](docs/assets/onboarding/evidence.png)

*截图中的任务与测试结果属于隔离演示数据。*

确认当前结果符合要求、证据可核对且没有待解决问题后，由你提交“通过”人工验收；发现缺项则选择“未通过”并写明问题。测试验证状态与人工验收是两条独立记录，验证待办勾选也不会代替整项验收。

### 5. 在新对话里继续

新开 AI 对话时，仍使用同一个项目目录，并让 AI 阅读 `.taskboard/REPORTING.md`、`.taskboard/CONTEXT.md` 和 `.taskboard/tasks.json`。这些文件帮助恢复项目目标、已有任务、当前进度和下一步，不包含所有旧聊天原文。

你还可以展开“让新对话沿用汇报规则（可选）”，预览后明确点击，将一小段说明追加到 Codex 的 `AGENTS.md` 或 Claude 的 `CLAUDE.md`。序程会保留文件中原有内容；该说明只是提醒，不能保证每种 AI 工具都会遵循。序程不会自动修改这些规则文件。

## 任务如何完成

| 状态／记录 | 含义 |
| --- | --- |
| 未开始、进行中、受阻 | 任务当前进度；受阻时应说明原因和下一步。 |
| 已提交／待验收 | AI 已报告交付，等待你核对。 |
| 测试验证 | 记录测试覆盖哪些标准、结果和证据；它不会自动替代人工验收。 |
| 人工验收通过 | 你确认当前提交满足目标、标准和证据要求，任务才计入已完成。 |

项目完成率按验收状态统计，不按 AI 报告的“完成百分比”估算。任务目标或实现内容改变后，旧的验证或验收结论可能需要重做。

## 可选接入

这些路径与本地文件汇报彼此独立，可以之后再设置。

- **Codex 执行插件：**如果希望在序程中创建或控制 Codex 执行会话，需要在本机安装并登录 Codex CLI，在“接入与插件”填写本机 Python 与 Codex 路径、检查连接并启用插件，再按任务绑定正确的项目目录和执行会话。复制汇报提示词不会自动启动它。各版本及额度周期的真实执行验证范围有限，不能据此认为所有执行场景已验收。
- **手机和 Hub：**手机跨网络查看需要一个已部署并可访问的 HTTPS Hub。项目电脑登录该 Hub 并明确选择要同步的项目；手机浏览器再使用对应账号登录。Hub 账号不是本地文件汇报的前提，源码 Web 服务的 `127.0.0.1` 也不会自动变成公网服务。当前没有官方托管服务。步骤见[账号接入指南](docs/account-setup.md)和[Hub 部署指南](docs/deployment.md)。
- **SSH 与终端：**独立于 AI 文件汇报及 Codex 执行插件。需要单独配置 SSH 主机和相应权限；桌面、Hub 与各平台的验证范围不同，详见[SSH 终端说明](docs/ssh-terminal.zh-CN.md)。

## 隐私和使用边界

本地模式下，序程在当前电脑保存任务和历史，不需要把项目同步到云端。若主动连接 Hub，项目快照、任务状态和明确授权的远程操作会发送到你指定的 Hub；查看对话或执行任务时也要遵循相应权限。不要在任务、证据或对话中保存密码、令牌、私钥等秘密。

序程只按 AI 提交的记录更新任务，不读取所有聊天、不保证 AI 写入内容真实，也不自动证明软件正确。提交证据、测试通过和人工验收是不同步骤。

## 文档

- [新电脑安装与图文上手指南](docs/new-computer-guide.zh-CN.md)
- [日常使用与任务验收](docs/getting-started.md)
- [Android 安装、iPhone 网页与首次连接](docs/mobile-install.zh-CN.md)
- [账号、手机和设备配对](docs/account-setup.md)
- [Windows 编译安装](docs/build-windows.zh-CN.md) · [Ubuntu 编译安装](docs/build-ubuntu.zh-CN.md)
- [桌面构建与数据位置](docs/desktop-build.md)
- [SSH 终端](docs/ssh-terminal.zh-CN.md)
- [变更记录](CHANGELOG.md)
- [公开源码仓库](https://github.com/Autumnpoem/seqivo-public) · [报告问题](https://github.com/Autumnpoem/seqivo-public/issues) · [下载发布版](https://github.com/Autumnpoem/seqivo-public/releases/latest)

## 许可与第三方组件

序程源码按 [PolyForm Noncommercial 1.0.0](LICENSE) 授权。它允许许可文本规定范围内的个人非商业使用，**禁止商业使用**，并不是 OSI 定义的开源许可证。使用前请阅读完整许可条款；本 README 的概括不能替代许可原文。公开源码不等于可以商业部署、售卖或提供商业服务。

第三方依赖、内含代码和插件继续受各自原许可证约束；本项目许可不会替代或改写它们。来源、MPL 组件的源码获取方式与许可索引见 [NOTICE.md](NOTICE.md)，各组件目录保留原许可。
