# Contributing / 参与贡献

## 中文

欢迎通过 [Issues](https://github.com/Autumnpoem/seqivo-public/issues) 反馈问题，或提交聚焦的 Pull Request。本项目自有代码采用 [PolyForm Noncommercial 1.0.0](LICENSE)，贡献也按同一许可提供；第三方代码保留原许可。

### 提交问题与改动

- 报告问题时，请说明应用版本、操作系统、复现步骤、预期结果和实际结果。分享日志或截图前，删除访问令牌、项目内容、绝对路径及其他个人或机密信息。普通问题请提交 Issue；安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。
- 小型文档修正可直接提交 PR。代码改动请说明用户可见行为、影响范围及如何验证；涉及数据迁移、执行控制、凭据或远程同步的改动，请特别说明失败和恢复情形。
- PR 应聚焦一个主题，附上简洁摘要和验证结果。不要提交本机 `.taskboard/` 数据、`design/qa/` 原始记录、令牌、数据库、构建产物或未脱敏日志。
- 提交前检查改动和暂存文件，确认没有本地数据或秘密。维护者会按项目需要审阅；本仓库未承诺响应时限。

### 本地验证

项目要求 Node.js 24 或更新版本，并使用 pnpm。按改动范围运行：

```sh
pnpm test
pnpm build
pnpm test:e2e
```

`pnpm test` 运行 `tests/*.test.mjs` 的 Node 测试；它不连接真实 AI 服务。`pnpm build` 执行 TypeScript 检查并生成 Vite 构建。`pnpm test:e2e` 运行看板端到端测试，需本机具备其所需浏览器环境。文档改动请检查链接和示例是否与现有说明一致；无需为纯文档改动声称运行了代码测试。真实 AI 执行验收需隔离环境和单独授权，常规测试不会执行真实 AI 任务。

### 项目说明

项目背景和入门步骤见 [README](README.md) 与[使用指南](docs/getting-started.md)。个人学习、实验及非商业修改可以进行；商业用途不在许可范围。不要提交你无权按上述条款提供的内容，保留依赖的版权和许可说明。

## English

Report bugs in [Issues](https://github.com/Autumnpoem/seqivo-public/issues) or submit a focused pull request. Seqivo-owned code and contributions use [PolyForm Noncommercial 1.0.0](LICENSE); third-party code retains its original license.

### Issues and changes

- When reporting a problem, include the app version, operating system, reproduction steps, expected result, and actual result. Before sharing logs or screenshots, remove access tokens, project content, absolute paths, and other personal or confidential information. Use Issues for ordinary bugs and follow [SECURITY.md](SECURITY.md) to report vulnerabilities privately.
- Small documentation fixes can be submitted as a PR. For code changes, describe the user-visible behavior, scope, and verification. For changes involving data migration, execution control, credentials, or remote sync, explain failure and recovery behavior.
- Keep each PR focused and include a concise summary and verification results. Do not commit local `.taskboard/` data, raw `design/qa/` records, tokens, databases, build artifacts, or unredacted logs.
- Review your changes and staged files before submitting to ensure they contain no local data or secrets. Maintainers review contributions as project needs allow; no response-time commitment is made.

### Local verification

The project requires Node.js 24 or later and pnpm. Run checks appropriate to the change:

```sh
pnpm test
pnpm build
pnpm test:e2e
```

`pnpm test` runs the Node tests in `tests/*.test.mjs`; it does not connect to a real AI service. `pnpm build` runs the TypeScript check and creates the Vite build. `pnpm test:e2e` runs the board end-to-end test and requires its browser environment locally. For documentation changes, check links and examples against the existing docs; do not claim code tests for a docs-only change. Real AI execution validation requires an isolated environment and separate authorization; routine tests do not run real AI tasks.

### Project information

See the [English README](README.en.md) for project context and the [getting started guide](docs/getting-started.md) for usage. Personal study, experimentation and noncommercial modifications are permitted; commercial use is not licensed. Submit only content you have the right to provide under these terms, and preserve dependency copyright and license notices.
