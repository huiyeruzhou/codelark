# Release Notes

## v0.2.0

发布日期：2026-07-25

`0.2.0` 是一次跨运行时、跨平台和交互体验升级，重点改善长时间运行时的响应速度、工具调用可读性，以及 Windows、macOS、Linux 上的一致使用体验。

### 用户可见变化

- 优化飞书消息主链路和 tmux session 探测：消息确认、回复投递和状态更新不再同步拖住入站消息；只检查真实活跃或最近发生变化的 session，减少无效扫描和等待。
- 正式覆盖 Linux、macOS 和 Windows。macOS 使用原生 tmux；Windows x64 使用 psmux 提供兼容的 tmux 工作流，setup 会在缺失时帮助安装，runtime 启动、输入转发和路径处理均按平台验证。
- 完善首次配置向导：Linux 识别发行版包管理器并通过交互式 sudo 安装 tmux，macOS 可安装 Homebrew + tmux，Windows 使用 WinGet + psmux；完成后提供可直接打开机器人私聊的链接和 `/new`、特殊键、`/tmux-screen` 快速教程。
- 增强 Codex 工具调用展示：读取、搜索、命令和 patch 使用统一的中间结构与卡片渲染；折叠标题先给出有用摘要，展开后保留关键参数和修改内容；工具组、超长内容和 continuation 不再丢失工具边界。
- 完整接入 Kimi Code tmux runtime，统一 session 创建、恢复、输入投递、完成检测和 usage 结束语义；Codex、Claude Code、Kimi Code 共用同一套 BridgeSession 生命周期边界。
- 改进流式卡片状态：工具调用、思考和输出都会刷新最近响应时间；continuation、最终卡和异常终态使用一致的 footer，并避免重复状态文案。
- 新增每日版本检查：bridge 启动后在用户当天第一条消息时异步检查 npm；发现新版会显示“立即更新并重启”和“忽略此版本”，更新只执行全局 npm 安装与服务重启，不执行 git pull、build 或测试。
- 修复多行 patch 中 `${...}` 被飞书错误压成单行的问题，并保留按实际文件语言选择的代码高亮。

### 性能与可靠性

- 飞书 reply、reaction、callback ACK 和卡片更新从入站 lane 解耦，慢 OpenAPI 请求不会串行阻塞后续消息。
- tmux mirror 优先用文件状态判断 session 是否变化，只对绑定且活跃的 session 做必要探测；完成后的定时 flush 会及时清理。
- 测试支持按文件和运行时敏感场景分组并行，Windows 专门覆盖 `.cmd`、路径、粘贴边界和 psmux 语义。

### 验证范围

- GitHub Actions 在 Linux、macOS 26 arm64 和 Windows x64 + psmux 上安装并执行真实 Codex、Claude Code、Kimi Code CLI；模型服务由本地 fake proxy 保持确定性，三者的 tmux 生命周期不是 shim 或假 executable 冒充。
- 真实 executable gate 覆盖 Codex 正常输出、结构化/方块错误与长输入，Claude Code TUI + JSONL，以及 Kimi fresh 随机 session id、慢模型 steer、复用、tmux 丢失恢复和 wire 在首条输入前后两种创建时序。各平台还完成 typecheck、对应测试集、build、npm package 检查和打包 CLI smoke test。
- 每日版本卡已在隔离飞书群真实完成发送、用户身份回读、按钮点击、原卡更新和最终回读；callback 不会再额外创建重复卡片。
- Kimi 0.2.0 发布候选已在隔离飞书群通过真实 Kimi executable 完成 `/runtime kimi`、`/p tmux`、流式卡片创建、completed 原卡更新与用户身份最终 transcript 回读。

### 升级

```bash
npm install -g --yes codelark@0.2.0 && codelark stop && codelark start
```

首次安装或重新配置：

```bash
codelark setup
```

## v0.1.1

发布日期：2026-06-14

`0.1.1` 聚焦 tmux provider 的启动恢复、输入透传和文档可用性。npm 包版本为 `codelark@0.1.1`，对应 Git tag `v0.1.1`。

### 用户可见变化

- tmux provider 在 Codex 启动弹窗后会保留待转发输入；选择 `Skip` 后等待 TUI ready 再注入原消息，选择 `Update now` 后会提示并重新拉起 Codex。
- tmux capture 行数语义改为“最终希望看到的行数”。例如配置 20 行、当前 pane 高度为 10 时，只会额外请求 10 行历史，而不是把两个数相加。
- Codex TUI 显示 `Working` 但底部仍有输入行时，会被识别为可输入状态；普通消息可以继续透传到已有 tmux session。
- 新增会话、Provider 与配置工作流文档，集中说明 `/t`、attach/detach、`/provider`、`/tmux-screen`、`/tmux-set`、`/current` 和 home/session 配置层级。

### 验证范围

- GitHub Actions main CI 已通过：typecheck、stable tests、build、docs build、npm package contents。
- 发布前本地也完成过完整 `npm test`、`npm run build`、`npm run typecheck` 和 docs build。
- fake Codex TUI E2E 覆盖普通启动、delayed ready、update prompt、permission prompt、Working 输入行和启动弹窗后的 auto-forward 恢复。

### 升级

```bash
npm install -g codelark@0.1.1
```

或直接运行：

```bash
npx -y codelark@0.1.1 run
```
