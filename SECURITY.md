# Security / 安全

## 中文

### 私下报告

若发现疑似安全问题，请使用 GitHub 的 [私密漏洞报告](https://github.com/Autumnpoem/seqivo-public/security/advisories/new)。若入口暂时不可用，可提交一个只写“希望建立私密安全联系”的 Issue，不要写入漏洞细节、真实令牌或用户数据。请提供受影响版本、影响范围、复现步骤和可行的缓解方法，并先移除任何秘密或个人信息。项目不承诺响应时限。

### 凭据与数据

- 把访问令牌、配对码、密钥文件和数据库视为敏感信息。不要将它们放入源码、工单、截图、日志、提交或网址；分享诊断材料前检查并脱敏。
- MCP reporter 凭据只适用于读取项目背景、创建任务、汇报进度和添加证据。它不能验收任务或启动执行。仅在需要的本机工具中配置，并在怀疑泄露时撤销或轮换。
- Hub owner 凭据具有管理权限。只交给受信任的项目所有者；按需授予项目范围和查看者/控制者角色，优先使用较小权限。撤销丢失或不再需要的配对和主体凭据。撤销阻止后续访问，但不代表已经停止外部 AI 执行。
- 服务端验证 Hub 非回环连接需要 HTTPS。远程部署的 TLS、网络访问控制和安全备份由部署者负责；参见[部署指南](docs/deployment.md)及[远程协议](docs/remote-protocol.md)。
- 本地插件在用户机器上以本地进程运行，**不构成安全沙箱**。只启用你信任的插件和路径，并限制它们可访问的凭据与项目数据。

### 通信保密的范围

- 桌面至 Hub、手机至 Hub 的公网连接使用 HTTPS；部署示例仅启用 TLS 1.2/1.3。HTTP 入口只处理证书验证和跳转，不提供任务数据。云安全组与主机防火墙应保持启用。
- 没有有效设备凭据不能读取任务；服务端按租户、项目和设备角色检查权限。配对码限时且只能使用一次，设备可撤销。令牌不放在 URL，浏览器的静态缓存不保存 API 响应。
- **当前没有端到端加密或应用层数据库加密。** Hub 会保存所选项目的任务文本及远程命令正文；包括远程新增证据时输入的引用。服务器 root、可访问数据目录/备份的管理员能够读取这些内容。撤销权限不会自动删除已存储的历史记录或备份。
- 投影按字段筛选，不是通用秘密扫描器：任务摘要、方案或其他自由文本中直接写入的密码、密钥等仍可能同步。不要在这些字段中粘贴秘密。执行 AI 任务时，配置的模型提供方会收到执行所需的提示词。
- nginx 示例关闭站点访问日志；Hub 不记录请求正文。系统错误日志和防火墙日志可能保留地址、端口等诊断信息，不能据此承诺没有任何通信元数据。

### 账号与对话隐私

- 公开注册为每个账号创建独立空间。已有 Hub owner 应先用原访问令牌进入原空间，再在“账号”中绑定用户名和密码；直接注册会得到另一个空空间。账号密码不会作为浏览器会话令牌返回；密码使用带随机盐的 scrypt 哈希保存。
- 浏览器会话有效期为 7 天，使用 `HttpOnly`、`SameSite=Strict` cookie；HTTPS 部署设置 `Secure`。退出会撤销当前会话，修改密码会撤销该账号全部浏览器会话。已配对电脑和手机使用独立凭据，修改密码后仍有效；丢失设备须单独撤销。
- 完整对话仅向 owner/controller 开放；viewer 仍只查看任务进度。Hub 只为所选项目同步被请求查看的最多 5 项任务的可见对话内容。可见 AI 回复和工具输出可能包含源码、文件片段或生成的秘密；隐藏推理不共享。HTTPS 保护传输，**不提供端到端加密**；服务器 root 和有权读取数据库或备份的管理员仍可读取已同步内容。不要把秘密写入可能同步的提示词或输出。
- 当前没有邮箱找回或多因素认证。账号与对话操作说明见[账号与远程对话](docs/accounts-and-conversations.md)。真实 Codex 两轮代码修改与网页回传已在隔离项目通过；完整范围见[本轮验证](docs/accounts-conversations-validation.md)。

2026-09-26 的真实服务器复查已启用持久 UFW，验证了 TLS、身份/角色/项目边界与设备撤销；记录见[安全检查摘要](docs/private-hub-security-results.json)。这是一轮限定范围验证，不代表完整渗透测试或绝对安全保证。

## English

### Private reporting

Use GitHub [private vulnerability reporting](https://github.com/Autumnpoem/seqivo-public/security/advisories/new). If that entry is unavailable, open an Issue requesting a private security contact without disclosing vulnerability details, live tokens or user data. Include the affected version, impact, reproduction steps, and practical mitigations; remove secrets and personal information first. No response-time commitment is made.

### Credentials and data

- Treat access tokens, pairing codes, key files, and databases as sensitive. Do not put them in source code, tickets, screenshots, logs, commits, or URLs. Review and redact diagnostic material before sharing.
- MCP reporter credentials are limited to reading project context, creating tasks, reporting progress, and adding evidence. They cannot review or approve tasks or start execution. Configure them only in the local tools that need them, and revoke or rotate them if exposure is suspected.
- Hub owner credentials have administrative authority. Give them only to trusted project owners. Grant only the required project scope and viewer/controller role, using the least privilege needed. Revoke lost or unnecessary pairing and subject credentials. Revocation blocks future access but does not mean an external AI execution has stopped.
- The service requires HTTPS for non-loopback Hub connections. Deployers are responsible for TLS, network access controls, and secure backups; see the [deployment guide](docs/deployment.md) and [remote protocol](docs/remote-protocol.md).
- Local plugins run as processes on the user's machine; they are **not security sandboxes**. Enable only plugins and paths you trust, and limit their access to credentials and project data.

### Communication privacy boundaries

- Public desktop-to-Hub and phone-to-Hub connections use HTTPS; deployment examples allow TLS 1.2/1.3. HTTP only handles certificate validation and redirects, not task data. Keep both cloud network controls and the host firewall enabled.
- Task access requires a valid device credential and is checked by tenant, project, and role. Pairing codes expire and are single-use; devices can be revoked. Tokens are not placed in URLs, and static browser caches exclude API responses.
- **There is no end-to-end encryption or application-level database encryption.** The Hub stores selected task text and remote command bodies, including references entered when remotely adding evidence. Server root and administrators with data/backup access can read them. Revocation does not erase previously stored history or backups.
- Projection is field filtering, not general secret detection. Secrets pasted into task summaries, plans, or other free text may still sync. AI execution also sends the necessary prompts to the configured model provider.
- The nginx example disables site access logs, and the Hub does not log request bodies. System error and firewall logs may retain diagnostic metadata such as addresses and ports; this is not a promise of zero metadata.

### Account and conversation privacy

- Public registration creates a separate space for each account. An existing Hub owner should enter the original space with its owner token, then bind a username and password under **Account**; registering directly creates another empty space. Passwords are stored as randomly salted scrypt hashes, and browser session tokens are not returned in JSON.
- Browser sessions last 7 days and use `HttpOnly`, `SameSite=Strict` cookies; HTTPS deployments set `Secure`. Sign-out revokes the current session, and a password change revokes all browser sessions for the account. Paired computers and phones use separate credentials and remain connected after a password change; revoke lost devices individually.
- Full conversations require owner/controller access; viewers can only see task progress. The Hub syncs visible conversations for at most 5 requested tasks in selected projects. Visible AI replies and tool output may contain source code, file excerpts, or generated secrets; hidden reasoning is not shared. HTTPS protects transport but **does not provide end-to-end encryption**. Server root and administrators with database or backup access can read synced content. Avoid putting secrets into prompts or output that may sync.
- Email recovery and multi-factor authentication are not implemented. See [Accounts and remote conversations](docs/accounts-and-conversations.en.md). The real-provider browser flow remains unverified.

The live server review on 2026-09-26 enabled persistent UFW and checked TLS, identity/role/project boundaries, and revocation. See the [security check summary](docs/private-hub-security-results.json). These bounded checks are not a full penetration test or an absolute security guarantee.

手机新建的看板自有 Codex 会话使用项目目录写入沙箱，回合不开放网络或额外临时目录写入。此写入限制不隔离所有读取：操作权限可借助 AI 读取本机其他可读文件；只授权可信人员/设备，不能把 Hub 项目授权当作操作系统读取沙箱。既有外部会话继续沿用原权限，当前不支持在手机网页放行额外审批。
