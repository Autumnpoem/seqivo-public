# 收件箱滚动修复 / Inbox scrolling fix

日期：2026-10-17。基线：`8106e82`。

Mac 桌面“需要我处理”页面内容较多时，下方卡片和操作按钮被裁切，滚轮无法到达底部。桌面布局限制了窗口高度，但收件箱根节点缺少其他页面共用的 `content-page` 滚动容器样式。修复为正常和暂不可用两个分支补上该类名，保留手机布局及原有操作逻辑。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 修复前复现 | 1180×820 下实际滚轮输入无法露出“查看其余 3 项”，回归测试失败。 |
| 滚动回归 | Chromium、WebKit 各 6 种尺寸通过：1180×820、900×500、761×600、760×600、390×844、320×640。滚轮可露出更多按钮及最后一项操作，展开/收起决策表单正常；无横向溢出，桌面标题保持固定。 |
| 原有收件箱流程 | 两种浏览器均通过优先级、决策、补充信息、稍后处理/历史、人工验收、任务跳转、窄屏及撤销后的回执保护回归。 |
| 构建 | TypeScript/Vite 与 macOS arm64 应用打包通过。 |
| Mac 实际使用 | 用户正常退出并重新打开新版后明确确认“重开后可以滑到底部”。此项来自用户实机操作；自动化桌面工具超时，未取得本轮原生窗口截图。 |

浏览器测试使用隔离数据和本地服务，未启动真实 AI；手机尺寸不代表本轮实体手机复测。Windows/Ubuntu 原生端未在此轮测试。

复现命令（先执行 `pnpm build`）：

```sh
node tests/e2e/inbox-scroll.mjs
TEST_BROWSER=webkit node tests/e2e/inbox-scroll.mjs
node tests/e2e/inbox.mjs
TEST_BROWSER=webkit node tests/e2e/inbox.mjs
```

Chromium 可通过 `CHROME_PATH` 指向已安装的 Chrome。原始截图及 JSON 结果保存在本机 `design/qa/inbox-scroll/`，不随仓库上传。

## English

The desktop inbox was missing the shared scroll-container class inside a fixed-height layout. Both inbox root states now use it. Wheel-input regressions pass in Chromium and WebKit at six desktop/mobile viewport sizes, along with the existing inbox flows. The macOS build passed, and the user confirmed reaching the bottom after reopening the updated app. Native automation timed out; physical mobile devices and Windows/Linux native apps were not retested for this change.
