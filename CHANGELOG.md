# 版本记录 / Changelog

## v0.4.1-r2 — Android distribution and platform build guides — 2026-10-31

- Publish a signed Android release APK: app version 0.4.1, versionCode 15; debugging disabled, no preset Hub or test CA.
- Include LICENSE and NOTICE in the APK; add a repeatable local signing/build script. The publisher key remains outside the repository.
- Add Chinese/English Android and iPhone web setup instructions and complete Windows NSIS / Ubuntu deb-AppImage self-build guides.
- Reuse the existing macOS arm64 ZIP unchanged. No Windows/Ubuntu binary or native iOS IPA is included.
- The new APK is not compatible with in-place upgrades from earlier debug-signed test APKs. Native fresh-install/device acceptance remains separate from build and artifact checks.

## 0.4.1 public distribution — 2026-10-31

- Publish the current source as a clean snapshot under PolyForm Noncommercial 1.0.0; third-party licenses remain unchanged.
- Add illustrated Chinese and English installation, personal configuration and first-project walkthroughs.
- Include own and third-party license notices in the macOS Apple Silicon package; retain the app version 0.4.1.
- Keep the original development history private; do not publish personal paths, service addresses, credentials or local test data.
- Other native platforms and unfinished scenario-specific acceptance remain explicitly unverified.

## 0.4.1 — 本地项目接入

隐私修订 `v0.4.1-r1`：重新打包时去除主程序和终端依赖中的个人编译路径，移除验证脚本写死的本机路径；应用版本仍为 0.4.1。

- 新增“项目接入”：选择文件夹、复制 AI 汇报提示、查看真实接收结果。
- 项目名称根据文件夹自动填写，项目目标改为选填；重复接入会打开原项目，保留任务和设置。
- 常见失败显示具体下一步，原始错误折叠查看；收到进度后可直接打开对应任务。
- 未修改的生成说明可自动更新；自定义内容保留，并可对照新版说明。
- 可预览并主动添加 Codex / Claude 项目汇报规则，保留原规则；新对话仍需使用同一项目目录。
- 修复临时汇报文件重命名时的误报、无变化快照反复写入，以及接入错误被轮询覆盖的问题。
- 本次 Release 提供 macOS Apple Silicon 本地签名包；不是 Apple Developer ID 签名或公证版本。其他系统的安装包与完整验收仍单独推进。

Local onboarding now connects an existing project folder, generates reporting instructions, and shows actual receipts with a link to the task. Names are inferred from folders and goals are optional. Generated instructions upgrade only when untouched; custom instructions and existing project rules are preserved. Optional Codex/Claude rule installation requires an explicit action. The release contains a locally signed macOS Apple Silicon package; it is not Apple Developer ID signed or notarized, and does not certify every product feature or platform.

## 0.4.0 — P0 私有验收版

- 默认首页集中显示待决策、待验收、阻塞和未知结果，支持任务深链、稍后处理与历史。
- 修复 Mac 桌面“需要我处理”页面无法下滑的问题；内容较多时可滚到最后一项及其操作按钮。
- 新增持久收件箱、明确决策请求、人工答复及补充信息；MCP 和文件汇报可请求决策。
- 手机操作使用对象修订号和幂等命令，断网禁写，未知结果保留并核对原回执。
- 修复旧决策被明确拒绝后，迟到的回执查询把提示误改为“结果未知”的竞态；真正未知的操作继续保留防重发保护。
- Mac 退出时及时关闭未收完请求体的连接，并继续等待已派发操作完成；新增关闭阶段诊断。历史 25 秒超时的完整触发原因仍待定位。
- 保留已知人工验收历史，升级/回滚在旧数据副本演练；私人详情不进入远程投影。
- 实体手机验收独立记录；终端接管、运行预览和跨平台扩展仍按[阶段计划](docs/inbox-and-delivery-plan.md)排队。

Recent fixes: late receipt reads no longer overwrite a confirmed stale-decision rejection; genuinely unknown operations remain fenced. macOS shutdown now closes incomplete HTTP requests while draining dispatched work and records shutdown stages. The original intermittent 25-second timeout remains under investigation.

The desktop inbox now scrolls to its last item and action buttons. See the [scrolling regression record](docs/inbox-scroll-validation.md).


