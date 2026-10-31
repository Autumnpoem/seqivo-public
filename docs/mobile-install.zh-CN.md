# 手机安装与连接

[English](mobile-install.en.md) · [返回项目介绍](../README.md)

| 手机 | 当前使用方式 |
| --- | --- |
| Android 8.0 及以上 | 下载签名 APK；系统最低版本要求不等于所有手机均已验收。 |
| iPhone | Safari 打开自己的 Hub，可添加到主屏幕；当前没有原生 IPA 或 App Store 版本。 |

手机是远程客户端，电脑上的序程负责读取本地项目文件。要跨网络查看进度，需要一个手机和电脑都能访问、证书有效的 **HTTPS Hub**。安装 APK 不会自动创建服务器，也不会把电脑的项目自动上传。目前没有官方公共服务地址。只用电脑看本地任务时，不需要 Hub。

## 1. 先准备 Hub 和电脑

如果已有 Hub，向管理员取得它的 HTTPS 地址即可，不需要管理员令牌。自己部署请看 [Hub 部署指南](deployment.md)。以下 `https://board.example.com` 只是占位示例，不是真实服务。

1. 在浏览器打开自己的 Hub，按服务器允许的方式注册或登录账号。
2. 在项目电脑的序程中打开“手机连接”，填入同一个 Hub 地址并登录。
3. 明确选择要同步的项目。等电脑显示连接成功，再检查网页项目列表。
4. 手机上登录同一账号，选择这个项目，即可查看同步后的任务、证据和待处理事项。账号、配对码及权限说明见[账号接入指南](account-setup.md)。

电脑需要运行序程、保持联网，才能持续同步本地 AI 的新进度；AI 仍需按项目接入说明汇报。手机不会扫描电脑磁盘或自动读取所有聊天。手机控制电脑上的 Codex 还需单独启用执行插件和授权；手机经 Hub 连接独立 SSH 主机则不依赖这台电脑开机。

## 2. Android：下载安装

公开版本：**应用 0.4.1，内部版本号 15**，包名 `app.seqivo.android`。这是普通 release 构建，使用独立发布签名，关闭调试，不包含测试 CA 或预设服务器地址；不是 Google Play 上架版本。

1. 用手机打开[公开 Release](https://github.com/Autumnpoem/seqivo-public/releases/tag/v0.4.1-r2)，下载 **[Seqivo-0.4.1-android.apk](https://github.com/Autumnpoem/seqivo-public/releases/download/v0.4.1-r2/Seqivo-0.4.1-android.apk)**。
2. 在下载列表打开 APK。若系统要求，按提示允许这一次安装所使用的浏览器或文件管理器安装应用；不要关闭系统安全检查。安装后可关闭该来源的安装权限。
3. 打开“序程”，输入自己的 Hub **HTTPS 源地址**，例如 `https://board.example.com`。不要填路径、账号、密码或访问令牌。
4. 点击连接，在 Hub 登录页输入自己的账号密码，再选择已同步项目。首次安装不会继承 Chrome 的登录状态。
5. 以后打开 App 会使用已保存的服务器地址；登录过期时重新登录。更换地址使用应用右上角菜单。

如果没有项目，先回到电脑检查是否登录了同一 Hub/账号并选择同步；如果地址打不开，先确认手机浏览器能访问它。证书无效或 HTTP 地址会被拒绝，不应通过安装未知证书绕过。

### 从早期测试版切换

早期 debug v13/v14 与公开包的签名不同，**不能直接覆盖安装**。先确认服务地址、账号和密码可用，处理或另行保存未提交草稿；需要切换时，卸载旧测试 App，再安装公开 APK。卸载会清除该 App 本地的地址、登录和草稿，不会删除 Hub 已保存的任务。请不要把“清除本地数据”当作日常升级步骤。

后续同签名公开版本使用覆盖安装，保留本地数据。签名规则见 [Android 官方说明](https://developer.android.com/studio/publish/app-signing)。安装包校验值见同一 Release 的 `SHA256SUMS.txt`，发布证书与包体检查见[发布验证记录](android-public-release-results.json)。

## 3. iPhone：Safari 与主屏幕

1. 在 Safari 打开自己的 Hub HTTPS 地址并登录，选择项目。
2. 点 Safari 的分享按钮 → **添加到主屏幕**；如果系统显示“作为网页 App 打开”，可按需要开启，再点添加。
3. 以后点主屏幕“序程”图标进入。主屏幕网页可能要求单独登录；它仍使用同一个 Hub 和账号。

按钮位置以当前 iOS 为准，参见 [Apple 操作说明](https://support.apple.com/guide/iphone/iphea86e5236/ios)。这不是原生 iOS 安装包，不承诺离线编辑、后台常驻或推送。断网时需要写入的操作会等待网络恢复后由你确认，不会自动补发草稿。

## 发布检查范围

本次检查 Android release 构建、单元测试、静态检查、发布签名、版本信息、法律文件，以及包内没有私人地址和测试证书。历史 Android 实体机、模拟器与 iPhone 网页测试各有自己的版本范围，见[Android 历史记录](android-app.zh-CN.md)。本次没有在实体手机上重新安装这个新签名 APK，不把旧测试包的结果当作新包已完成全面验收。

桌面端自编译另见 [Windows](build-windows.zh-CN.md) / [Ubuntu](build-ubuntu.zh-CN.md)。
