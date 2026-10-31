# v0.3.0 账号与远程对话验证

验证日期：2026-09-26。结果仅覆盖下列范围，不代替用户人工验收，也不代表其他 AI 工具或所有操作系统已验证。

| 范围 | 结果与证据 |
|---|---|
| 单元及集成 | `pnpm test`：167 通过，0 失败，0 跳过；包含账号/会话隔离、密码哈希、登录限速、退出/改密、设备撤销、过期、任务版本、会话与目录变更、插件故障、幂等及恢复。 |
| 手机网页 | Chromium、WebKit 手机视口通过注册、账号登录、电脑登录授权项目、新建对话、输出回传、暂停、后续消息、刷新登录态、退出与日夜布局；这些可重复流程使用协议测试替身。 |
| 真实 Codex | 手机视口网页 → 本地真实 Hub → 桌面 Core → Codex，在一次性项目中将 `demo.js` 导出值从 1 改为 2，再在同一会话改为 3；两轮输出返回网页，没有重复任务，人工验收仍未通过。最终运行 12:17:41–12:21:06 UTC，通过且清理正常。 |
| 原有界面 | Chromium 的任务闭环、插件/协作/备份、远程配对/验收/撤销、验证待办四组回归通过。 |
| 公网 HTTPS | 已部署的自托管服务通过公开注册、独立空空间、原项目不可见、Secure/HttpOnly/SameSite Cookie、改密使旧会话失效、旧密码拒绝、新密码登录、退出撤销；临时验收账号已精确清理。 |
| macOS arm64 | v0.3.0 原生构建通过；升级后 25 项任务、11 项人工验收、既有设备连接与关闭的自动继续策略保留。最终原生退出、后台进程清理、锁文件释放和重启连接均通过；并修复退出时对话读取阻塞后台收尾的问题。 |
| 独立安全复审 | 83 项定向检查通过；在可信控制者的限定范围内未发现剩余上线阻断项。最后一次同步校验空绑定格式后，完整 Core/插件网页流程与 167 项测试、真实 Codex 两轮修改再次通过。 |

原始执行日志保留在本机 `design/qa/account-conversations/`（不提交敏感运行产物）；可提交的摘要为 [JSON 结果](accounts-conversations-results.json)。可重复命令：

```sh
pnpm test
pnpm build
node tests/e2e/accounts-conversations.mjs
TEST_BROWSER=webkit node tests/e2e/accounts-conversations.mjs
node tests/e2e/board.mjs
node tests/e2e/features.mjs
node tests/e2e/remote.mjs
node tests/e2e/verification.mjs
```

真实执行脚本 `scripts/verify-real-mobile.mjs` 必须单独设置 `SEQIVO_REAL_MOBILE_TEST=1`、`SEQIVO_TEST_CODEX` 和 `SEQIVO_TEST_PYTHON`；它会消耗真实模型额度，只在新建临时项目中执行两个回合，结束后清理。

## 未验证或未提供

- 实体 iPhone/Android 的蜂窝网络、锁屏恢复和长时间后台行为，列入“手机查看与受控继续”验证待办。
- Windows、Ubuntu、macOS Intel 原生安装与使用；GitHub 云端 CI 仍暂停。
- Claude Code、Cursor 的真实已登录执行，以及真实五小时额度恢复周期。
- 服务器与该版本桌面的真实代码修改链路尚未以实体手机执行；公网账号/同步与本机真实 AI 链路分别验证。
- 无邮箱找回、多因素认证、手机审批放行、原生手机 App 或正式供应商计费/执行节点迁移。
- 项目写入限制不是本机文件读取隔离。操作账号可请求 AI 读取本机其他可读内容；只授予可信控制者。HTTPS 不提供服务器管理员不可读的端到端加密。
