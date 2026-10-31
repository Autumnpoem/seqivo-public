# v0.4.0 收件箱验证记录

日期：2026-10-11 至 2026-10-13。基线：`b256038`（v0.3.0）。本轮为私有验收版，工程实现不等于 P0 已获用户放行。机器可读记录见 [inbox-validation-results.json](inbox-validation-results.json)。

## 本轮结果

| 范围 | 结果与证据边界 |
| --- | --- |
| 自动化 | 10 月 13 日最新完整后端套件 `node --test tests/*.test.mjs`：229 通过、0 失败、0 跳过；覆盖原有功能、收件对象、持久回放、CAS、授权、隐私、未知结果核实及迟到回执。此前 215 和 191 项记录保留。 |
| 浏览器 | 初始 9 组通过；本轮追加两种浏览器的原操作核实，并复跑断网、收件箱、账号对话及 9 项丢回执场景。具体范围见下文；使用隔离环境与协议替身，不代替实体手机。 |
| 真实 Codex | 隔离的本地 Core/Hub 与手机视口浏览器驱动真实 Codex，将临时文件从 1 改为 2，再在同一会话改为 3；输出返回、无重复任务、人工验收仍未通过，正常退出。不是实体手机或公网真实执行测试。 |
| 旧数据与恢复 | 只读备份源数据库，在副本保留 25 项原任务与 11 项人工验收；原字段一致。已知验收补入历史、重复启动、journal 回放、精确备份恢复通过。 |
| macOS arm64 | 历史上一次退出耗尽 25 秒并需核对后人工恢复，原触发点仍未知。现已修复独立复现的“不完整 HTTP 请求体拖住退出”路径；真实 Mac 在该输入下正常退出、释放锁并直接重开。后续界面修复版也正常退出重开，重启时 58 项任务与 13 条通过记录及修订保留，活跃执行为 0，Hub 同步，无需人工恢复保护锁。 |
| 真机旧决定冲突 | Android 与 iPhone 均以受控旧读取结果触发真实 `POST 409 REVISION_CONFLICT`，最终页面正确显示“本次未提交”并在轮询后保持；原绿色决定保留且新增命令为 0。iPhone 初测曾被迟到回执查询误报“结果未知”，修复后的两台真机复测均通过。 |
| 当前 P0 验证 | P0-02 手机流程已验证、待办清零；P0-01 部分验证，只剩历史 25 秒退出原因待查。四项看板记录按证据有意更新，其余 54 项修订保持；58 项任务、13 条历史人工通过记录保留。Android 与 P0-02 因说明版本更新显示 `stale`，两项从未有人提交人工验收，不代表 13 条历史通过记录丢失。整项产品人工放行未授予。 |
| 私用 Hub | 升级前备份保留；部署 0.4.0 后 HTTPS 证书验证、安全响应头、未登录访问拒绝、已授权收件箱读取及桌面计划同步通过。Hub、Nginx、备份与续期定时器运行，UFW 开启。地址不进入仓库。 |
| 独立安全复审 | 初始五项问题已修复；原操作核实的后续复审又修复暂停误解除未知限制、多待处理回执轮询中止。独立复跑 42 项后端检查及 Chromium 核实流程通过，未发现此范围内剩余已确认阻断项。审查不是安全无漏洞保证。 |

## 实体 iPhone 补测与输入框修复

在 iPhone 15 的 Safari、Wi-Fi 网络上，通过 Apple iPhone Mirroring 实际操作了私用 HTTPS 网页：决策只保存一次；手机新建真实 Codex 对话把可丢弃文件从 1 改为 2，再在同一任务和会话改为 3；手机可查看工具输出。执行期间发出暂停后，手机、本机和 Hub 均显示已暂停，执行租约清空且暂停回执已确认。此结果不证明全部 OS 子进程停止，也不开放终端接管。

实机发现旧版输入框聚焦后会放大并横向裁切。移动端可编辑控件现至少使用 16px 字号，保留用户缩放与桌面字号；Chromium/WebKit 样式检查、两种浏览器的收件箱和账号对话回归通过。修复已更新私用 Hub，iPhone 重复同一聚焦动作不再裁切，桌面包重新构建并正常重启，保留 45 项任务和原有 11 项人工验收。浅色、深色与恢复跟随系统、任务原始要求查看也已实测。

截至后续补测，iPhone 的退出重登、验收草稿断网恢复、缺证据拒绝及补证据后通过/退回已分别验证。后续已补验收、决策及已有对话断网、独立锁屏恢复和限定范围的大字号。两台真机均确认跨端更新使旧决策表单自动失效；后续以受控旧读取结果分别触发精确旧决策 POST 409。iPhone 初测界面反馈失败，修复后两台真机均复测通过。具体结果见下文。Android 的核心流程结果见下一节。镜像工具的批量输入丢字不算产品输入缺陷；本次实际提交的指令使用逐键输入并逐条核对。原始记录见本机 `design/qa/v0.4/iphone-physical-results.json` 及其列出的证据文件。

### iPhone 验收草稿的断网与恢复补测

2026-10-12，在可丢弃卡片中打开人工验收草稿后，用户断开移动数据及当前 Wi-Fi 网络，保留用于镜像的无线功能。镜像重连后，“提交结论”最初仍可用，稍后才出现中文网络错误并禁用；准确延迟与真机浏览器的网络标志未采集。没有在最初可用的时段尝试提交。禁用后点击没有提交，后台 10 项测试任务的修订号和验收、测试文件均未变化，新增命令为 0。

恢复网络后，原草稿仍可见，错误提示消失，按钮恢复可用；后台再次确认零新增命令、任务和文件未变化。此结果只证明本次草稿没有自动补交，不代表所有离线入口通过。连接识别延迟记录为 **IPHONE-CONNECTIVITY-01**，已在 iPhone 与 P0-02 的验证待办中列出复测步骤；两项仍为部分验证。

隔离 Chromium/WebKit 基线进一步复现：保持浏览器网络标志为在线，同时挂起状态读取，5.5 秒观察期内验收按钮仍可用，后续轮询共用同一悬挂请求；让请求明确失败后才禁用。此基线没有发送写请求，也不能用来推定真机的精确触发路径。代码调查确认状态读取无截止时间、页面恢复时未先重新确认连接；修复与复测见下文「iPhone 连接确认」。原始证据：本机 `design/qa/v0.4/iphone-review-{offline-observed,reconnected}.json`、`iphone-review-commands-{offline,reconnected}.json`、`iphone-connectivity/`。

### iPhone 退出与重新登录

同日，用户在 iPhone 上退出账号并刷新，确认“只显示登录页”；服务器只读比对确认原会话已撤销，未新增会话。用户随后自行输入凭据重新登录，确认“已登录、任务仍在”；服务器只新增一个有效会话，原撤销记录保留。测试项目仍为 10 项任务，人工验收与测试文件未变，没有新增执行。该独立待办已办结，iPhone 整项仍为部分验证。

此轮使用用户实际点按与服务器只读证据：镜像在恢复网络后不能可靠操作弹窗或 Safari 控件，用户亲手点“取消”可以正常关闭，因此没有把镜像注入失败记为网页按钮缺陷。没有读取、记录或修改用户密码与令牌。证据：本机 `design/qa/v0.4/iphone-{logout-observed,relogin-observed,relogin-board}.json`。

## 实体 Android 蜂窝网络补测

