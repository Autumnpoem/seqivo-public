# README screenshots / 文档截图

这些图片由真实的 React 界面、本地 Core 和 SQLite 渲染，全部使用 `scripts/capture-readme.mjs` 创建的虚构示例任务。订单、导出和归档等内容只用于展示看板；其中的业务进度、证据与验收均为示例，不是实际业务测试结论。

These images show the real React UI backed by a local Core and SQLite, populated entirely with synthetic fixtures from `scripts/capture-readme.mjs`. Order, export, and archive tasks illustrate the board; their progress, evidence, and acceptance records are not real business validation results.

## Regenerate / 重新生成

从仓库根目录运行 / Run from the repository root:

```sh
pnpm build
pnpm exec playwright install chromium
node scripts/capture-readme.mjs
```

可用 `CHROME_PATH` 指向已安装的 Chrome。脚本使用临时数据目录和空插件目录，退出时清理数据；不读取用户项目、不运行 AI、不修改真实应用记录。浏览器截图验证布局，不代表实体手机或原生窗口行为验证。

Set `CHROME_PATH` to use an existing Chrome executable. The script uses temporary storage and an empty plugin directory, then cleans up its data. It does not read user projects, call AI providers, or change real app records. Browser screenshots demonstrate layouts, not physical-device or native-window validation.

| File | View / 视图 |
| --- | --- |
| `overview-light.png` | Light task board / 浅色看板 |
| `overview-dark.png` | Dark task board / 深色看板 |
| `delivery-review.png` | Delivery issue / 交付偏差 |
| `mobile-layout.png` | Mobile viewport / 手机布局 |
| `floating-layout.png` | Compact floating layout / 悬浮窗布局 |
