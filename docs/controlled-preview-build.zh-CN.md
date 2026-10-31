# 受控网页构建（候选说明）

**状态：候选；隔离浏览器真实 Core/Hub/worker 流程与隔离打包包内后端链路已限定通过。** 浏览器 mock 13 项、固定 Vite 工具链校验 7 项、固定 Python 资源检查 3 项、3,351 个文件打包及执行探针 7 项有局部通过证据；IMPL367 隔离阶段单元回归 6/6、Mac 原生集成 4/4 通过。FIX396 修复了覆盖路径中旧 boot 已退休记录阻碍 Core.close 的问题；历史记录纯测试 7/7、原记录原生测试 18/18、受控构建原生测试 6/6 及当前 registration-query/sourceTaskRevision/beforeSend 实现的真实 Core/Hub live 1/1 均为零跳过；REVIEW397 未发现未关闭 P1/P2。该 live 用例在 Hub 已登记后注入本地 `markRegistered` 写入失败，任务仅修订一次，再查询原 preview ID、补登记并读取实际 HTML/JS；它没有注入网络层响应丢失。UI395 在 390px 隔离浏览器中用真实 Core/Hub/worker 完成 owner 构建、打开准确预览及 Hub UI 明确确认一次关联任务，未改变任务验收并正常关闭；UI398 另作 5.5 秒、11 次观察，iframe 元素、src、访问 intent 和响应均保留。UI398 未复现先前 full-page 截图差异，不代表已定位或修复该差异。PACKAGE401 在隔离临时目标中完成固定 Node/Python/Vite/tmux 资源检查、包内 7 项 Python 与 5 项终端探针、真实 Core/Hub/Python/Vite 构建读取/原请求查询恢复 1/1、PTY Unicode 写入和 tmux detach 保留会话。PACKAGE418 后续固定源码加候选覆盖，隔离 ad-hoc 包内 Python 7 项、终端 5 项、controlled-build live 1/1 与 packaged transport 2/2 exit 0；FIX414 源码回归另有 transport 2/2、旧 preview-access 7/7、HTTP 鉴权 1/1，UI417 源码 mock/受控构建检查通过。桌面 native bridge 改为使用已确认的当前 loopback 端口，网页路由路径不变，iframe sandbox 仍为 opaque，端口 getter 失败会阻止签发。两次 CUA 尝试因 Mac 锁屏未能操作原生 GUI；PACKAGE418 未替换正式 app、未公证，也不是实体手机、真实 AI 或部署验收。完整版本与 hash 见[机器结果](controlled-preview-build-test-results.json)。DIAG384 将摘要相同的 Python 资源移到独立临时目录后，MacJob socket/echo 与身份/退出核验通过；此前 Documents 来源 startup ACK unknown 的具体 macOS 机制仍未证实。oldboot 退休记录场景是模拟，不是真实 Core 重启；readJobRecord/recover/signal 身份核验仍严格限定当前 boot。仍待原生窗口/菜单、正式签名包、完整交付版 Android 客户端组合和实体手机验收，以及真实网络响应丢失注入；当前限定结果不代表这些组合已通过。

**APP403 的新增 Android 范围：**普通 v7 APK 在 API 35 模拟器的真实 WebView 输入事件下，登录隔离 Hub、打开实际预览、保存反馈草稿并明确确认一次，owner 核验到只创建一个关联任务，原任务验收仍为 `unverified`。该运行使用 PACKAGE401 包内 Core/Hub/Web/Node/Python 资源。Documents 根目录的一次尝试返回 `failed_no_publish / BUILD_EXECUTOR_UNKNOWN`，未重发，失败原因仍未知。隔离临时根目录的用户界面收到 `ready` 并完成流程；对应通用 job 层 `resultUnknown=true` 原样保留。该字段表示该层不替命令业务结果作断言，不表示退休状态或进程身份未知；它本身不否定独立的受控构建 `ready` 回执。APP403 不是实体手机、真实 AI、生产服务或最新 Mac 原生窗口验收；FIX414 的源码回归及 UI417 mock/受控构建检查已限定通过，原生 Mac 实际窗口仍待验。详见[机器结果](controlled-preview-build-test-results.json)。