在 iQOO Neo10（Android 16、Chrome 154.0.8037.126）的普通标签页中，用户自行登录后，通过官方 scrcpy 镜像的键盘与粘贴操作完成测试。状态栏显示 5G、无 Wi-Fi：网络决策只保存一次；手机新建真实 Codex 对话将可丢弃文件从 3 改为 4，再在同一任务和会话改为 5。两轮工具输出与文件读回均可在手机查看，本机核对只有一个新任务。空标题会阻止创建并定位必填字段。任务详情已能查看原始要求与同步后的“部分验证”：四组剩余待办分别列出操作步骤和通过标准。

运行中从手机发出暂停后，手机、本机和 Hub 均显示已暂停，活跃执行租约为零，暂停回执已上报确认；文件仍为 5。这仅验证现有远程暂停流程，不证明全部 OS 子进程停止。原始证据保存在本机 `design/qa/v0.4/android-physical-results.json` 及其列出的记录中。

恢复蜂窝网络并刷新后，登录保留，文件仍为 5，决策仍只有一条，没有重复任务或新增执行。浅色、深色与恢复跟随系统也已实测。断网修复后的已观察入口与恢复比对结果见下文；此时锁屏等项目尚未验证，后续锁屏结果见独立记录。其余断网入口、退出重登、验收/退回、旧决策冲突、系统大字号与实际触屏命中仍逐项待验证。镜像指针控制不可靠，本轮使用键盘完成操作，因此不将触屏命中体验标为通过。原受保护 Chrome 画面未调整安全设置；用户自行打开普通标签页后恢复可见。密码由用户直接输入，未读取或修改凭据。

### Android 断网测试发现的问题

用户关闭手机 Wi-Fi 和移动数据后，Chrome 明确显示“未连接到互联网”，任务详情仍可读，但“编辑任务”仍启用且能打开编辑表单。没有提交保存，也没有改动任务数据。已把这一实际失败写入看板的断网验证待办，客户端离线保护修复与复测结果将单独记录；不能把此前模拟目标电脑离线的通过结果当作手机断网通过。

另在隔离 Core/Hub 中复现了任务编辑回执丢失：服务器实际接收并完成更新后，仅丢弃返回浏览器的响应。旧前端没有保存原命令编号，刷新后再次提交产生了新编号，服务器也再次接收。这是独立的浏览器回执问题，不是实体手机重复执行证据。基线记录保留在本机 `design/qa/v0.4/receipt-loss/baseline-reproduced.json`；修复必须验证请求发出前保存编号、重载后查询同一回执、未确认时阻止重复操作，以及查询过程不重放写请求。

### 断网与丢回执修复后的工程检查

手机断网时，任务编辑、人工验收、收件事项和远程对话写操作现在共用连接保护；恢复网络后必须成功读取最新状态才重新启用。操作编号在发送前持久保存，刷新、退出重登或切换页面后只查询原回执，不自动重发。账号或配对令牌不同的记录隔离；待处理记录不保存令牌原文。较早请求的迟到结果不会覆盖新登录或新连接状态。

本次前端修正后，Chromium / WebKit 的断网、账号对话、收件箱三组受影响流程均通过。额外的 Chromium 丢回执测试通过 9 个场景，覆盖编辑、新建对话、续发、暂停、重载、登录竞态及不同令牌隔离；这里使用隔离 Hub 和假提供方，没有再次调用真实 AI。191 项完整测试为此前工程基线，本次未重复运行。

新版 macOS arm64 包构建通过；私用网页已部署同一前端，实际资源匹配，HTTPS 与未登录访问拒绝检查通过，Hub、Nginx 和 UFW 均保持运行。新版桌面已正常退出并重启，旧进程和本地端口关闭，46 项任务及原有 11 项人工验收保留，首页的新进展说明可见且服务器同步恢复。Android 修复后已完成下节列出的真机断网与恢复范围，其他入口不能用浏览器模拟代替。独立复审未发现新的未授权写入或跨账号回执泄露；此时未知结果恢复仍是待办，后续实现和复审结果见「原操作核实与安全恢复」。

本轮日志：`browser/{chromium,webkit}-mobile-offline-final.log`、`browser/{chromium,webkit}-offline-accounts-final.log`、`browser/{chromium,webkit}-inbox-final.log`、`receipt-scope-final/result.json`、`native-offline-build.log`、`native-offline-restart.json`、`native-offline-quit.json`、`deploy-mobile-offline.log` 和 `review/mobile-offline-review.md`，均保存在本机 `design/qa/v0.4/`。

### Android 修复后真机复测

用户再次关闭 iQOO 的 Wi-Fi 与移动数据后，Chrome 显示“未连接到互联网”。加载过的任务内容仍可读；编辑任务、添加证据、提交结果、收件箱补充信息/稍后处理及新建对话均禁用。原先聚焦的编辑按钮在断网后按回车未打开表单，Tab 跳过禁用的写操作。恢复蜂窝网络后，离线提示消失，新建对话按钮恢复可用。后台比对测试项目的 4 项任务修订号和人工验收完全未变，文件仍为 5，无新增执行或重复任务。

这次未在真机上强制发送离线 POST，也未逐项覆盖已打开的表单、已有对话发送、决策回答和人工验收提交；这些与锁屏恢复仍列为明确待办。浏览器回归覆盖更广，不扩大本次真机结论。原失败记录继续保留。证据：`android-offline-retest-before.json`、`android-offline-retest-observed.json`、`android-offline-retest-after.json`、`android-offline-board.json`。

实机还暴露了英文网络报错。看板、收件箱和对话共用的显示文案已改成“暂时连接不上服务器。恢复连接后，请先核对任务状态。”仅改变错误显示，不改变命令和断网控制逻辑。最终 Chromium/WebKit 断网回归均通过，新增断言确认不会显示浏览器英文网络诊断；macOS 包构建、正常退出重启及私用网页部署通过，46 项任务与 11 项原验收保留。真机随后刷新最终网页、保留登录，并显示更新后的卡片；未再断网重复验证这条中文报错。默认 Playwright Chromium 未安装导致一次启动失败，明确改用本机已安装 Chrome 后通过，未下载或替换浏览器。

最终修正文案日志：`browser/chromium-network-copy-final-2.log`、`browser/webkit-network-copy-final-2.log`、`native-network-copy-final-build.log`、`native-network-copy-restart.json`、`native-network-copy-quit.json`、`deploy-network-copy.log`。上文 191 项完整套件仍是此前基线，本次没有重新宣称全量测试已跑过。

## 原操作核实与安全恢复

新增「核实这次操作」入口，覆盖待处理收件箱、任务详情和对话页。它按原操作编号读取电脑的持久记录，区分已执行、明确未执行和仍未知，不重放原修改。明确回执和执行前标记才能解除对应限制；记录缺失、执行中崩溃或只创建了会话但未确认发送，仍保持未知。同任务的未决写入及项目内未确认的新建对话可阻止双端重复操作。暂停成功不会把原先未知的执行结果改成已确认。

本轮完整测试 **215 通过、0 失败、0 跳过**。新增核实流程在 Chromium 和 WebKit 均通过，覆盖三个入口、320/390 宽度、刷新、账号切换、退出竞态、多条待核实回执以及断网重连。收件箱、账号对话和断网的两种浏览器回归通过；9 项既有丢回执场景通过。独立审查复跑 **42 项后端测试**及 Chromium 核实流程，未发现此范围内剩余已确认阻断项。浏览器场景使用隔离 Core/Hub 和协议替身，本轮没有用真实 AI 制造未知结果，也未将其计作实体手机核实按钮验收。

测试发现并修复多条待核实操作中后续条目停止轮询的问题；已确认服务器结果也能结束本地仍标为发送中的记录。早期测试夹具缺少收件事项/构建目录、选择器命中隐藏导航的问题单独保留，不当作产品缺陷。原始证据在本机 `design/qa/v0.4/unknown-recovery-full-final.log`、`remote-recovery/`、`remote-recovery-webkit/`、`receipt-recovery-regression/`、`recovery-{offline,accounts}-{chromium,webkit}.log` 和 `review/unknown-recovery-review.md`。

