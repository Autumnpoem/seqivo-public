# Android 普通安装包：原生登记与终端输入验证

## APP238R4：普通包同一 Activity 的长断网恢复限定通过

普通 v7 APK 在隔离 API 35 模拟器和原冻结网页上完成同一 Activity 长断网恢复。受测约 100 秒期间，系统无默认网络且 App UID 无法到达测试端点；21 个离线区间/结束采样均确认离线。回网后自动以新 socket/连接恢复原 A；主动新建连接进入显式默认 B。20 个已分类终端协议探测帧均收到 ACK、无未知结果；没有输入终端命令。

独立观察 181 次、约 150.97 秒，原 A/B 受管进程与 tmux 身份保留，4 个标记文件的哈希和修改时间未变化；最终无活动终端连接，Shell 空闲。此结果只证明该普通包在隔离模拟器的受测路径，不代表实体手机、跨设备、命令输入或完整 Android 验收。旧 APP238R3 是不同的网络准备结果，保留其“断网未证实”结论，不覆盖 R4。

## APP238R3：同一 Activity 后台返回及默认重连限定通过

普通 debug APK v7 在隔离 API 35 模拟器上使用 APP232 冻结的 Core/Hub 网页；本次没有重启服务、替换网页或输入终端命令。后台返回后仍为同一 Activity，自动恢复到原 A，旧 socket 关闭并建立精确关联原 A 的新连接；之后主动断开并新建连接进入显式默认 B。最后断开后无活动连接。人工续跑使用同一测试 run 与 continuation marker 一次，没有重启 instrumentation。

协议观察共 20 帧、20 个 ACK、0 个未知结果；DA1、DA2、DECRQM 2026 reset、OSC 10 和 OSC 11 各有 4 次匹配回复。这些是终端协议探测，不是命令或字符输入。独立宿主观察 348 次、约 290.51 秒；原 A/B 身份保留，4 个标记文件的 SHA-256 与修改时间均未变化。

这次约 100.05 秒的网络关闭尝试**没有证明持续无网或服务端点不可达**：页面没有触发 offline/online 事件，恢复时实际使用移动网络。因而只确认同一 Activity 的后台/返回恢复和显式新连接选回 B；该次本身不能验收长断网恢复，后续 APP238R4 已在独立结果中补充限定通过。r36/r37 两次准备失败来自前置条件过严和协议分类不完整，保留为测试准备问题，不计为产品回归失败。

机器摘要分别记录 APP238R3/R4 的结果；R3 的 r38 测试 APK、构建 Java 与冻结网页哈希不覆盖 APP205、APP209 或 APP232 的历史哈希。R3/R4 均为隔离模拟器和冻结 Core/Hub 的限定结果；R4 的网络恢复证据不代表实体手机、终端命令输入、完整业务或用户验收通过。

## APP232：原 A/B 输入、临时切换及默认重连通过

普通 Android debug v7 在隔离 API 35 模拟器完成正式入口恢复原 A/B，明确选择 B 后只点一次 Ctrl+C。宿主另行核对 B 草稿清除、Shell 空闲及 A1 文件未变，再继续尚未执行的步骤；没有重新创建 A/B 或重放 A1。

原生按键在 B1、A2、B2 各发送 47 帧、一次回车，全部收到对应写入确认，没有错误；真实文件各只有一行。临时切到 B 后主动重连进入 A；明确将 B 设为默认后，下一次主动连接进入 B。最终从界面正常断开。只读观察器 126 次采样确认所有标记文件及原 pane/受管进程身份，A1 内容和修改时间保持不变。

PROC230 已独立复核，新的完整进程观察仅用于人工输入前后的相关写入者核验，停止/停驻/交还仍使用原稳定核验接口。独立定向测试 11/11、另一个真实临时 tmux 写文件测试 1/1 通过。旧隔离 Core 正常退出码 0 后，原会话保留并启动冻结候选；网页和普通 APK 未替换。测试纠正记录保留在机器摘要，未把首次观察器的错误前置条件算为产品失败或通过。

此结果完成本机模拟器中的原 A/B、实际输入及主动默认重连；APP238R4 又补充同一 Activity 的长断网恢复限定结果。跨设备、中文输入法边界、实体触屏、完整 App 业务和真实 AI 交还仍待验证；线上服务及人工验收状态未改变。以下 APP226 等段落是各次历史状态。

