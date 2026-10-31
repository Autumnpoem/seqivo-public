# 普通 Android APK：登录与升级验证 / Ordinary Android APK: Login and Upgrade Validation

**状态 / Status:** 受限范围通过 / Passed within the stated scope
**记录日期 / Recorded:** 2026-10-18
**APK:** 普通 debug APK，versionCode 7，SHA-256 `280f4ba6a1a80e74e3b620ec0450ced82a09bba1cc2bdc8fd5842fec116cdaa9`。使用本机 debug 签名；release 仍未签名。
Ordinary debug APK, versionCode 7, SHA-256 as above. It uses a local debug signature; the release APK remains unsigned.

## 中文

### 结果与适用范围

APP203 在隔离 API 35 模拟器、Android System WebView 124 和专用 loopback HTTPS Hub 上验证了普通 APK 的 WebView 启动、登录、登录态恢复、同签名原位升级及退出登录。服务器和测试数据均为一次性测试环境；没有注入 Cookie。网页由 Hub 提供，APK 与 Hub 网页分别固定版本，更新 APK 不会更新 Hub。

原 versionCode 5 普通 APK 加载完整 Hub 时发生 WebView 崩溃；静态 TLS 页面可加载。对 `worker-src` 做 A/B/A 验证：加入 `worker-src 'none'` 后 Hub 加载通过，撤销后崩溃再次出现。这将问题范围指向 worker 启动路径；没有证据归因到 Chromium 的具体原生调用。修复在原生容器 UA 上标记 `SeqivoAndroid`，只对精确匹配的 Seqivo Android 页面迁移旧 Service Worker；普通浏览器 UA 保留 PWA 行为，其他旧 WebView UA 跳过新 PWA 初始化且不注销已有 worker。独立审查、Service Worker 生命周期/存储保留与竞态检查、类型检查和构建均通过；这些检查本身不替代普通 APK 验收。

修复后的普通 versionCode 5 登录及强制停止后重启恢复通过；之后同签名 v5→v7 原位升级和 v7 登录态恢复通过：

- 通过原生服务器菜单进入真实登录表单并登录；没有预置账号或 Cookie。授权项目、任务清单、账号页和终端入口可见。终端只验证导航入口，不代表终端输入、接管或 AI 流程通过。
- 在 v5 登录后强制停止并重新启动，登录状态和页面恢复通过。
- 使用同包名、同 debug 签名从 v5 原位升级到 v7。升级未创建额外服务端会话；偏好设置与 Cookie 逻辑哈希保留，v7 恢复登录通过。
- 测试环境原有 3 个服务端会话；本手机新增 1 个登录会话，升级新增 0 个。退出登录后只撤销本手机新增的会话，没有撤销其他会话；对应 Cookie 行数从 1 降至 0。
- v7 重新登录后，通过实际表单修改任务进展、添加一条证据、答复一项决策；Core 分别持久化一次，任务 revision 2→4、证据 1→2、决策 open→resolved。重新加载后进展与证据仍在，已处理事项能打开关联任务的已保存答案。

上述会话与 Cookie 计数仅描述本次隔离验证，不是其他账号、设备或服务器的行为保证。

业务检查首轮在历史卡片上错误等待答案文字，因此 runner 报失败；真实决策已保存。核对源码后更正为“已处理记录 → 关联任务 → 已保存答案”，仅运行只读恢复检查通过，没有重发三项写入。Hub 对任务编辑及证据使用 `running` 加持久结果表示已应用，对收件箱答复使用 `completed`；这些名称依当前协议解释。脱敏版本和结果见[机器可读记录](android-ordinary-apk-test-results.json)。

### 安全复测方法

1. 使用隔离模拟器、普通 debug APK 和可丢弃账号/项目；Hub 必须是本机 loopback HTTPS。不要连接生产或含真实用户数据的服务器。
2. 构建普通 APK 与独立 Android instrumentation APK。测试 runner 只接受普通包 `app.seqivo.android`，只接受 `https` loopback origin，且要求测试 fixture 明确标记为 disposable。通过本机专用 QA 流程将 fixture 放入目标应用私有文件目录；不要把用户名、密码、origin、Cookie 或 fixture 内容放进仓库、命令历史或日志。
3. 通过原生服务器菜单设置测试 Hub，再按需运行 instrumentation phase：`login`（默认）、`restore`、`logout`、`probe`、`taskflow` 或 `taskrestore`。在隔离模拟器上先用 `adb shell pm list instrumentation` 查出已安装 runner component，再以 `adb shell am instrument -w -e phase <phase> <runner-component>` 调用；不要将命令指向非隔离设备。`probe` 仅诊断启动；`taskflow` 会写入指定的可丢弃任务，要求独立写入标记与唯一标题，失败后先核对后台，不直接重跑；`taskrestore` 只核对重载与关联任务。每个阶段仅对其检查项作结论；如需登录态升级，先跑 login，保存安装数据后同签名升级普通 APK，再跑 restore，最后跑 logout 并检查服务器会话撤销。
4. 保留版本号、APK 哈希、Hub 网页版本、模拟器 API/WebView 版本和脱敏结果摘要。失败报告只记录失败步骤与异常类型；不要收集或分享凭据、DOM、Cookie、原始 fixture 或服务器会话内容。