同版 macOS 包构建并正常重启，旧进程及端口已关闭，**46 项任务与 11 项原人工验收**保留。私用网页资源与构建匹配，HTTPS 证书、安全响应头、未登录请求拒绝及同步检查通过，UFW 保持启用。部署前实际运行备份时发现服务器缺少既有备份脚本，部署在替换应用前停止；补齐脚本并纳入更新包后，更新前后备份均成功，备份与证书定时器正常。没有修改认证、TLS 或防火墙规则。升级记录：`native-recovery-{quit,restart}.json`、`deploy-recovery-final.log`、`production-final.json`。

### Android 锁屏恢复

用户在 iQOO 上锁屏约 10 秒再解锁。镜像确认网页仍保持登录、原测试项目可见且键盘操作有效；本机与 Hub 比对 4 项测试任务的修订号和人工验收均未变，文件仍为 5，无新增执行或重复任务。此项独立通过；编辑表单随后补测如下，已有对话、决策和验收的其余离线入口仍待逐项验证。证据：`android-recovery-retest-before.json`、`android-recovery-retest-after.json`。

### Android 已打开编辑表单的断网保护

联网时在编辑表单填写有效测试草稿，保持表单打开，由用户关闭 Wi-Fi 和移动数据。Chrome 显示离线，保存按钮禁用；在原保存位置按回车没有提交。恢复蜂窝网络后，草稿仍可见、保存恢复可用，没有自动提交。随后取消草稿。本机与 Hub 比对 4 项测试任务的修订号、人工验收和文件均未改变，无新增执行或重复任务。

此项已作为独立待办办结并同步，任务整体仍为部分验证。没有从真机强制发送离线 POST，也未把本项扩大为已有对话、决策和人工验收的断网提交通过。证据：`android-open-form-offline.json`、`android-open-form-retest-before.json`、`android-open-form-retest-after.json`、`android-open-form-board.json`。

### Android 已有对话的断网保护

联网时打开已有的 Android 测试对话，填写测试草稿但不发送。用户关闭 Wi-Fi 与移动数据后，发送按钮禁用，原发送位置按回车没有提交；中文离线提示可见。恢复蜂窝网络后草稿仍在，没有自动补发，随后刷新清除草稿。测试项目的 4 项任务、文件与执行状态不变；服务器只读查询确认从准备草稿起新增命令为 **0**。此项单独办结，决策和人工验收的离线提交仍待实测。证据：`android-existing-conversation-{offline,board}.json`、`android-existing-conversation-retest-{before,after}.json`、`android-existing-conversation-commands-{offline,reconnected}.json`。

### Android 决策的断网保护与跨端更新

在可丢弃项目新增决策、验收两张专用测试卡片（项目共 6 项任务，不绑定或启动 AI）。手机先选择蓝色，尚未提交；用户断开 Wi-Fi 和移动数据后，“提交回答”禁用，原按钮位置按回车没有提交。恢复蜂窝网络后选项保留，没有自动补交。前后 6 项测试任务的修订号和验收状态不变，决策仍未答复，测试文件仍为 5；服务器新增命令为 **0**。这项断网检查已单独办结。证据：`android-decision-{offline,reconnected}.json`、`android-decision-commands-{offline,reconnected}.json`、`android-decision-offline-board.json`。

随后在电脑端为同一测试决策保存绿色。手机刷新后撤下蓝色草稿，该卡片移入“已处理”；后台只有一条绿色答复，没有旧草稿覆盖。这一轮只验证了跨端更新后的界面失效处理，当时未在真机触发 409 提交冲突；后续受控精确 409 另见下文。检查还发现已处理卡片仍提示“等待选择”，记录为 HISTORY-01 文案问题；现已修复，已处理卡片显示“决策记录 / 历史状态”，只保留查看入口。双浏览器检查通过，Android 也已观察到新文案。证据：`android-decision-other-end.json`、`android-decision-refresh-conflict.json`。

### Android 人工验收的断网保护与拒绝反馈

手机打开专用测试卡片的验收弹窗，填写说明但不提交。断网后“提交结论”禁用，原按钮位置按回车没有提交；恢复蜂窝网络后草稿保留，没有自动补交。6 项测试任务状态、文件和验收记录不变，服务器新增命令为 **0**，该项已办结。证据：`android-review-{offline,reconnected}.json`、`android-review-commands-{offline,reconnected}.json`、`android-review-offline-board.json`。

随后联网尝试通过一张尚无证据的测试卡片。后端没有通过验收，任务仍为修订 2、未验收、零证据和零验收历史；但手机将明确的业务拒绝显示成“结果未知”，并阻止继续补充证据。这是新发现的 REVIEW-REJECTION-01 缺陷，相关 P0-03 测试状态已从通过改为失败，原人工验收结论不变。修复和真机复测完成前不能放行。旧回执已丢失拒绝原因，不凭当前任务快照伪造未执行证明。证据：`android-review-rejection-{local,hub}.json`、`review-rejection-board.json`。

### 缺证据拒绝的修复与真机复测

REVIEW-REJECTION-01 已修复并部署。只有四类明确的验收前置拒绝、且本地事务成功回滚，才返回对应原因；原命令、任务、项目、节点授权和原“通过”决定必须匹配。丢回执后只核查原命令，不重放。旧的未知命令缺少此证明，仍保持未知，不凭当前状态强行解锁。

Android 新建可丢弃卡片实测：零证据时提示“缺少当前版本的验收证据”，任务保持未验收，随后可以补证据。补充一条证据后通过验收，再选择未通过，分别只保存一条验收历史，并生成一个待处理问题。手机数量从 0/7 → 1/7 → 0/7，与本机和 Hub 一致；原 48 项任务的验收未变，原有 11 项已验收保留，文件仍为 5，无新增 AI 执行。这里只操作测试卡片，不代表产品人工验收。

215 项完整测试通过；验收拒绝及原命令核实在 Chromium/WebKit 的最终构建回归通过，独立安全复审复跑 39 项通过。新版 macOS 正常重启保留原 48 项任务，私用网页资源一致、HTTPS、未登录拒绝、备份完整性、服务与定时器、UFW 开启均检查通过。本机证据位于 `design/qa/v0.4/review-rejection/`。看板对应缺陷和验收流程待办已办结；P0-03 保持部分验证，正在补查开着验收草稿时交付版本发生变化的保护。

### 开窗期间版本变化：新增验收阻断

REVIEW-STALE-DIALOG-01 已在隔离 Chromium/WebKit 复现。打开版本 1 的验收草稿后，另一端更新交付并添加版本 2 的证据；旧界面提交时使用刷新后的修订号，实际 Core 将版本 2 标为通过，说明仍是旧版本草稿。后端直接拒绝旧修订号的检查有效，缺口在客户端没有固定开窗版本。这不是实体手机误验收真实项目的记录。

修复已为编辑、添加证据和人工验收绑定开窗时的任务、修订、内容版本及账号。更新后保留草稿并在弹窗内提示重新核对；按钮禁用，直接提交表单也被阻止，关闭再打开才能取新版本。收件箱入口固定明确目标，不会错误绑定之前选中的任务。Chromium/WebKit 的最终产物检查覆盖旧通过/未通过草稿、旧编辑及旧证据零写入、未变版本刷新和离线恢复保草稿、重开后正常提交；断网与焦点回归双引擎通过，独立复审未发现阻断问题。未改后端，无需重复已通过的 215 项后端套件。

