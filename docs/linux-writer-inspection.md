# Ubuntu 工作目录占用检查 / Workspace writer inspection

2026-10-31：Linux 已能识别当前用户可见、可能修改项目的进程：工作目录位于项目内，或持有项目文件的可写句柄。只读句柄不计入。未安装或未能完整运行 `lsof`、输出不完整及权限告警仍返回“无法核实”，不会据此放行接管。

Ubuntu 22.04 普通账户实测发现，系统 tracefs 目录的权限告警会使检查失败。现在只在确认该固定 tracefs 挂载及其所有同设备挂载点均与项目目录无交集时，使用 `lsof` 的指定文件系统豁免；不隐藏其他告警，不更改权限、挂载或防火墙。参数含义见 [lsof 官方手册](https://lsof.readthedocs.io/en/stable/manpage/)，挂载点与设备字段见 [Linux mountinfo 手册](https://man7.org/linux/man-pages/man5/proc_pid_mountinfo.5.html)。

验证结果：

- Mac：14 项通过，1 项 Linux 原生用例按平台跳过；原 Mac 真实进程检查保持通过。
- Ubuntu 22.04 x86_64、Node 24.21.0、普通账户：13 项通过，2 项 Mac 原生用例按平台跳过。真实进程检查覆盖项目目录、可写文件、只读文件与中文路径；另一次隔离探针确认空目录选择与 tracefs 分离。
- 独立审查通过。测试在独立临时目录运行，完成后已移除；没有部署到线上服务或改动现有 Mac 安装包。

这是 Ubuntu 基础适配的一部分。后续 LINUX1073 已补齐[底层 tmux 身份与持久记录恢复](linux-session-recovery.md)；Linux 上层接管与 AI 停止证明、Ubuntu 桌面安装及 Windows 原生端仍待完成。检查结果也不代表整个系统没有写入者或今后不会发生写入。详细结果见 [机器记录](linux-writer-test-results.json)。

## English

Linux now observes currently visible processes whose working directory is inside the project or which hold writable project-file descriptors. Read-only descriptors are excluded. Missing tools, incomplete output and permission warnings remain unverified; they do not authorize takeover.

A real unprivileged Ubuntu run exposed an inaccessible tracefs mount warning. The implementation uses a narrowly scoped `lsof -e` only after confirming that the fixed tracefs mount and every mount sharing its device do not overlap the canonical workspace. Other warnings are still rejected. No system permissions, mounts or firewall settings are changed.

Targeted checks: macOS 14 passed / 1 Linux-only skip; Ubuntu 22.04 x86_64 with Node 24.21.0, 13 passed / 2 macOS-only skips. The live Ubuntu test used an unprivileged account and disposable directories, which were removed afterward. Independent review completed. This code has not been installed or deployed.

This is not complete Ubuntu terminal support. LINUX1073 subsequently added [low-level tmux identity and durable record recovery](linux-session-recovery.md). Linux application integration and AI stop proofs, native Ubuntu desktop and Windows acceptance remain pending. The observation does not prove system-wide or future exclusivity.