测试 instrumentation 位于 `android/app/src/androidTest/java/app/seqivo/android/HubAcceptanceInstrumentation.java`。独立 test APK 通过 `evaluateJavascript` 操作普通 APK WebView 中的真实表单；不注入 Cookie、不使用原生 JavaScript bridge，也不绕过 TLS 校验。所有脚本评估前会再次核对页面 origin。普通 APK 不含测试 CA 或默认服务器地址。隔离测试 CA 变体与普通包使用不同 application ID，不能拿变体升级普通包。

### 尚未验证

本结果不覆盖生产服务器、实体 Android 设备、正式签名/发布 APK、真实终端输入与文件写入、tmux 切换、接管/交还、真实 AI、多任务完整用户旅程或所有 Android WebView 版本。它证明的是指定普通 debug APK 与指定 Hub 网页在隔离模拟器上的登录、恢复、升级和退出登录流程。

## English

### Result and scope

APP203 validated ordinary-APK WebView startup, account login, session restoration, same-signature in-place upgrade, and logout on an isolated API 35 emulator with Android System WebView 124 and a disposable loopback HTTPS Hub. No cookies were injected. The Hub supplies the web application; APK and Hub versions are tracked separately, and updating the APK does not update the Hub.

The versionCode 5 ordinary APK crashed while loading the full Hub; a static TLS page loaded. An A/B/A check added `worker-src 'none'`, then removed it: the Hub loaded with the block and crashed again after removal. This localizes the issue to the worker startup path; it does not identify a specific Chromium native call. The fix marks the native container with `SeqivoAndroid` and migrates an old Service Worker only for the exact Seqivo Android UA. Normal browser PWA behavior is preserved; other legacy WebView UAs skip new PWA initialization without unregistering an existing worker. Independent review, Service Worker lifecycle/storage/race checks, type checking, and build passed; those checks alone are not ordinary-APK acceptance.

The fixed ordinary versionCode 5 APK passed login and force-stop/relaunch restoration. The same-signature v5→v7 in-place upgrade then passed with preserved preferences/Cookie logical hash and successful v7 session restoration; the upgrade created no extra server session. The test environment already had three server sessions. This phone added one login session; logout revoked only that phone-added session, with its Cookie row count going from 1 to 0. Terminal was checked only as a navigation entry; terminal input, takeover, and AI execution were not tested.

After v7 login, real forms saved a progress update, one evidence item, and one decision. Core recorded each once: task revision 2→4, evidence 1→2, decision open→resolved. The first runner failed because it incorrectly expected the answer on the history card. The corrected read-only check followed the resolved card to the linked task and confirmed the answer and persisted progress/evidence after reload; no writes were replayed. Under the current Hub protocol, task updates/evidence use `running` with a persisted result, whereas inbox actions use `completed`. Version and sanitized results are recorded in the [test report](android-ordinary-apk-test-results.json).

### Safe repeat procedure

1. Use an isolated emulator, ordinary debug APK, disposable account/project, and a loopback HTTPS Hub. Never point this test at production or user data.
2. Build the ordinary APK and separate Android instrumentation APK. The runner targets only `app.seqivo.android`, accepts only an HTTPS loopback origin, and requires a disposable fixture in the target app's private files, provisioned by a local QA process. Do not put credentials, origin, cookies, or fixture contents in source control, shell history, or shared logs.
3. Set the test Hub through the native server menu. On the isolated emulator, discover the installed runner with `adb shell pm list instrumentation`, then invoke `adb shell am instrument -w -e phase <phase> <runner-component>` for `login` (default), `restore`, `logout`, `probe`, `taskflow`, or `taskrestore`. Do not target a non-isolated device. `probe` checks startup only. `taskflow` writes to disposable tasks and requires an explicit write marker and unique titles: verify server receipts before retrying any failed run. `taskrestore` only reloads and reads linked task results. For upgrade coverage, run login, upgrade the ordinary APK with the same package/signature while preserving app data, run restore, then logout and verify precise server-session revocation.
4. Record APK hash/version, Hub web version, emulator API/WebView version, and a sanitized result summary. Failure reports contain only the failed step and exception type; do not collect or share credentials, DOM, cookies, raw fixture data, or server-session contents.

The separate test APK uses `evaluateJavascript` to operate real forms in the ordinary APK's WebView. It does not inject cookies, use a native JavaScript bridge, or bypass TLS validation; it checks the page origin before script evaluation. The ordinary APK contains no test CA or default server origin. The isolated test-CA variant has a different application ID and must not be used to upgrade the ordinary package.

### Not verified

This result does not cover production servers, physical phones, a signed release APK, real terminal input/file writes, tmux switching, takeover/return, real AI, the complete multi-task user journey, or every Android WebView version. It applies only to the specified ordinary debug APK and Hub web assets on the isolated emulator.
