# Contributing

感谢你愿意参与 CodeLark。这个项目是本地优先的 IM bridge，改动通常会同时影响 CLI、本地 bridge、飞书通道、运行时会话和文档。提交前请尽量把变更收敛到清晰的小阶段。

## 开发环境

- Node.js：公开支持基线是 Node.js 24+。
- 包管理器：使用 npm 和仓库里的 `package-lock.json`。
- 本地安装依赖：

```bash
npm ci
```

运行 Node 命令前建议先切到 Node.js 24：

```bash
unset NODE_OPTIONS
source ~/.nvm/nvm.sh
nvm use 24
```

## 常用命令

```bash
npm run typecheck
npm test
npm run build
npm run docs:build
```

`npm test` 会运行仓库内的单元、workflow、mock e2e、本地进程 e2e 和 harness 测试。本地进程 e2e 可能依赖当前机器是否安装了 Codex CLI、Claude Code 或 tmux；如果你的环境缺少这些依赖，请在 PR 里说明。

真实飞书 E2E 需要显式授权，默认不会无意发送真实消息：

```bash
CODELARK_REAL_FEISHU_E2E=1 npm run real:feishu:e2e -- --launch-bridge --scenario runtime-message
```

运行真实 E2E 前，需要准备飞书测试应用、测试用户授权、bot open_id、用户 open_id 和相关环境变量。可以先用下面的命令查看场景清单：

```bash
npm run real:feishu:e2e -- --list-scenarios
```

## 发布前检查

发布 npm 包前会运行：

```bash
npm run prepublishOnly
```

该命令包含 typecheck、完整测试、文档构建、生产构建和真实飞书 E2E。没有真实飞书测试环境时，发布检查会失败，这是预期行为；正式发布应在具备真实测试凭据的维护环境中执行。

检查 npm 包内容：

```bash
npm pack --dry-run --json
```

当前 npm 包只包含运行所需产物、脚本、schemas、skills、README、LICENSE 和 SECURITY，不打包 `docs/` 文档站。

## Node 版本

项目使用 Node.js 24 的内置能力，例如 `node:sqlite`。请不要用 Node.js 20/22 作为开发或发布环境；CI 也只把 Node.js 24 作为必过基线。

## PR 要求

- 说明用户可见行为变化，尤其是 CLI、配置、飞书权限、消息格式和本地数据迁移。
- 为功能改动补测试；跨模块行为优先补 workflow 或 mock e2e。
- 涉及真实飞书行为时，至少说明是否已运行真实 E2E；如果没有运行，说明原因和手工验证范围。
- 文档、README、命令帮助和 Web 工作台文案需要和行为同步。
- 不要提交本地凭据、日志、`STATUS.md`、`.work/` 或临时 `work/` 文件。

## Issue 排查信息

报告问题时，请尽量提供：

- 操作系统、Node.js 版本、`codelark --version` 或 npm 包版本。
- `codelark status` 输出。
- `~/.codelark/logs/bridge.log` 最近 50 行，注意先脱敏 token、App Secret、用户 ID 和 chat ID。
- 是否使用 Codex SDK、Codex pty/tmux、Claude SDK 或 Claude pty。
- 飞书事件订阅、权限和发布审批是否完成。

## 安全

请不要在公开 Issue 或 PR 中粘贴 App Secret、access token、refresh token、OpenAI API Key、Claude 凭据、飞书用户 token 或完整本地日志。安全问题请按 `SECURITY.md` 中的方式处理。
