# codex-autocontinue 接入评估

2026-09-25 只读检查默认分支。未修改远程仓库，未在真实账号上运行自动继续。以下是源码观察与设计建议，不等同于完整审计或已复现的缺陷报告。

## 已有基础

项目 Python 包名为 `codex-charge`，检查到的版本为 1.1.1。它具备 CLI 包装、额度读取、桌面等待、配置、托盘和平台输入等模块；结构适合通过桥接进程接入，无需先整仓重写。[项目配置](https://github.com/Autumnpoem/codex-autocontinue/blob/main/pyproject.toml)

`quota.py` 通过 `codex app-server` 读取额度，`watch.py` 等待耗尽窗口的重置时间并增加 grace 秒数，再请求桌面输入。这部分可提取为“读取额度”和“恢复策略”两种能力。[额度代码](https://github.com/Autumnpoem/codex-autocontinue/blob/main/codex_charge/quota.py)、[等待代码](https://github.com/Autumnpoem/codex-autocontinue/blob/main/codex_charge/watch.py)

## 集成前需要处理

| 源码观察 | 对任务看板的影响 | 建议 |
| --- | --- | --- |
| `desktop_input.py` 只分支处理 win32 与 linux，其他系统返回 false | 当前不能宣称 macOS 桌面输入已适配 | 首选跨平台协议恢复，GUI 注入作为单独可选兼容层 |
| 桌面输入按窗口标题找第一个匹配窗口 | 多窗口时没有可靠任务身份绑定 | 以会话 ID + 项目路径 + 运行状态定位，无法确认则不发送 |
| `exhausted_window()` 优先返回 primary，之后才检查 secondary | 两个窗口同时耗尽时，可能先等待较早的窗口 | 对所有阻断窗口计算最晚恢复时间，临界点重新读取额度 |
| `watch.py` 到点后直接调用发送，没有在发送前重新检查任务状态和额度 | 用户已暂停、任务已结束或额度未恢复时仍可能发指令 | 增加任务授权与状态门禁；恢复前重新读取 |
| 输入函数返回成功不等于收到 AI 开始事件；Linux 子进程使用 `check=False` | 看板不能将发送动作标成恢复成功 | 分开记录发送、确认、执行；失败或超时显示具体原因 |
| `goal_resume_pending` 在发送结果前改为 false | 首次发送失败后可能不再发送原本的首次恢复指令 | 等待确认后再推进策略状态 |
| `_rpc` 检查 deadline 后调用阻塞 `readline()` | 上游不输出时可能无法及时触发预期超时 | 使用异步读取／读线程或可超时管道，清理进程并消耗 stderr |
| 额度解析只处理 `rateLimits` | 不应假设不同版本字段完全相同 | 为版本化响应与多额度桶补充兼容契约测试 |
| LICENSE 中仍有 Git 冲突标记 | 打包与复用时的文件内容不完整 | 在正式分发前清理并确认版权文字；本轮不修改它 |

上述观察来自：[输入实现](https://github.com/Autumnpoem/codex-autocontinue/blob/main/codex_charge/desktop_input.py)、[quota.py](https://github.com/Autumnpoem/codex-autocontinue/blob/main/codex_charge/quota.py)、[watch.py](https://github.com/Autumnpoem/codex-autocontinue/blob/main/codex_charge/watch.py)、[LICENSE](https://github.com/Autumnpoem/codex-autocontinue/blob/main/LICENSE)。

## 迁移顺序

1. 保留 Python 模块和现有 CLI，增加 `--stdio` 桥接入口，报告能力与版本。
2. 导出规范化 `quota.snapshot` 和 `quota.exhausted` 事件，包含全部阻断窗口，缺失数据标未知。
3. 自动继续插件仅请求 `run.resume`，由看板核心根据任务身份、权限和预算决策；插件不再直接决定向哪个窗口发送。
4. Codex 适配器实现指定会话的继续与开始事件确认，原桌面按键路径保留为显式启用的有限兼容模式。
5. 持久化等待状态、幂等键和恢复结果；重启后先查询，不重复触发。
6. 将插件与 CLI 分别打包测试，迁移原配置时保留用户设置；回滚时仍能独立使用原项目。

插件可见状态：未启用 → 等待额度 → 复核条件 → 已请求恢复 → 已确认运行；分支为用户暂停、等待审批、已完成、恢复失败、执行状态未知。

## 必须通过的验证

- 两个额度窗口都耗尽时，不在最晚窗口恢复前重启。
- 额度重置时间变化、系统时间变化或睡眠唤醒后，重新确认实际状态。
- 任务已结束、用户主动暂停或仍待审批时不继续。
- 同一任务多次触发只产生一个有效恢复请求；上游回执丢失时先对账。
- 找不到会话、登录失效、RPC 挂起、发送失败各有可区分状态。
- Windows、Ubuntu、macOS 的协议接入分别实测；不能用 Linux 输入实现推断 Wayland 可用。
- UI 的“恢复成功”有对应运行事件；用户可查看关联任务和恢复记录。