## APP226：原会话恢复通过，B 输入仍被进程变化保护拦住

冻结候选包含已独审的进程快照修复和明确恢复入口。本机复核：快照 6/6，客户端/manager/Hub 34/34，另有远端 manager/control/tmux 1/1（执行器停止和快照故障采用测试桩）；类型检查与网页构建通过。普通 Android v7 包未替换，只更新隔离服务与网页。

通过正常停止信号结束旧测试 Core 后，原 supervisor/Shell/relay 的出生身份保留；supervisor 的父进程由旧 Core 变为系统 init，符合脱离进程的重启模型。旧进程退出已观察到，但原工具会话已不可查询，未取得退出码，因此不作为 Mac 原生退出验收。保留数据副本后启动冻结候选。

普通 APK 的原生点按实际完成：等待核对且输入禁用 → 明确核对本设备原执行权 → 仍需选择原授权 A → 接回原 A → 新建 B。原 A1 文件未修改、未重放。随后 B1 输入到前缀时，完整进程集合两次观察不一致触发 `identity_set_changed`；输入立即冻结，未发回车、未执行 B1、未生成 B1/A2/B2 文件。76 次只读采样确认原 A 和文件不变，并记录新 B 的精确进程身份。

下一步检查逐键工作区核验对全 UID 进程集合稳定性的要求；完整进程观察和相关写入者、祖先进程身份必须保留，不能忽略未知项或重试抹掉变化。B 中有未执行草稿，后续先核对现场并明确清除，不能重放完整流程。A/B 文件、默认重连、实体手机及真实 AI 交还仍未通过。

## 历史 APP216 及之前记录

以下结论只描述各次测试当时的状态；当前结论以文首 APP232 为准。

**APP216 当次结果：**普通 APK 已逐字符完整发送第一条命令并按一次回车，实际测试文件内容与该命令一致，仅一行。测试原先要求从 `$TMUX_PANE` 取得 pane 编号；受管 Shell 实际在独立 supervisor PTY 中运行，tmux pane 负责转发，因此该断言不适用。已改为固定行标记，并要求宿主独立核对原 pane、受管进程身份和文件；不重放已经执行的第一条命令。此次格式转义和真实换行均正确。

继续流程在创建 B 之前被 `pid_info_incomplete` 拦住，控制权进入 `unknown`，未发送新命令。只读宿主观察确认原 A 进程与文件保持，B 尚未创建。此错误来自完整进程快照不能确认；观察器频繁查询是否增加竞争仍是假设，不能代替根因证据。当前输入保护保留，正式恢复及 B1/A2/B2、默认重连仍待完成。

**APP213/214 当次增量：**普通 v7 APK 在同一隔离 API 35 模拟器上，17 字符无回车输入与 17 个发送帧、对应写入确认逐一匹配；未发送 Enter，随后通过 Ctrl-C 清除草稿。十组浏览器真实 xterm 回归通过。完整流程仍未完成：一次尝试在会话抽屉操作处停止，尚未执行命令；后续只读诊断中连接与抽屉操作通过。软键盘出现与测试取点的时序是待核实因素，尚不能判定为产品缺陷或修复。当前源码/网页哈希与范围单列于机器摘要 APP213/214；下文 APP212 的“未部署、未复验”保留为当时的历史状态。

**尚待完成：**完整命令与实际文件、A/B 会话切换及默认重连、其余输入异常定位、实体设备和最终产品流程。上述短输入、浏览器和模拟器结果不替代这些验收，也没有改变人工验收或线上服务。

记录日期：2026-10-18。状态：**部分通过；终端输入和 A/B 完整流程未通过。** 本记录为 APP205/APP204 的隔离验证，不覆盖线上服务或实体手机。

## 已通过的范围

使用普通 debug APK versionCode 7、隔离 API 35 模拟器和本机隔离 HTTPS Hub。APK 未更换，Core/Hub 未重启；仅使用本地测试网页。APP203 的登录、进程重开、升级及任务业务验证见[普通包记录](android-ordinary-apk-validation.md)。本轮不更新生产 Hub，也不改变用户验收状态。