Android 真机在第一版草稿中填写说明后，由本机更新第二版内容和证据。手机出现“任务内容或记录已更新”，提交禁用；原按钮位置按回车，服务器新增命令为 0，第二版没有被验收。关闭弹窗后实际查看第二版，重新打开填写新版说明，仅保存一次第二版验收。原任务验收均保留，文件仍为 5，无 AI 执行。只使用可丢弃卡片，没有验收产品。

用户已调大 iQOO 系统字体，亲手点开“添加证据”并取消，回复“能点到，字体已调大”；镜像观察收件卡片、任务详情与验收弹窗无横向裁切。具体字号数值未记录，不宣称所有极端字号或读屏模式通过。已将对应待办办结。Android 仍保留“旧决策提交的冲突响应”精确真机检查，iPhone 四组剩余待办也保留。

修复已部署到私用网页和 macOS 应用。首次重启检查赶在 Hub 启动期间，仅得到 connecting，未计为通过；连接完成后复查通过，保留 49 项原任务和 11 项原验收。最新资源和 HTTPS 访问控制核对通过。P0-03 工程测试恢复为已验证，人工验收仍未放行；P0-02 和 Android 整项保持部分验证。本机原始复现、最终双引擎日志、真机零命令/新版一次验收及看板记录位于 `design/qa/v0.4/review-stale-dialog/`。

### 弹窗焦点与核实提示

Android 镜像键盘操作发现，打开编辑弹窗后焦点仍会经过后面的页面。现在打开弹窗先聚焦关闭按钮，Tab/Shift+Tab 留在弹窗内，关闭后返回原按钮；后台刷新保留草稿，退出登录清除临时弹窗。Chromium 与 WebKit 的构建产物测试通过，独立焦点复审通过。审查另指出登录失效与开窗可能在同一次渲染发生，代码已统一清理未认证弹窗；该精确时序未单独复现，不将推导写作实测。

原操作核实回归还复现了一条提示被覆盖的问题：另一项仍未知的操作每次轮询都会覆盖“已确认未执行”的提示。现在未变化的回执不重复改写提示，原未知项仍保持限制。修复不改变回执权限、解除限制条件或命令发送。最终 Chromium/WebKit 核实流程通过；测试等待另一未知回执完整返回及界面处理后，再确认提示仍在、原未知任务仍受限。只在临时构建副本恢复旧提示逻辑的 WebKit 负控，确实在这条后置断言失败。

强化用例期间曾把“本地发送中记录”与“阻塞另一条回执”叠加，导致核实组件卸载、串行轮询被测试阻塞。隔离诊断确定为夹具组合问题，两种场景已拆开，发送中恢复覆盖保留；没有因此修改产品逻辑。相关证据：`notice-02-final-{chromium,webkit}.log`、`notice-02-negative-final.log`、`notice-02/investigation.md`、`review/notice-01-review.md`。

最终构建已更新私用网页及 macOS arm64 应用。正常退出后旧端口与进程关闭，重启保留 46 项任务、11 项原验收并恢复同步。部署资源字节与本地构建一致，HTTPS、安全响应头、未登录访问拒绝、备份完整性、续期定时器和 UFW 状态检查通过。Mac 与 iQOO 新版都实际验证了开窗聚焦关闭按钮、Shift+Tab/Tab 首尾循环、Escape 关闭并返回原按钮，没有保存测试数据。Android 使用镜像键盘，仍不代表实体触屏命中或系统大字号验收。证据：`review/dialog-focus-review.md`、`notice-01-dialog-focus-{chromium,webkit}.log`、`android-dialog-focus-final.json`、`native-dialog-focus-{quit,restart}.json`、`deploy-focus-notice-final.log`、`focus-notice-{backup-integrity,services-final}.log`。

### Android 退出与重新登录

在手机账号页退出后，看板被登录页替换；刷新仍要求登录。服务器只读比对会话创建与撤销时间，确认本次撤销 1 个原会话，未读取密码或令牌。用户在手机自行重新登录后，原项目、4 项手机测试任务和已有对话输出恢复；对话保持暂停。服务器确认新增 1 个有效登录会话，本机与 Hub 核对原 46 项任务及 11 项已通过的人工验收均保留，测试文件仍为 5，没有新增执行。退出和重新登录分别记录为已验证，整项手机验收仍为部分验证。证据：`android-auth-observed.json`、`android-logout-board.json`、`android-auth-relogin-verified.json`、`android-relogin-board.json`；会话时间原始记录只保留在本机忽略目录。

### iPhone 连接确认：工程修复与真机复测范围

IPHONE-CONNECTIVITY-01 的浏览器修复已通过工程回归。回到页面时先停用提交，再读取当前状态；浏览器 GET 使用 8 秒截止时间，包含响应体读取，失败时保留草稿。真正断网、重连或再次隐藏页面都会使旧读取失效；收到新的成功状态后才能继续。写请求没有新增超时或自动重放，未知命令仍保留原 ID 和限制。后台页面的计时受系统调度影响，8 秒不是实体手机在任何状态下的墙钟保证。

独立审查先复现了修复候选中的重连竞态：未决读取期间断网再联网，旧成功响应会重新启用提交。补齐每次网络变化的失效处理后，同一独立脚本确认发出了新 GET，单独释放旧响应仍不能提交。原有焦点用例还在两个浏览器中发现访问令牌重新登录后任务为空；原因是身份指纹就绪时复用了旧身份读取。现在按身份区分未决读取，身份就绪后重新获取状态，原测试未降低断言。

最终构建 `index-tM7ncMFz.js` 在 Chromium/WebKit 分别通过连接确认、弹窗焦点及重新登录、断网、旧版本草稿、原操作核实、账号对话和收件箱七组检查，共 14 组，均退出码 0。没有调用真实 AI。日志位于本机 `design/qa/v0.4/iphone-connectivity/final-v2-*.log`。工程结果与下述真机记录分别保留，不授予产品人工验收。

独立复审在该冻结产物中未发现本范围内的剩余阻断问题。私用网页已更新，资源字节与测试产物一致；HTTPS、安全响应头、未登录拒绝、服务与定时器、UFW 开启及备份完整性/所有者权限均通过。Mac 安装包构建通过，正常退出后旧端口与进程关闭。用户解锁电脑后启动新版，核对 52 项任务、12 项通过记录（含可丢弃测试卡片）全部保留，没有新增执行，恢复 Hub 同步；对应工程证据已写入看板。

修复后，用户在 iPhone 设置中关闭 Wi-Fi 总开关并确认移动数据关闭，等待约 10 秒后报告“提交保持灰色，有连接提示”。恢复网络后报告“已恢复、草稿仍在”，镜像也显示原草稿和恢复可用的提交按钮。后台两次核对均为零新增命令，10 项测试任务和文件不变；没有自动补交。此独立待办已办结。准确禁用延迟没有测量，也没有在这一轮尝试点击禁用按钮；其他离线入口、专门的锁屏恢复仍待验证。证据：本机 `iphone-connectivity/physical-{offline-v2-observed,reconnected-observed,board}.json`。

### iPhone 验收结果提示：修复与真机通过范围

用户在无证据的可丢弃卡片中提交“通过”，认为“意外通过了验收”。只读核对发现后台实际返回明确拒绝 `REVIEW_CURRENT_EVIDENCE_REQUIRED`，当时任务仍为修订 2、未验收、零证据、零验收历史。问题是提交排队后弹窗关闭，最终拒绝只在页面顶部提示，手机停留在详情底部时看不到。此问题记录为 **REVIEW-FEEDBACK-01**，原始事件不是后台错误通过。

