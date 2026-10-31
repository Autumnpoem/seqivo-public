# Windows WSL tmux 终端

本功能为 Windows 终端配置增加一种独立目标：连接到用户明确选择的 WSL 发行版，并使用其中的 tmux。Windows 原生 Shell 是另一种配置；即使没有可用 WSL，原生 Shell 仍可单独配置和使用。

## 配置与使用

1. 在 Windows 本机的终端配置中选择 **WSL tmux**。界面会列出已安装发行版；选择目标发行版，并输入该发行版内已存在的 Linux 绝对工作目录，例如 `/home/alex/project`。不要填 Windows 路径，也不要假设磁盘一定挂载在 `/mnt/c`。
2. 保存时，应用会在该发行版中读取默认 Linux 用户名和 UID，并检查该目录存在。配置固定这组身份；之后若发行版、tmux 或 UID 不可用或发生变化，连接会报告不可用，需检查配置后再继续。
3. 连接后可列出已有 tmux 会话、创建会话、选择当前会话、设置默认会话并重新附着。新会话从配置的 Linux 工作目录启动；会话引用会绑定发行版、用户身份和 tmux 服务身份，目标变化后旧引用不会被当作有效会话。
4. 如通过手机连接，仍需使用既有设备登记和授权。WSL 配置本身不会扩大设备权限。设置或维护集成时，`GET /api/terminal/wsl` 用于查询 WSL 支持状态和发行版；创建/更新 profile 使用 `POST /api/terminal/profiles`，字段为 `runtime: "wsl"`、`wslDistro` 和 `wslCwd`。这些 API 应通过应用现有的认证与授权路径调用。

Microsoft 的命令参考说明了如何查看已安装发行版、指定发行版和 Linux 用户，以及运行 WSL 程序：[WSL 基本命令](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)。应用只列出本机已安装发行版，不会替用户安装发行版或 tmux。

## 能力边界

WSL profile 是独立终端，不关联受管项目；它不支持 AI 接管、交还或宿主进程停止证明。Hub 的 profile 投影只标记 `runtime: "wsl"`，Linux 用户、UID 和工作目录保留在本机配置中。独立 WSL 终端不是沙箱：终端中的程序仍能访问该 Linux 用户可访问的数据。不要把“可连接 tmux”理解为受管任务权限或进程隔离保证。

本轮的合成 Windows-owner 浏览器夹具通过：无 WSL 时原生配置仍可保存且独立；可选择发行版；拒绝 Windows 路径、接受带空格的 Linux 绝对路径；新 profile 不关联项目；编辑时 runtime/发行版固定并保留工作目录；WSL 不显示普通 Shell 或 AI 接管选项；390px 深色布局没有横向溢出。三次配置写入、截图和可访问性快照见[浏览器夹具结果](../.runtime/wsl1095/browser-result.json)。这不是实际 Windows 普通账户、真实 WSL 发行版或实体手机验收。

自动化测试使用模拟 WSL 命令和本机 PTY/tmux 夹具。前端最终构建通过；本轮没有打包、安装或部署此功能。