- APP205：连接提示布局修复通过浏览器回归，原生目标位移由约 53.6px 降到 0；窄屏大字号、现有连接写入门禁、类型检查、构建和独立审查通过。静态按钮三组原生输入对照通过。普通 APK 原生事件点击命中登记按钮；实际登记一次，随后通过正式 owner 接口仅授权指定测试项目一次。诊断点击阶段没有提交。这个结果限于隔离模拟器和本机 Hub，不等同实体触屏。
- 随后连接可丢弃测试项目、接管空闲项目并创建 tmux 会话 A，默认标记检查通过；没有运行 AI。
- KeyInputProbe 是独立输入探针，不是终端验收。整串 ASCII 输入 `abcXYZ09` 未匹配，按字符注入的 ASCII、整串特殊字符和逐字符特殊字符样例均匹配；Enter 只在探针中用来观察输入框行为。
- 只读观察器 r2 收到 9 个事件、错误为 0，并正常停止；它仅核对原会话 A。此结果不说明其他会话已删除或丢失。

## 后续 APP206–APP209 增量验证

- APP206 键盘视口、底部栏/抽屉布局及自动 ready 不抢占手动查看已修复；独立复核发现的两项 P2 均关闭。APP207 在进程证明被拒时冻结旧输入、不补发，并拒绝迟到帧；纯 client 用例 12/12 通过并经实际 diff 复核。
- APP208 独立 UMD xterm 的 4 组 ASCII/特殊字符、整串/逐字符样例均匹配，Enter 为单个 CR。该探针不证明生产 bundle、真实 PTY 或物理软键盘行为，也没有复现旧双 Y 现象。
- APP209 当前网页源码与部署收据哈希已单独记录在机器摘要的 `APP209` 对象；浏览器 viewport 与完整 terminal UI、类型检查、构建均通过。普通 debug APK 在 Android API 35 的实际 IME 视口检查通过，键盘弹出和收起时终端区及会话控件均可见。
- 这些结果来自隔离 Hub/模拟器；APK 未变更，Core/Hub 未重启，生产未部署，用户验收状态未改变。原生终端输入、A/B 真实文件写入及默认重连仍未通过；APP208 探针结果不能替代这些验收。

## APP210–APP211 输入诊断增量

- **APP210 普通 APK 输入尝试：失败。** 输入框聚焦正常、连接正常且未见客户端错误，但原生键入没有匹配到真实终端输入，没有生成文件。DOM 只观察到一次可信的 `P` 键事件；WebSocket 中两条对应 `P` 帧（序号 21、22）均收到写入确认。后续调用路径追踪已将这一次重复 P 定位为按键路径与输入法组合提交路径各发一帧；这不证明终端收到字符，也不代表完整输入失败已修复。
- 同期 20 轮只读进程证明检查通过，未复现历史间歇性进程证明失败；这不能排除其他时序或现场下仍会发生。
- **APP211 独立 UMD xterm 探针：4/4 样例匹配**，包含 ASCII、特殊字符及 59 字符目标样例的整串/逐字符输入。探针没有 PTY、WebSocket 或回显，不能证明生产 bundle、真实终端/文件写入或软键盘链路通过。
- 后续 APP211 调用栈追踪（r3）确认 seq21 走 `xterm._keyPress`，重复的 seq22 来自 `CompositionHelper._finalizeComposition(true)` 异步回调；该次 P 的 `isComposing=true`，DOM 仍只有一次可信按键事件。Enter 未发送，清理完成。旧 bundle 的定向测试已复现 `[P, P]`；当时尚无候选通过结果，之后的 APP212 候选范围与限制见下。此结论只解释这次 P 双路径，不覆盖更早的 Y 双发或其他输入故障。
- 后续 APP212 候选修复在浏览器真实 xterm 回归中 7 组通过，类型检查和构建通过。源码与测试 SHA-256 单独保存在机器摘要的 `APP212` 对象；旧真实 xterm 红例亦保留。候选尚未部署，当前隔离 Hub 仍使用 APP209；普通 APK 实际输入复验和完整终端命令均未通过。
- APP212 后续审查建议进入隔离 APK 的无 Enter 观察验证；尚有两项未复现的风险/测试缺口：组合结束后下一键 keydown 与旧的非组合 input 事件迟到交错，以及组合进行中按 Enter。当前没有这些情形的新缺陷证据；候选浏览器回归通过不消除这些待测路径。
- 因此完整原生输入、实际文件写入、A/B 流程、默认重连及人工验收仍未通过或未改变；APP209 的布局视口结果和 APP211 的探针结果均不改变这些状态。

