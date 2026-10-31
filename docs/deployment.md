# 部署自己的 Hub

Hub 使用独立 Node 24 服务、SQLite 持久化、多租户配对和撤销，不需要桌面环境。配置示例需在目标服务器逐项安装并现场验证。


## 你需要准备什么

本仓库不提供可共用的官方服务器地址或管理员账号。只有需要手机跨网络查看、远程控制或手机 SSH 时才需要部署 Hub；单机文件看板可以跳过本页。

准备一台你可以管理的 Linux 服务器、有效的 HTTPS 域名或 IP 证书、Node.js 24，以及对应的云安全组和防火墙规则。使用你自己的地址替换文中的示例，不要把凭据写进仓库。先构建独立 Hub 包，再按下文安装服务和 TLS，最后在浏览器注册账号，并在电脑端“手机连接”选择同步项目。

历史部署与安全证据见 [安全说明](../SECURITY.md) 和 [SSH 验证记录](ssh-terminal-test-results.json)；这些记录不代表你的服务器已经部署或通过验收。当前发行内容见 [公开发行记录](public-release-status.json)。

## 防火墙与访问范围

保留云安全组，并启用主机防火墙；不能通过关闭防火墙来排查网页连接。先确认 SSH 实际端口，保留当前连接，再配置规则。以下仅适用于 SSH 使用 22 端口、没有其他对外服务的专用 Hub；如有既有服务，应先核对其必要规则，不要重置整套防火墙。

```sh
sudo ufw limit 22/tcp comment 'Rate-limited SSH administration'
sudo ufw allow 80/tcp comment 'ACME certificate validation and HTTPS redirect'
sudo ufw allow 443/tcp comment 'Seqivo HTTPS'
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw default deny routed
sudo ufw logging low
sudo ufw enable
sudo ufw status verbose
```

