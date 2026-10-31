# 序程 · Seqivo

推荐的开源项目品牌方案。中文读作「xù chéng」；英文建议读作「SEE-kee-vo」。Seqivo 是以 Sequence（序列、次序）为灵感的品牌造词。

「序」代表清晰的任务与协作秩序，「程」代表从计划走到实际交付的全过程。名字可以覆盖任务看板、插件、远程控制与多 Agent 协作，不局限于某一个 AI 工具。

**品牌短句：让每一步，都有着落。**

**英文介绍：An open workspace for AI tasks, progress, and verified delivery.**

## 图形

连续、圆润的 S 路径呼应英文首字母，也代表计划、行动与结果之间可追溯的联系。应用图标采用大圆角底板和蓝色标志；日间为浅银白，夜间为深海蓝。图形以向量路径绘制，没有外部图片、字体或第三方图标依赖。

- `icon-light.svg` / `icon-dark.svg`：1024 × 1024 的可编辑应用图标。
- `mark.svg`：透明背景的单色标志，支持 `currentColor`。
- `tray.svg`：16–24 px 菜单栏 / 托盘简化版，支持 `currentColor`。
- `exports/light/` / `exports/dark/`：各平台图标与 PNG 输出。
- `preview.html` / `preview.png`：日间、夜间及小尺寸展示。
- `generate.mjs` / `export-icons.mjs` / `render.mjs`：可重复生成、平台导出与视觉检查脚本。

主色为 `#316DEB`；正文深色为 `#172436`；浅背景为 `#F2F4F8`；夜间背景为 `#101925`。标志周围至少保留自身宽度 1/4 的留白。小于 24 px 时优先使用单色简化版本。不要拉伸或给路径叠加文字。

在项目根目录运行 `node design/brand/seqivo/generate.mjs`、`node design/brand/seqivo/export-icons.mjs`、`node design/brand/seqivo/render.mjs` 即可重建。目前预览脚本使用本机 macOS 的 Google Chrome；其他系统可通过 `SEQIVO_CHROME_PATH` 指定浏览器路径，或使用 Playwright 安装的 Chromium。

已检查 1440 × 890 预览无溢出，日间与夜间图形显示正常，16 / 22 px 单色托盘可辨认。平台容器文件已生成；是否在各系统中自动跟随外观切换，需在应用接入阶段分别处理。

## 命名检索记录

2026-09-26 对「Seqivo」「序程 软件 AI」进行了公开网页初筛，未发现结果中有明确同名的同类任务看板；这不表示项目名、包名或域名已注册或锁定。检索有一个[同名音乐作品](https://www.senscritique.com/morceau/seqivo/133781465)。建议仓库名 `seqivo`；尚未创建远程仓库或注册任何服务。

## 应用范围

0.2.1 开发版已接入「序程」名称与日间应用图标，保留既有应用标识符与数据目录，以延续已有任务、授权和插件配置。夜间图标与托盘资源已提供，系统图标的自动外观切换尚未接入。图标资源可随项目源码一同开源；本方案未替项目选择软件许可证。