## 未通过与诊断线索

- **flow-r1：**首条终端命令输入不完整，没有生成标记文件；原 A 和未完成输入保留。失败结果未触发重放。
- **flow-resume-r1：**Ctrl+C 清除了草稿；测试因预期界面显示字面 `^C` 而失败。没有发送新命令，不能据此宣称 Ctrl+C 产品行为失败或通过。
- **flow-resume-r2：**逐字输入仍未通过，标记文件为 0；完整终端输入仍未定位。
- **无 Enter 输入追踪 r1：**原生按键序列 `abcXYZ09` 在终端观察结果为 `abcXYY`。所有已发送帧均有 written ACK，而 DOM 事件只观察到一次 Y。该迹象没有确立根因；本次未发送 Enter，不能视为命令执行。
- **无 Enter 输入追踪 r2：**输入序列观察到发送前缀 `abc`；a、b 收到 written ACK，c 返回 `PROCESS_PROOF_UNAVAILABLE` 后追踪停止。未发送 Enter。与 r1 的 Y 双发不同，这是进程证明错误；具体原因未知，不据此推断终端已丢失会话或自动重试。

因此，APP205 的登记与授权通过不代表 APP204 输入链路通过。A/B 实际文件写入、切换与默认重连仍未验收。不要重放整条命令；后续诊断应继续按输入事件、发送帧、写入确认和终端文件分层核对，并保留原 A。

## 复验边界

本轮只覆盖隔离模拟器上的原生事件、普通 APK 与隔离 Hub。未通过完整终端按键、真实文件写入、A/B 切换、默认会话重连、实体手机、软键盘、线上部署或真实 AI。输入框探针、DOM 事件、帧 ACK 和会话创建均不能单独代替终端命令写入证据。

脱敏机器摘要见[测试结果](android-terminal-test-results.json)。原始测试记录保留在本地隔离 QA 区，不在文档中列出私有路径、服务器地址或用户数据。

## English

**APP238R4 limited pass:** The ordinary v7 APK on an isolated API 35 emulator remained in the same Activity through about 100 seconds with no system default network and no App-UID reachability to the test endpoint (21 offline interval/end samples). It automatically recovered exact A over a new socket/connection; a later new connection selected default B. Twenty classified protocol probes were ACKed, with no unknown results or typed commands. The original A/B process identities and four marker files remained unchanged; the observer saw idle shells and zero active connections at the end. This does not prove physical-device, cross-device, terminal-input, or full Android acceptance. APP238R3 is an earlier, separate attempt that did not prove an outage.

**Historical APP238R3 addition:** On the same isolated API 35 emulator, the ordinary v7 APK returned from background in the same Activity and automatically recovered the exact original A connection; after explicit disconnect, a new connection selected default B. No terminal commands were typed. Its roughly 100-second network-off attempt did not prove continuous network loss or endpoint unreachability: the page emitted no offline/online event, and recovery used cellular. APP232’s earlier A/B file-write/default flow remains separately verified. Cross-device, physical touch, complete business workflows and real AI handback remain unverified; production and user acceptance are unchanged.

**Partial validation; terminal input and the complete A/B flow have not passed.** APP205/APP204 used an ordinary versionCode 7 debug APK, an isolated API 35 emulator, and a local disposable HTTPS Hub. APP205 native pointer enrollment created one device and one project-scoped grant. A was created and marked default, but terminal input remains incomplete. The read-only observer for the original A session stopped normally with zero errors; this does not prove other sessions were removed or lost.

The connection-notice layout passed browser regression, reducing observed target movement from about 53.6 px to zero. Narrow large-text, connection write-gate, type/build, and independent review checks passed. Three static native-input comparisons passed. The ordinary APK then registered once and received one project-scoped grant through the owner path. These are isolated emulator/local-Hub results, not physical-touch acceptance.