等待、拒绝和确认结果现在显示在当前任务的操作旁。统一构建通过 19 组浏览器回归：九个流程分别跑 Chromium/WebKit，加上 Chromium 九场景丢回执套件。没有调用真实 AI，没有重跑未改动的后端套件。候选中的底部导航遮挡提示、同一命令已未知仍显示等待均已修正。缺失状态、错误编号和重新登录后的迟到回执不会被当作成功；旧拒绝测试仅将两处选择器限定到任务提示，原准确文案与行为断言保留。独立复审未发现本范围内的阻断问题。

通过 CUA 自主操作实体 iPhone 15 Safari，实际完成：无证据提交通过被拒绝；手机补一条测试证据；通过、退回各保存一次；有未解决问题时再次请求通过被拒绝。两种拒绝均在详情底部显示原因和下一步，位于固定导航上方。后台合计恰好五条命令，最终测试卡片修订 5、未通过、一条证据、两条本地验收历史、一条待处理问题；其他任务验收状态不变，测试文件仍为 5，没有新增 AI 执行。这是可丢弃卡片流程验收，不授予产品整体人工验收。

真机测试还发现旧等待文案“当前还没有通过验收”可能与之前的通过记录冲突。仅将两处改为“本次结论尚未确认”，重新构建并通过两种浏览器的反馈流程。最终产物 `index-CsgPfagk.js` 已更新私用网页与 Mac 应用；真机直接观察到完整等待句，随后显示“仍有未解决的交付偏差。请先处理问题，再进行验收。”后台拒绝码为 `REVIEW_OPEN_ISSUES`，没有新增验收历史。首次 19 组回归对应 `index-vfQ7jd5a.js`，最终两处文案变化对应追加的两组回归，不混写为同一产物。

最终部署资源字节匹配，HTTPS、访问拒绝、UFW 与备份检查通过；Mac 正常退出重启保留 52 项任务及 12 项通过记录（含测试卡片），恢复同步，没有新增执行。iPhone 与 P0-02 的“验收结果可见”“补证据、通过与退回”已办结；旧决策与旧版本草稿冲突仍是独立待办，整项保持部分验证。原始日志和阶段快照在本机 `review-feedback/`：`final/`、`copy-{chromium,webkit}.log`、`physical-flow.json`、`physical-copy-observed.json`、`physical-copy-final-receipts.json`、`physical-board.json`。

镜像控制使用 500ms 持续点按后恢复。快速批量输入丢字、手机剪贴板未收到预期文字属于控制工具限制；测试均逐键输入并在提交前核对，没有记为产品输入缺陷。另有低风险静态推断留待复现：无弹窗保存操作未返回时恰好退出失败，忙碌按钮可能不恢复；尚未动态复现，不描述成真机已发现问题。


### iPhone 旧版本验收草稿：真机补测通过

在新增的可丢弃任务查看第一版说明和证据，打开人工验收并填写 `Version one`，保持未提交。电脑随后更新第二版交付与证据；iPhone 保留草稿，同时显示“任务内容或记录已更新，请关闭草稿，核对当前版本后重新打开”，提交按钮禁用。实际点按该按钮后，后台确认零命令、零验收历史。

取消旧草稿，在手机核对“版本二：测试卡片改为绿色说明”和第二版证据，重新打开并提交 `Version two`。手机显示当前任务已通过；后台恰好一条验收命令，预期修订号 5，验收历史只记录内容版本 2。其他原任务的验收和测试文件未变，活跃执行为零。iPhone 与 P0-02 的“交付变化后先核对新版再验收”已独立办结；旧决策提交冲突继续保留，不混作同一检查。

本次只增加可丢弃测试数据，没有改产品代码，不重复构建或无差别重跑已通过的工程套件。当前看板为 53 项任务、13 项通过记录（含新增测试卡片），不是一次新的重启保留测试；前述重启时的 52/12 仍是原始快照。证据在本机 `design/qa/v0.4/iphone-stale-review/`：旧草稿拦截和新版验收的命令、任务快照以及 `physical-board.json`。真机操作由 CUA 完成，不需要用户代点网页。

## 实际命令与原始记录

在 Node.js 24.19.0、macOS arm64 上执行：

```sh
node --test tests/*.test.mjs
pnpm desktop:pack
node scripts/verify-inbox-upgrade.mjs /path/to/board.sqlite /path/to/report.json
TEST_BROWSER=chromium node tests/e2e/inbox.mjs
TEST_BROWSER=webkit node tests/e2e/inbox.mjs
TEST_BROWSER=chromium node tests/e2e/accounts-conversations.mjs
TEST_BROWSER=webkit node tests/e2e/accounts-conversations.mjs
TEST_BROWSER=chromium node tests/e2e/mobile-inputs.mjs
TEST_BROWSER=webkit node tests/e2e/mobile-inputs.mjs
TEST_BROWSER=chromium node tests/e2e/mobile-offline.mjs
TEST_BROWSER=webkit node tests/e2e/mobile-offline.mjs
node tests/e2e/mobile-receipts.mjs
TEST_BROWSER=chromium node tests/e2e/remote-recovery.mjs
TEST_BROWSER=webkit node tests/e2e/remote-recovery.mjs
TEST_DIST=1 TEST_BROWSER=chromium node tests/e2e/dialog-focus.mjs
TEST_DIST=1 TEST_BROWSER=webkit node tests/e2e/dialog-focus.mjs
TEST_DIST=1 TEST_BROWSER=chromium node tests/e2e/mobile-connectivity.mjs
TEST_DIST=1 TEST_BROWSER=webkit node tests/e2e/mobile-connectivity.mjs
TEST_DIST=1 TEST_BROWSER=chromium node tests/e2e/review-feedback.mjs
TEST_DIST=1 TEST_BROWSER=webkit node tests/e2e/review-feedback.mjs
```

其余浏览器组使用 `tests/e2e/{board,features,verification,remote}.mjs`；WebKit 另运行 remote。真实执行使用 `scripts/verify-real-mobile.mjs`，需要已登录的本地 Codex、其配置路径和可用额度。该脚本会在临时目录实际调用 AI，普通回归不要自动开启。

原始日志与截图保存在本机忽略目录 `design/qa/v0.4/`：`final-tests.log`、`browser/`、`native-build.log`、`upgrade-rehearsal.json`、`real-codex-retry/results.json`、`production-final.json`、`services-final.log`、`review/inbox-security-rereview.md`。备份和连接凭据仅留在私有运行目录，不上传。独立审查自行复跑了 16 项纯领域测试和 HubStore 断言；其 HTTP 复跑被沙箱端口权限限制，相关 HTTP 证据来自主执行者的 40 项及最终 191 项测试。

## 测试中遇到的问题

- 宿主更新后旧 Codex 可执行文件路径不存在。核实官方应用内的新路径后，只修复对应插件路径，真实两轮测试通过；登录、模型和提供方配置未变。
- WebKit 账号流程曾在暂停后立即续发时失败。旧失败记录不足以证明具体产品缺陷；测试现等待本地执行租约清空、暂停回执上报并在 Hub 确认，再续发。加上回执/租约诊断后，Chromium 与 WebKit 最终均通过。不能把测试等待修正描述成已证明的产品根因修复。
- 收件箱合成 Hub 的 WebKit 测试改用独立浏览器上下文，并仅在该测试中禁用 Service Worker，避免路由替身被旧上下文拦截。产品 Service Worker 未修改；真实 Hub/账号流程继续验证实际页面。