[简体中文介绍](README.md) · [English overview](README.en.md)

## 0.2.3 — 2026-09-26

### 中文

- 验证待办的圆圈支持点击或键盘切换“未验证 / 已办结”，填充状态和完成数量持久保存。
- 子项人工办结可撤销，保持整项测试结论、证据和验收不变；旧计划及保存冲突明确提示。
- 备份、交接背景和远程只读视图保留办结状态。

### English

- Verification circles now toggle incomplete/completed by click or keyboard, with persisted state and completion counts.
- Manual item completion is reversible and independent of task tests, evidence, and acceptance; stale plans and write conflicts are explicit.
- Backups, handoff context, and remote read-only views preserve completion state.

## 0.2.2 — 2026-09-26

### 中文

- 任务详情新增结构化验证待办，展示待验证/待实现/待确认、操作步骤、通过标准和当前条件。
- 支持只有计划、尚未执行的验证记录；旧版本计划与旧记录缺失的方法会明确提示。
- 计划随备份、项目交接和远程投影维护；待办详情默认仅本地显示，逐项明确共享后才传至已授权远程设备。
- 为 12 项未完整验证需求整理 32 条具体待办，保持原始标准和已有人工验收结果。
- 修复插件暂时不可用时任务看板刷新失败的问题。

详见[验证待办](docs/verification-backlog.md)。这是私有开发版，没有公开 Release。

### English

- Added structured verification todos with testing/implementation/decision types, procedures, pass conditions, and prerequisites.
- Added plan-only unverified records and explicit handling of stale plans or missing legacy procedures.
- Preserved plans in backups and project context; remote details require explicit per-item sharing and otherwise remain local.
- Documented 32 pending items across 12 incomplete requirements while preserving original criteria and human acceptance.
- Fixed board refresh when an execution plugin is temporarily unavailable.

See [verification todos](docs/verification-backlog.md). This is a private development build, not a public Release.

## 0.2.1 — 2026-09-26

### 中文

本条为当前私有开发版的功能与验证快照，尚无公开 Release。

- **序程 · Seqivo** 品牌、图标与浅色/深色桌面界面。
- 本地任务清单、版本化证据、交付偏差、人工验收与独立测试验证状态。
- 文件与 MCP 汇报、项目交接、历史记录、备份和恢复。
- Codex 自动继续插件、可选 Claude/Cursor 适配器、角色与依赖协作计划。
- 自托管 Hub、设备配对和授权项目同步、手机浏览器查看与受控命令。
- 中英文 README、真实界面的示例截图、贡献与安全说明。

已记录本地自动化测试 124 项通过、Chromium/WebKit 共 8 组端到端流程通过，并验证隔离 Codex 真实回合与 macOS arm64 开发包。原始需求中 11 项完整验证且已确认验收、11 项部分验证、1 项尚未实现。

Windows/Ubuntu 实机、真实五小时额度恢复、公网 Hub 与实体手机仍待验证；Claude/Cursor 仅完成测试替身的协议验证。云端 CI 当前暂停。详见[测试矩阵](docs/release-test-matrix.md)与[机器可读结果](docs/release-test-results.json)。

### English

This entry is a feature and validation snapshot of the current private development build. There is no public Release.

- **Seqivo · 序程** branding, icons, and light/dark desktop UI.
- Local task tracking, versioned evidence, delivery issues, human acceptance, and independent test-verification status.
- File and MCP reporting, project handoff, event history, backup, and restore.
- Codex Auto Continue plugin, optional Claude/Cursor adapters, and role/dependency workflow plans.
- Self-hosted Hub, device pairing, scoped project sync, mobile browser access, and authorized commands.
- Chinese and English READMEs, real UI screenshots with sample data, and contribution/security guidance.

Recorded local checks include 124 passing automated tests, eight Chromium/WebKit end-to-end runs, isolated real Codex turns, and the macOS arm64 development build. Of the original requirements, 11 are fully verified and accepted, 11 are partially verified, and one is not implemented.

Windows/Ubuntu device testing, a real five-hour quota recovery cycle, public Hub deployment, and physical mobile devices remain unverified. Claude/Cursor validation uses protocol test doubles only. Cloud CI is paused. See the [test matrix](docs/release-test-matrix.md) and [machine-readable results](docs/release-test-results.json).