Subsequent APP206–APP209 checks are recorded separately. APP206 keyboard viewport, bottom-bar/drawer layout, and auto-ready behavior that preserves manual viewing were fixed; both independent-review P2 findings were closed. APP207 freezes old input, does not replay it, and rejects late frames after process-proof refusal; its pure-client set passed 12/12 and the actual diff was reviewed. Four independent UMD xterm samples in APP208 matched, including single-CR Enter, but this does not validate the production bundle, a real PTY, or a physical soft keyboard, and did not reproduce the earlier duplicated-Y observation. APP209 browser viewport/full terminal UI, typecheck, and build passed; an ordinary debug APK on the API 35 emulator passed the actual Android IME viewport check with terminal and session controls visible while the keyboard was shown and hidden. Its web-entry and source hashes are recorded as a separate APP209 object; the APP205 historical web hash remains unchanged.

These later checks used an isolated Hub/emulator. The APK was unchanged, Core/Hub were not restarted, production was not deployed, and user acceptance was not changed. Native terminal input, real A/B file writes, and default reconnect remain unpassed; the APP208 probe is not a substitute for them.

**APP210 input attempt: failed.** The native key did not match real terminal input; the textarea was focused, the connection was active, and no client error was observed. The DOM recorded one trusted `P` event. Two corresponding WebSocket `P` frames (sequence 21 and 22) each received a write acknowledgement. Later call-path tracing attributed this duplicate `P` in this attempt to the keypress path and the IME composition-commit path each sending a frame. This does not prove terminal receipt or mean the complete input failure is fixed. No file was created. A separate 20-round read-only process-proof check passed without reproducing the historical intermittent proof failure; it does not rule out other timing or session conditions.

**APP211 independent UMD xterm probe: 4/4 samples matched**, including ASCII, special characters, and a 59-character target sample entered whole and character by character. The probe had no PTY, WebSocket, or echo, so it does not validate the production bundle, real terminal/file writes, or the soft-keyboard path. Full native input, real file writes, the A/B flow, default reconnect, and user acceptance remain unpassed or unchanged; these diagnostic results do not change those statuses.

In the follow-up APP211 call-path trace (r3), sequence 21 passed through `xterm._keyPress`; duplicate sequence 22 came from the asynchronous `CompositionHelper._finalizeComposition(true)` callback. `isComposing` was true while the DOM still showed one trusted key event. Enter was not sent and cleanup completed. A targeted test reproduced `[P, P]` against the old bundle; that trace predates the APP212 candidate result described below. This explains only this duplicate-P path, not the earlier duplicated-Y observation or the overall input failure.

The later APP212 candidate passed seven browser real-xterm regression groups, typecheck, and build; its source/test hashes and the earlier real-xterm red case are recorded separately in the machine summary. The candidate was not deployed; the isolated Hub still uses APP209, and no ordinary APK input retest or complete terminal command has passed. Follow-up assessment recommends an isolated APK no-Enter observation. Two un-reproduced test gaps remain: a late old non-composed `input` event racing the next `keydown` after composition end, and Enter during active composition. No new defect is established for those cases; the candidate browser pass does not close them.

The independent KeyInputProbe is not terminal acceptance: whole-string ASCII `abcXYZ09` did not match, while character-by-character ASCII and both special-character cases matched. In terminal flow, flow-r1 produced no marker file. flow-resume-r1 cleared the draft with Ctrl+C, but the runner failed because it expected literal `^C` to appear; no new command was sent. Character-by-character retry in flow-resume-r2 still failed with zero marker files.

In no-Enter trace r1, native `abcXYZ09` appeared as `abcXYY`; every sent frame had a written ACK, while the DOM recorded one Y. In separate trace r2, the observed send prefix was `abc`; a and b received written ACKs, while c returned `PROCESS_PROOF_UNAVAILABLE` and the trace stopped. Neither trace sent Enter. These are distinct diagnostic observations with unresolved causes, not command execution proof. Do not replay the command or replace the original A session. A/B file writes, default/reconnect behavior, physical-device touch, soft keyboard, production deployment, and real AI handoff remain unverified. The APK and Core/Hub were unchanged; only the local isolated Hub page was used.
