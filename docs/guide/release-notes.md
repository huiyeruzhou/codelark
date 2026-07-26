# Release Notes

## Unreleased

### 用户可见变化

- `/t` 不再为会话表同步读取整份 Codex/Claude/Kimi JSONL；冷缓存时“用户输入轮数”暂显示 `-`，后台统计完成后刷新即显示精确值。真实 1.6GB Codex 历史下，51 条候选的列表耗时从约 13.1 秒降至约 107 毫秒。
- 修复 `/t` runtime 下拉 ID 超过飞书限制导致整张卡创建/更新失败；renderer 现在统一保证 element ID 合法。
- `/every`、`/then`、`/status`、会话活动时间、tmux/pty screen、hot-update、streaming footer 与 Web 状态页统一使用 bridge 启动时解析的本地时区。
- `tmux 自动回车`不再作为用户配置；普通 tmux 文本固定补 Enter，显式 Enter 不重复。`/current` 通用配置固定按“对话名称、工作目录、tmux 输出行数”显示。

### 可靠性与验证

- 飞书按钮、下拉和表单回调新增独立 2 秒响应预算与日志；授权确认不再在 ACK 前同步写配置。
- 所有 CardKit/interactive card 请求上限收紧为 10 秒，可降级的 `card.idConvert` 上限为 2 秒，避免单个恢复请求占住同聊天 interactive queue 数十秒。
- 新增异步增量轮数缓存、CardKit 超时、callback ACK 矩阵、element ID、时区一致性和配置入口回归测试。

## v0.2.1

发布日期：2026-07-25

`0.2.1` 是 `0.2.0` 的可靠性与可读性补丁，重点修复自动更新终态、复杂 patch 展示和会话配置回退。

### 用户可见变化

- “立即更新并重启”现在持续显示更新日志和真实运行状态；安装失败会收口为错误卡，安装成功跨 bridge 重启后会把原卡更新为“更新完成”，不再永久停在“正在更新”。
- 多文件 `apply_patch` 按文件拆成独立代码块，每块使用目标文件后缀对应的语言高亮；所有代码块共享 8000 字符/160 行总预算。
- patch 标题主动控制文件名预算：完整放得下时全部显示，空间不足时显示一个完整文件名和“等 N 个文件”，不再由飞书截断半个 Markdown 反引号。
- `/current` 增加当前会话可覆盖的 tmux 输出行数、自动回车和输入回显。输入留空或下拉选择“跟随上层配置”会删除 session 覆盖并恢复上层有效值。

### 可靠性与验证

- long-running 更新任务复用统一 detached log monitor，覆盖 running/completed/error、worker 提前退出、超时、串行刷新和跨重启 operation receipt。
- 修复 npm 12 将 `npm pack --dry-run --json` 顶层结果从数组改为包名对象后，包内容检查脚本无法解析的问题，同时保留 npm 11 数组格式。
- 隔离飞书真实端已从用户身份回读 TypeScript/Python 多文件 patch 卡：一组四工具、两个语言块共享 160 行预算，普通工具输出和 transport envelope 不泄漏。
- 隔离飞书真实端已回读 `/current` 卡：通用 tmux 配置、“跟随上层配置”、保存/刷新按钮和继承值提示均由 CardKit 正常渲染。空值删除 session 覆盖的完整语义由 workflow 回归测试验证。

### 升级

```bash
npm install -g --yes codelark@0.2.1 && codelark
```

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