启用后用另一个 SSH 连接验证登录，并检查 HTTPS、匿名 API 返回 401、已配对设备仍可同步。IPv6 启用时也应有对应规则。80 端口只用于证书验证和 HTTPS 跳转，任务通信使用 443；4318 保持回环监听。SSH 限速不能替代可靠的认证；变更密码/密钥登录策略前，应先确保所有管理者有可用的恢复途径。[Ubuntu 防火墙文档](https://ubuntu.com/server/docs/how-to/security/firewalls/)

通信和服务器可见范围见 [安全说明](../SECURITY.md)。HTTPS 加密传输，但当前 Hub 不是端到端加密存储。

## 生成独立 Hub 运行包

在已审核的干净检出中使用 Node 24，先按锁文件安装依赖并构建网页。打包器要求输出到一个尚不存在、位于源码目录之外的目录；它不会覆盖现有产物，也不会自动部署：

```sh
pnpm install --frozen-lockfile
pnpm build
umask 077
SEQIVO_BUNDLE_PARENT="$(mktemp -d)"
SEQIVO_SOURCE_COMMIT="$(git rev-parse HEAD)"
node scripts/prepare-hub.mjs \
  --output "$SEQIVO_BUNDLE_PARENT/hub" \
  --source-commit "$SEQIVO_SOURCE_COMMIT"
(cd "$SEQIVO_BUNDLE_PARENT/hub" && \
  node --input-type=module -e "await import('./server/hub/http.mjs'); await import('ssh2'); await import('ws')")
COPYFILE_DISABLE=1 tar -czf "$SEQIVO_BUNDLE_PARENT/seqivo-hub.tar.gz" \
  -C "$SEQIVO_BUNDLE_PARENT/hub" .
```

`--source-dir`、`--dist-dir`、`--modules-dir` 可分别指定冻结源码、同版网页和已安装依赖。包内包含 `server/`、`dist/`、备份脚本，以及 SSH/WebSocket 的纯 JavaScript 运行依赖和许可证，包括 Node ESM 使用的 `ws/wrapper.mjs`。只验证 CommonJS `require('ws')` 无法发现 ESM 入口缺失。

`seqivo-release.json` 记录每个文件的 SHA-256、依赖版本和调用者提供的 commit。commit 字段本身不证明输入属于该提交；应保留干净检出或冻结源码清单，并核对实际文件哈希。打包器拒绝隐藏运行文件（如 `.env.local`、`.env.production`）、常见密钥路径、测试夹具和 native 扩展，但文件名检查不能识别所有秘密：只使用经过审查的源码和构建输出，不要把数据目录或凭据混入输入。

新增打包回归 5/5 通过；从仓库外的同版产物动态加载 Hub、SSH 和 WebSocket 成功，运行文件与已部署版本一致。部署前仍需在目标 Linux 上先加载模块，再备份、停止旧服务和验证新版本；不要把打包成功当作上线或原生端验收完成。详见 [交付记录](qa/ssh-terminal/integration-delivery.json)。

## Ubuntu + HTTPS

1. 安装 Node.js 24、Caddy，创建专用低权限 `tuijin` 系统用户。将构建后的 `dist/`、`server/`、`scripts/hub-backup.mjs` 及由锁文件生成的完整生产运行依赖一起放到 `/opt/tuijin/`；启用通用 SSH 时必须包含 `ws`、`ssh2` 及其递归所需的纯 JavaScript 依赖（完整 `node_modules` 运行闭包），不能只复制 `server/` 和 `dist/`。将 `/var/lib/tuijin-hub` 的所有者设为 `tuijin`，权限 0700。
2. 按实际域名修改 `deploy/Caddyfile.example`。Caddy 终止 TLS，Hub 仅监听回环地址；不要把 4318 端口开放到公网。
3. 将 `deploy/hub.env.example` 复制为 `/etc/tuijin/hub.env`，设置相同 HTTPS 域名；安装 `deploy/tuijin-hub.service`。无需填写任何 AI 提供方密钥，模型仍由项目电脑执行。
4. 以 `tuijin` 用户运行 `node server/hub/index.mjs bootstrap --data-dir /var/lib/tuijin-hub --tenant-id personal`。命令只输出管理员令牌文件的位置，文件权限为 0600。管理员在网页“访问令牌”中使用它；不要把管理员令牌发给其他设备。
5. 启动服务并检查 HTTPS 网页。管理员生成“项目电脑”配对码，选择项目 ID；电脑在“手机连接”页填写服务器地址和配对码。项目 ID 可在看板背景/导出中查看。
6. 管理员再生成“仅查看”或“查看和操作”的手机配对码。手机用同一网址的“手机配对码”登录，只能访问获授权的项目。

租户的配对、命令、快照相互隔离。每个供应商客户应分配独立 tenant，不共享 owner 文件。v0.3 默认提供公开注册和账号密码登录，注册自动创建独立空间；可用 `--disable-registration` 关闭新用户注册。仍无付费套餐或供应商计费界面。已有空间迁移及设备登录见[账号说明](accounts-and-conversations.md)。失效或泄漏的设备令牌应在管理页撤销；断开电脑时会请求服务器撤销自身，服务器不可达时会明确保留待撤销状态。

反向代理需覆盖 `X-Forwarded-For` 为真实来源地址，并让 Hub 仅监听回环地址；示例服务使用 `--trusted-proxy` 后才信任来自回环代理的单个 IP，供登录限速使用。不要将此设置用于可被公网直连的未受控代理。

## 无域名：公网 IP + Let's Encrypt HTTPS（Ubuntu/nginx）

没有域名时，可为可路由的公网 IPv4 申请 Let's Encrypt IP 证书。示例中的 `203.0.113.10` 是文档保留地址，必须在所有命令和 nginx 配置中替换为服务器真实公网 IPv4；此地址不能实际用于公网部署。服务器安全组和主机防火墙需允许入站 TCP 80（HTTP-01 验证）及 TCP 443（HTTPS）。Hub 仍只监听 `127.0.0.1:4318`，不要向公网开放 4318。

Let's Encrypt 的 IP 证书有效期为 6 天。webroot IP 签发要求 Certbot 5.4 或更高版本；nginx installer 不支持 IP 证书安装，因此这里由 Certbot 写入证书、nginx 手动加载证书。按官方说明先用 staging 验证，再去掉 `--staging` 申请正式证书。[Certbot/IP 证书说明](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)

1. 按前文准备 `tuijin` Hub 服务及数据目录，安装 nginx。为 Certbot 建立独立 Python 虚拟环境并从官方 HTTPS PyPI 索引安装 5.4+，避免改动全局 Python 包或其他 provider/index 配置：

   ```sh
   sudo apt install python3-venv
   sudo python3 -m venv /opt/certbot
   sudo /opt/certbot/bin/python -m pip install --index-url https://pypi.org/simple 'certbot>=5.4'
   sudo install -d -o www-data -g www-data -m 0755 /var/lib/letsencrypt/.well-known/acme-challenge
   ```

   以下命令假定 Certbot 可执行文件为 `/opt/certbot/bin/certbot`。

2. 将 `deploy/nginx-ip-http.conf.example` 安装为 nginx 站点配置，并将 `server_name` 中的示例地址替换为真实公网 IPv4。先启用此仅 HTTP 配置并执行 `sudo nginx -t && sudo systemctl reload nginx`。确认公网 TCP 80 可达，且 `/.well-known/acme-challenge/` 路径由 `/var/lib/letsencrypt` 提供。

3. 先向 staging 签发测试证书，再以相同参数申请正式证书。命令中的地址需替换为真实公网 IPv4：

   ```sh
   sudo /opt/certbot/bin/certbot certonly --staging \
     --config-dir /etc/letsencrypt-staging \
     --work-dir /var/lib/letsencrypt-staging \
     --logs-dir /var/log/letsencrypt-staging \
     --preferred-profile shortlived --webroot \
     --webroot-path /var/lib/letsencrypt --ip-address 203.0.113.10
   sudo /opt/certbot/bin/certbot certonly \
     --preferred-profile shortlived --webroot \
     --webroot-path /var/lib/letsencrypt --ip-address 203.0.113.10
   ```

   staging 使用独立的配置、工作和日志目录，避免测试证书被正式 nginx 配置误用。第二条命令不带 `--staging`，会申请浏览器信任的正式证书。Certbot 可能提示输入邮箱或接受账户条款，按命令行提示处理。

4. 将 `deploy/nginx-ip-https.conf.example` 安装为 nginx 站点配置，同样替换所有示例 IP。配置使用 `/etc/letsencrypt/live/<真实公网IPv4>/fullchain.pem` 和 `privkey.pem`，HTTP 请求会跳转到 HTTPS。运行 `sudo nginx -t`，确认通过后 reload nginx，并检查 `https://<真实公网IPv4>/` 可访问，再让配对设备使用这个 HTTPS origin。

5. 配置成功续期后 reload nginx 的 deploy hook，并启用仓库提供的 `tuijin-certbot-renew.service` 与 `.timer`。将下面脚本保存为 `/etc/letsencrypt/renewal-hooks/deploy/tuijin-nginx-reload`，设置为 root 所有且权限 0755：

   ```sh
   #!/bin/sh
   set -eu
   /usr/sbin/nginx -t
   /usr/bin/systemctl reload nginx
   ```

   安装两个 systemd 单元至 `/etc/systemd/system/` 后执行 `sudo systemctl daemon-reload && sudo systemctl enable --now tuijin-certbot-renew.timer`。timer 每日检查两次；deploy hook 仅在证书成功更新后运行。用 `sudo /opt/certbot/bin/certbot renew --dry-run --run-deploy-hooks --no-random-sleep-on-renew` 立即验证续期与重载流程，并检查 `systemctl list-timers tuijin-certbot-renew.timer`。

IP 证书续期依赖 TCP 80、webroot 和 timer 正常工作；部署后需监控 timer/service 失败，避免 6 天证书过期。桌面配对后，个人地址会保存在桌面端 `remote-link.json`；手机/PWA 使用托管 Hub 的 HTTPS origin，不需要原生手机 App。手机或新设备首次连接仍按前文生成配对码。服务器运行、云端连通和实体手机验收须在目标环境实际验证。

## 运维与备份

更新 Hub 时，部署包必须保留 `server/`、`dist/`、`scripts/hub-backup.mjs` 和锁文件对应的完整生产运行依赖。SSH 功能还需要 `ws`、`ssh2` 与它们递归依赖的纯 JavaScript 包；只复制 `server/` 和 `dist/` 会留下运行时缺项。只替换网页和服务代码、却遗漏 `scripts/`，会使已启用的备份定时器在下次执行时失败。停止或替换应用前先实际运行备份服务并确认成功；更新后再次运行，不能仅用 timer 的 `active` 状态判断备份可用。保留旧部署目录和完整数据备份，健康检查失败时回滚应用；不要覆盖部署目录之外的认证、HTTPS 或防火墙配置。

`node scripts/hub-backup.mjs --data-dir /var/lib/tuijin-hub --output /safe/backup-directory` 使用 SQLite 在线备份 API，并复制管理员令牌文件。v2 备份还包含 SSH 主机凭据密文与 vault key；两者同处备份意味着备份副本具备解密能力，必须与在线凭据库同等级或更严格保护。目录权限应为 0700，文件为 0600。备份包含任务文字和访问凭据，不要存进公开仓库。

备份脚本以只读连接打开数据库。systemd 仍允许同一服务用户写入 Hub 数据目录，以便服务刚关闭或重启、WAL/SHM 文件不存在时，SQLite 能创建必要的协调文件；仅将整个目录挂载为只读会使此时的备份失败。[SQLite 的只读 WAL 条件](https://www.sqlite.org/wal.html#read_only_databases)

安装 `deploy/tuijin-hub-backup.service` 和 `deploy/tuijin-hub-backup.timer` 到 `/etc/systemd/system/`。先建立仅 `tuijin` 可访问的本机备份目录，再启用每日备份 timer：

```sh
sudo install -d -o tuijin -g tuijin -m 0700 /var/backups/tuijin-hub
sudo systemctl daemon-reload
sudo systemctl enable --now tuijin-hub-backup.timer
systemctl list-timers tuijin-hub-backup.timer
```

服务将每次备份写入 `/var/backups/tuijin-hub/` 下的时间戳目录，文件权限受 `UMask=0077` 保护。该目录在本机，无法保护整台服务器丢失；当前没有自动保留/清理策略，应另行安全复制到独立存储并管理保留期限。

恢复前停止 Hub，将备份数据库和令牌文件复制到一个空的数据目录，再以原服务用户启动。离线前正在发送的 AI 请求可能仍在项目电脑执行；恢复不能作为“已停止”的证据。手机重新连接后应先核对未知命令，避免重复继续。项目电脑离线时，手机显示最近同步内容与时间；远程继续默认拒绝，用户明确选择限时排队才保存请求。

正式公开分发桌面包前仍需解决上游 LICENSE 冲突标记和平台签名；部署自己的 Hub 不等于完成公网/实体手机验收。