## 预期使用流程

1. 从一个具体任务启动构建。managed manifest 记录构建时的任务修订；NodeLink 在实际发送前同步复核任务、节点与授权，Hub 首次登记时同时校验源码快照修订和内容版本。该协议已有当前源码 Core/Hub 和隔离打包后端的限定实测；网络层响应丢失、原生窗口与完整发布组合仍待验。已经发出的请求不承诺可撤销。
2. 应用按允许的文件清单制作私有源码快照，记录文件摘要。快照可能包含已纳入版本控制的配置；项目配置与 `.env` 不作为构建配置加载，也不进入可执行构建视图或发布产物。路径越界、符号链接、大小限制或捕获期间的改动检查失败时，不发布产物。
3. 固定构建器只处理首版静态网页。成功产物按源码与版本身份登记，之后可以打开对应版本预览；没有受信工具链或构建结果无法确认时，明确失败或待核对，不改用系统上碰巧存在的工具。
4. 在预览中查看结果并留下反馈草稿。用户明确确认后才创建关联任务；反馈可以关联验收项。后续构建对照原版本显示哪些项目需要重验、哪些结果未知。

若发送 ACK 丢失，只能用原 `previewId` 和完整 manifest 查询登记状态；查询未能确认时结果保持 unknown，不另发第二个构建请求。之后正常编辑任务不会改写已登记产物；产物展示其构建时的任务修订和内容版本，作为历史来源信息，不自动代表当前验收通过。

## 首版支持边界

当前受控配置名为 `vite-vanilla-v1`，使用固定 Vite 8.3.1 和隔离的工具依赖。源码仅支持简单 HTML、JavaScript、TypeScript 与普通 CSS 的受限本地资源引用；JavaScript 只允许无绑定的副作用式本地静态导入（例如 `import "./local.js"`），不支持具名/默认导入或 `export`。CSS 不支持 `@import` 或 `url()`；HTML 不支持内联脚本、内联样式、模板或嵌入框架。首版不把项目配置、锁文件或 `.env` 作为构建配置加载，也不将它们加入可访问的构建视图或产物；不运行项目自带 scripts，不安装项目声明的框架或依赖，不支持动态导入、外部资源或任意 URL 代理。

预览可选择无数据连接的静态模式，或应用内的 `records-v1` 隔离持久记录接口。后者用于该预览范围内的简单记录读写，不是任意业务 API，也不会代理到用户服务。预览链接受限于授权、版本和页面来源。源码检查、工作进程身份核验和访问限制属于应用级隔离；它不是操作系统沙箱，不能据此安全运行任意不可信程序。

## 桌面打包准备

桌面包只使用应用目录内经清单与逐文件摘要核验的 Vite 工具链。固定 Python 运行时当前仅支持 macOS arm64，版本为 3.12.15。开发者须显式提供与脚本固定官方归档 SHA-256 匹配的归档，并通过 `SEQIVO_PREVIEW_PYTHON_ARCHIVE` 指定；当前固定 SHA-256 为 `8c7ac5f091c64111247e595c9fc8fecc38453e94a60323a3b66dbfca3c01414a`。归档缺失或摘要不符时不使用系统 Python、PATH 或其他下载版本作为替代；安装包中的固定资源不可用时，受控构建应报告不支持。

## 尚未验收

隔离浏览器中的 owner→构建→准确预览→Hub UI 草稿→明确确认一次任务流程，以及 PACKAGE401 隔离包内后端构建/读取/原请求查询恢复，均有各自限定通过证据，且不改变原验收状态。PACKAGE401 未操作原生窗口或菜单，使用 ad-hoc 签名，也未注入网络响应丢失；正式签名/公证包、完整交付版 Android 组合、实体手机或正式发布仍未验收；APP403 仅通过普通 v7 APK 在隔离模拟器的限定流程。授权撤销、服务重启及反馈丢回执仍需组合验收。UI398 的 5.5 秒、11 次观察保留了 iframe DOM、src 和访问 intent，未复现此前 full-page 截图差异；这只是稳定性观察，不宣称某个截图问题已修复。