- 本次 Chromium 断网用例第一次在浏览器断网标志已变化、React 尚未渲染时立即断言按钮禁用而失败，未观察到写入。测试改为在该时刻直接提交并断言零写入，再等待禁用渲染并重复检查；最终两种浏览器均通过。此项是测试时序修正，不能宣称为另一个已证明的产品修复。

## 手机易用性反馈

用户最初反馈：“能找到，但内容或操作还不够清楚”，并指出“说明太技术化，不清楚实际完成了什么”。卡片随后调整为先展示当前进展、还需处理和下一步，完整说明与版本默认收起；手机测试任务的摘要改为普通语言，原始技术证据保留。

2026-10-11，用户在 Android 真机查看新版卡片后明确回复：“现在能看懂了”。**这张卡片的说明清晰度已获用户确认**，对应待办已办结并同步到手机，原话保存在任务证据中。本次确认只覆盖是否看懂已完成内容、剩余事项和下一步，不等于全部手机流程、P0 或其他功能验收。P0-04 的整项测试和人工验收不因这条反馈自动通过；剩余手机依赖仍见 P0-02；P0-03 的后续工程验证另有记录。原始记录位于本机 `design/qa/v0.4/mobile-clarity-confirmed.json`。

## 未验证与放行条件

- **实体手机边界**：两台真机均在修复版以受控旧读取结果触发精确旧决策 POST 409，提示在后续轮询后保持正确；P0-02 的本轮手机测试待办清零并标记已验证。限定范围的断网、锁屏、大字号与真实修改另有通过记录，不扩大为所有设备、网络和无障碍设置，也不等于整项产品人工验收。详见[手机操作单](inbox-and-delivery-plan.md#手机实测操作单)。
- **用户价值范围**：已收到“能找到事项”及新版单卡片“现在能看懂了”的反馈。说明清晰度待办已办结；完整手机流程和整项 P0 放行仍取决于剩余检查，不扩大这次确认范围。
- **原操作核实的边界**：工程流程已补齐并测试。历史记录不足、原电脑失联或授权撤销时仍保留未知；没有强制清除或人工勾选绕过。实体手机上的核实按钮未制造故障验证，不能把浏览器结果当作真机证据。
- **Mac 退出边界**：不完整 HTTP 请求体的关闭路径已修复并在原生包验证；历史 25 秒偶发退出的原始触发点仍未定位。保留分阶段诊断及不安全锁保护，后续出现同类故障时按阶段记录定位。
- **平台与提供商**：Windows、Ubuntu、macOS Intel 原生流程，真实 Claude/Cursor、真实五小时额度恢复仍待验证。GitHub 云端 CI 继续暂停。
- **后续能力**：P1 终端接管、P2 运行预览、P3 扩展仍排队，按实施方案的依赖放行。本轮没有任意远程系统终端，也没有用暂停响应代替进程停止证明。

当前可审阅源码及工程证据；P0-02 本轮实体手机检查已完成，具体未覆盖范围见上文。整项产品人工验收与 Mac 历史退出原因仍需分别记录，不应宣称整份产品计划已全部完成。

## English summary

Current scope as of October 13: both physical phones passed the recorded stale-decision conflict checks; the P0-02 checklist for this scope is complete. Earlier observations below describe intermediate stages, not additional outstanding copies of those checks. Product-level human acceptance and the original intermittent Mac shutdown cause remain separate.

The October 13 full backend suite passed **229 tests, with no failures or skips**. The prior 215-test suite followed the confirmed review-rejection fix. Original-operation reconciliation passed in Chromium and WebKit, as did the affected offline, inbox and account/conversation flows; nine receipt-loss scenarios also passed. The earlier independent reconciliation review reran 42 backend tests; the later review-rejection review reran 39 targeted tests. Confirmed review rejection requires successful transaction rollback and a binding to the original authorized command. Missing proof stays unknown and fenced, including after a successful pause. No recovery command is replayed and no product human acceptance is granted automatically.

Physical iPhone 15 Safari over Wi-Fi and iQOO Neo10 Android 16 Chrome over cellular each completed a decision, two real Codex edits in the same task/session, output viewing, pause and theme checks. The iPhone focus-zoom bug was repaired and retested. Android also passed the recorded offline entry points, reconnect, lock/unlock, logout/relogin, missing-evidence rejection, adding evidence, and pass/return of a disposable card. Offline drafts were not automatically submitted after reconnect, with zero new Hub commands in the recorded submission checks. Mac and Android passed modal keyboard focus checks. The user physically opened and cancelled Add evidence with enlarged Android system text; the exact scale was not recorded. This complements the mirror tests but does not cover every accessibility setting. The user accepted the revised card's clarity only, not the whole product. Pause acknowledgement does not establish OS process-tree quiescence.

An additional stale-dialog defect was reproduced in both browser engines: an old review draft could accept newly updated delivery content. Task editing, evidence and review dialogs now retain the task version and account captured when opened. Final Chromium/WebKit checks passed, including stale pass/fail drafts, stale edit/evidence drafts, unchanged polling, offline recovery and reopening the current version. The physical Android test produced zero commands from the stale review draft, then exactly one review after reopening and inspecting the new version. Only disposable test cards were accepted. At that stage, Android's exact stale-decision submission-conflict response had not yet been verified; automatic removal of an obsolete decision form was observed. The subsequent October 13 controlled POST 409 retest passed, as recorded below.

The iPhone follow-up preserved an unsent review draft through offline/reconnect with zero new commands and unchanged tasks/files, but exposed delayed connectivity detection, tracked separately as IPHONE-CONNECTIVITY-01. The precise physical delay and browser network flag were not measured. User-assisted iPhone logout/relogin passed: refresh required login, the original session was revoked, and exactly one new session restored the original tasks. No credentials were read. The connectivity repair passed seven final-build flows in each browser engine, including fresh reads after reconnect, stale-response rejection, legacy-token relogin and preserved unknown command IDs. The repaired review-draft offline/reconnect flow then passed with user-assisted physical checks: both Wi-Fi and cellular off, submit disabled with a warning, draft retained after reconnect, and zero commands. Precise disable latency was not measured. Other offline entry points, dedicated lock recovery, stale-decision submission conflicts and large text were pending at that stage; subsequent physical checks are recorded in the October 12–13 entries below. A subsequent no-evidence review was correctly rejected by the backend but appeared successful to the user because the final feedback was away from the scrolled task actions; REVIEW-FEEDBACK-01 now shows a task-scoped result and passed 19 isolated browser runs, including receipt binding, malformed status, stale-auth and recovery regressions. Autonomous CUA tests on the physical iPhone then confirmed a visible missing-evidence rejection, one added evidence item, one pass, one return, and a subsequent open-issue rejection. Exactly five commands left two local reviews and one issue; other acceptances and the test file were unchanged. Two pending-message strings were clarified and the feedback flow passed again in both engines. The final copy was directly observed on the phone, followed by the correct open-issue rejection. The final assets are deployed to the private web and native app; 52 tasks and all 12 existing passed records survived restart. The two corresponding phone checklist items are complete. A subsequent physical iPhone test also blocked a version-one review draft after delivery changed, with zero commands; after inspecting version two and reopening, exactly one review accepted content version two. This has its own completed checklist item. The stale-decision conflict check was still open at that stage and was subsequently completed in the October 13 retest. This does not grant product-level human acceptance. An inferred low-risk pending-settings/failed-logout busy-state edge is recorded for reproduction, not claimed as a physical finding.

An earlier clean native restart preserved **52 tasks and 12 passed records, including a disposable test card**; the original product acceptances were unchanged. No new execution was started, and Hub synchronization was confirmed. An earlier restart check during Hub startup reported connecting and was not counted as passed until a subsequent check confirmed synchronization. The private Hub serves the tested assets with valid HTTPS, access controls and an enabled firewall. Hub, Nginx, backup and certificate-renewal timers are active; the latest backup passed integrity and owner-only permission checks. Earlier deployment stopped before replacing the application when a missing backup script caused the preflight to fail; the script was restored and actual backup execution passed. The initial upgrade rehearsal separately preserved 25 original tasks and 11 acceptances in a read-only-source copy.

Windows/Ubuntu/Intel native use, other real providers and actual five-hour quota recovery remain unverified. GitHub cloud CI stays disabled by user choice. P1 terminal takeover and P2 previews remain behind the adopted stage gates; the entire plan is not claimed complete. Raw evidence stays in the local ignored QA directory, with no private server address or credentials in the repository.

On October 13, the native Mac build passed a repaired shutdown path for an authenticated but incomplete HTTP body: the socket closed, Core/HTTP shutdown took about 6/2 ms, and a normal relaunch needed no manual lock recovery. The initial repaired restart preserved 56 tasks and 13 passed records; a later normal restart after the inbox UI fix preserved 58 tasks and all 13 passed records, including disposable fixtures, with revisions and acceptances intact at restart, no active executions and Hub synchronization. Targeted shutdown checks passed 20/20 and independent review 4/4. The original intermittent 25-second shutdown trigger remains unproven, so P0-01 is partially verified and retains a cause-finding check. Both physical phones passed controlled stale-decision POST 409 on the fixed deployed bundle, with the correct message persisting after polling and no new commands. P0-02 is verified for this test scope; no product-level human acceptance is inferred. Four validation tasks were intentionally updated as evidence arrived. The final two-task bookkeeping update preserved the other 56 task revisions and acceptance fields relative to its immediate pre-update snapshot; all human review records and 13 historical passed acceptances remained intact.


## 2026-10-12 手机剩余检查与决策冲突提示

本轮没有启动真实 AI，也没有修改测试代码；测试文件保持 `module.exports = 5;`。新增一张 Android 可丢弃决策卡片后共有 54 项任务，其中 13 条通过记录包含测试卡片，不代表新增产品验收。原产品验收结论保持不变。

| 项目 | 本轮结果 | 边界 |
| --- | --- | --- |
| iPhone 放大显示 | 系统字号调到标准范围最右档，Safari 网页放大四档；收件箱、任务详情可阅读，按钮换行且可滚动到达，证据/验收弹窗能打开取消，对话输入可填写清空。用户确认系统字号已恢复中间档。 | 菜单未显示百分比；未声称 200%、自动 Dynamic Type、所有无障碍字号或实体手指触点均通过。 |
| iPhone 锁屏返回 | 用户锁屏约 10 秒后解锁，确认返回原网页且任务仍在；镜像与后台核对 11 项当时的测试任务、文件未变，新增命令 0。 | 用户执行锁屏，助手观察页面并核对后台；未测无限时长后台驻留。 |
| iPhone 决策断网 | 预选蓝色但不提交，用户关闭 Wi-Fi 总开关与移动数据后确认提交按钮变灰；恢复后新增命令 0、决定仍未回答、文件未变。 | 恢复镜像后 Safari 显示首页，未证实这一轮决策草稿保留；不推断原因。用户未单独确认提示文案或点击禁用按钮。 |
| iPhone 已有对话断网 | 预填 `Offline test`；用户确认断网发送变灰、恢复正常。镜像看到原草稿仍在，随后清空；后台新增命令 0，未启动执行或改文件。 | 检查既有对话发送入口，不等同所有表单或后台系统操作离线验证。 |
| Android / iPhone 旧决定 | 两台手机分别保留蓝色草稿，电脑先保存绿色；正常轮询自动移除旧表单，后台只保留一条绿色决定。Android 的已处理卡片只可查看。 | 真机未强制触发精确 POST 409；自动失效与提交冲突分别记录。 |

本轮后台命令检查时间窗从 13:40 UTC 开始；决策由电脑测试 API 保存，手机新增命令为 0。两次验证记录更新属于明确的测试状态维护，已在前后数据比较中单独核对，不将其误认为手机写入。证据在本机 `design/qa/v0.4/phone-remainder/`：`physical-observations.json`、`iphone-conversation-offline.json`、各次快照、命令查询与看板更新记录。实体设备只完成相应待办；整项仍保留具体未验证项。

### DECISION-CONFLICT-01：已拒绝的旧提交不再显示回执未知

真实隔离 Core/Hub 的 Chromium 与 WebKit 测试保留合法旧页面快照，另一端先保存绿色，再提交旧蓝色。Hub 返回 `409 REVISION_CONFLICT`，新增命令为 0，已保存决定仍为 1 条。原页面却显示“回执未确认、已保留命令 ID”，而对应待处理记录已移除，提示与实际行为不一致。

现仅对命令入队前确定拒绝的 `REVISION_CONFLICT` / `INBOX_CONFLICT` 显示“任务或事项已变化；本次未提交。请刷新后核对最新状态。”其他 409 与真正丢回执保留原命令 ID，禁止重复提交。回归同时验证旧表单移除，以及 Hub 已接受但响应丢失时只创建一个命令、保留原 ID。双引擎测试、类型检查、构建和独立审查通过；最终构建另跑 WebKit 通过。审查员第一次误用旧 `dist` 的文案断言失败已单独记录，改用候选产物后 Chromium 通过。

私用网页资源与构建逐字节一致，HTTPS、安全响应头、未登录拒绝、同步、备份和 UFW 开启均已复核。该修复未改变账号权限、TLS 或防火墙规则。测试代码为 `tests/e2e/decision-conflict.mjs`，本机原始证据在 `decision-conflict/`。上述为当时的隔离测试；后续两台真机受控触发的独立证据见下节。

### 2026-10-13 Android 真机旧决定精确 409

在 Android 实体手机的私用网页中，QA 页面仅在内存中保留可丢弃任务与事项的旧 `GET` 投影；登录态、全部 `POST` 和回执仍走真实服务，产品 bundle 没有改动。电脑先保存绿色决定后，镜像键盘提交旧蓝色选项，实际响应为 HTTP `409 REVISION_CONFLICT`，页面显示“任务或事项已变化；本次未提交。请刷新后核对最新状态。”此测试**人为控制旧读取结果**，不声称自然网络竞态发生。

提交前后 Hub 命令均为 0，已保存的绿色决定仍为唯一一条；原 54 项任务的修订号与验收结论不变。测试时共有 56 项任务、13 条通过记录（含可丢弃卡片），活跃执行 0，测试文件值仍为 5。结束后已返回正常主页清除内存中的旧投影。Android 这一版的精确 409 通过；收件箱界面修复版的再次核对见下文。脱敏证据：`design/qa/v0.4/native-shutdown-fix/android-physical-conflict.json`。

### 2026-10-13 iPhone 真机旧决定初测：数据保护通过，界面反馈失败

iPhone 也仅在 QA 页面内存中保留可丢弃任务与事项的旧 `GET` 投影；登录态、`POST` 和回执仍走真实服务，产品 bundle 未改。提交旧蓝色选项收到实际 HTTP `409 REVISION_CONFLICT`，Hub 命令前后均为 0，已保存的绿色决定仍只有一条。原 54 项任务的修订号和验收结论不变；总计 56 项任务、13 条通过记录、活跃执行 0，测试文件值仍为 5。随后页面对旧命令回执查询收到 `GET 404`，误报“结果未知，请勿重复提交”；这与明确拒绝的提交不符。**初测界面未通过**，不将正确 409 数据保护等同当时完整交互通过。证据：`design/qa/v0.4/native-shutdown-fix/iphone-physical-conflict-ui-failure.json`。

修复限定在已明确入队前拒绝的旧命令：确认 `REVISION_CONFLICT` / `INBOX_CONFLICT` 后，后到的同命令回执查询不能覆盖“本次未提交”提示；其他未知回执继续保留原命令 ID，不盲目重发。原先的真实 POST 409 与迟到 GET 404 组合在同一浏览器任务复现，修复后 Chromium/WebKit 均通过，原决策冲突与丢回执回归也通过；独立复审在此范围未发现阻断项。最终构建及 Mac 正常退出重开通过，私用 HTTPS 资源与测试构建一致。工程证据：`design/qa/v0.4/native-shutdown-fix/inbox-receipt-race/`、`inbox-receipt-race-review.md`、`race-native-restart.json`、`race-deployed-web.json`。

修复版 iPhone 真机用新可丢弃事项再次提交旧蓝色决定，实际 HTTP `409 REVISION_CONFLICT`，页面正确显示“任务或事项已变化；本次未提交。请刷新后核对最新状态。”且后续轮询未覆盖提示。Hub 命令前后为 0，绿色决定仍唯一，原 56 项任务的修订号及验收结论保留；测试时共有 58 项任务、13 条通过记录（含测试卡片）、活跃执行 0，测试文件值 5。此项限定范围内**真机复测通过**，不是自然网络竞态的证明。证据：`design/qa/v0.4/native-shutdown-fix/iphone-physical-conflict-retest.json`、`retest-commands-after-iphone.json`。

同一已部署构建随后在 Android 真机复测。QA 页只冻结可丢弃事项的旧读取展示，真实鉴权、`POST` 和回执保持不变；旧蓝色提交收到 `409 REVISION_CONFLICT`，正确的“本次未提交”提示在迟到轮询后仍保持。Hub 命令仍为 0，绿色决定仍唯一；相对于已完成四项看板验证更新后的测试前快照，其他 57 项任务的修订与全部人工验收字段未变。测试时为 58 项任务、13 条通过记录、活跃执行 0，测试文件值 5。两台手机均已回到普通主页，临时 QA 入口已移除。证据：`design/qa/v0.4/native-shutdown-fix/android-physical-conflict-retest.json`、`android-retest-immediate-before.json`、`final-qa-cleanup.json`。

### NATIVE-SHUTDOWN-01：正常退出耗尽保护时限

本轮桌面构建通过，但正常退出获准于 22:03:16.452，宿主直到 22:03:41.458 才结束，间隔 25.006 秒，与原有 25 秒关闭保护时限一致。后台停在 `closing`，保留 `uncleanShutdown` 锁，因此随后启动被拒绝。具体未完成的是哪项 Core 排空工作还是 HTTP 关闭，现有记录不能确定。

已只读核对旧 PID 不存在、没有产品插件/运行时残留、数据库没有进程占用；关闭的数据库无 WAL/日志旁文件，保留仅本机拥有者可读的备份并通过完整性检查后，将旧保护锁移入恢复备份，再正常启动。54 项任务与 13 条通过记录全部保留，活跃执行为 0，Hub 同步恢复。**人工恢复成功不等于正常退出通过，也不代表根因已修复。** P0-01 的测试状态已改为失败，并新增“退出后应能直接重新打开”的具体待办，人工验收结论未改。

独立调查的现有关闭测试 3/3 通过，禁用插件关闭和 SSE 关闭均可结束；隔离环境中未完成的 HTTP 请求体可以阻塞关闭，但没有证据证明生产现场正是此原因。下一步需补不含正文、凭据或地址的分阶段关闭耗时记录，定位等待项后修复并复测。现有保护锁与等待时限保持不变。调查证据在本机 `native-shutdown/investigation.md`，恢复证据在 `decision-conflict/native-*.json`。云端 CI 继续保持不运行。

### 2026-10-13 Mac 退出路径修复与原生复测

分阶段诊断记录了两次普通退出：Core 分别约 6/5 ms，所有阶段完成，保护锁正常释放；这两次没有复现历史的 25 秒退出。隔离测试另明确复现了已认证但请求体未完成的 HTTP 连接可拖住关闭。修复后，尚未派发到 Core 的不完整连接在关闭时断开，已派发请求仍等待其实际结果，不把 socket 关闭误作执行已停止。原有 25 秒保护、不安全锁与执行器停止确认没有放宽。受影响的定向测试 20/20 通过，独立审查复跑 4/4 且未发现此范围内阻断项；最终 macOS arm64 包构建通过。

真实 Mac 用单独连接发送未完成请求体的 `POST /api/state`，请求没有派发业务写入。正常退出时服务器主动关闭该 socket；日志记录 HTTP 约 2 ms、Core 约 6 ms 完成。随后直接重新打开应用，不需要移动保护锁；当时 56 项任务与 13 条通过记录含两张新增可丢弃卡片，原有修订号和验收结论逐项保留，活跃执行为 0，Hub 同步一致。后续收件箱界面修复版也正常退出重开，在该重启快照保留 58 项任务、13 条通过记录及原修订，活跃执行 0，Hub 同步。此项证明**已复现的不完整请求体路径在原生包修复**，不能倒推 10 月 12 日 25 秒偶发退出的原始触发点。两台手机修复版精确 409 已在后续真机受控测试通过，P0 未获整项人工放行。

看板将 `native-exit-confirmation` 标为已完成，并新增 `native-shutdown-original-cause` 跟踪历史 25 秒事件的具体等待项；P0-01 从失败调整为**部分验证**，人工验收结论保持原值。仍需后续复现及分阶段记录进一步定位原触发点，不能把这次可复现路径的修复描述成所有退出问题已根治。

脱敏证据：`design/qa/v0.4/native-shutdown-fix/native-diagnostic-{quit,second-quit}.jsonl`、`native-incomplete-socket.json`、`native-fixed-quit.jsonl`、`native-fixed-restart.json`、`fixed-build.log`、`harness/unit-final.log` 和 `shutdown-independent-review.md`。历史失败和人工恢复记录保留在上节。

10 月 13 日另复跑完整后端套件，229 通过、0 失败、0 跳过，日志为 `design/qa/v0.4/native-shutdown-fix/full-backend.log`。

### 2026-10-13 最终看板状态与边界

| 项目 | 工程验证 | 当前人工验收 | 剩余检查 |
| --- | --- | --- | --- |
| iPhone 真机流程 | 已验证，已提交 | 未验收 | 无 |
| Android 真机流程 | 已验证，已提交 | `stale` | 无 |
| P0-02 实体手机真实使用链 | 已验证，已提交 | `stale` | 无 |
| P0-01 仓库、运行与数据基线 | 部分验证，已提交 | 未验收 | 历史 25 秒退出的完整触发原因 |

`stale` 来自 Android 与 P0-02 追加证据后的说明版本更新；这两项从未有人提交人工验收。最终只读快照为 58 项任务、13 条历史人工通过记录、活跃执行 0、Hub 同步；四项验证任务按证据先后更新。最后一次仅更新 Android 与 P0-02 两项；相对该次更新前快照，其余 56 项任务的修订与验收字段不变，所有人工审核历史和原 13 条通过记录保留。临时 QA 入口已清理，两台手机回到普通主页；私用网页资源匹配测试构建，HTTPS、安全响应头、未登录拒绝、服务及 UFW 检查通过。整项产品人工放行仍由用户决定。证据：`design/qa/v0.4/native-shutdown-fix/board-final.json`、`final-qa-cleanup.json`、`race-deployed-web.json`、`final-cleanup-services.log`。
