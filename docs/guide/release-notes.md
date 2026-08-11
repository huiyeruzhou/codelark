# Release Notes

## Unreleased

## v0.3.0

发布日期：2026-08-11

`0.3.0` 的核心升级是 Multi-Agent 协作：CodeLark 不再只连接“一个群聊里的一个 Agent”，而是让多个独立任务群能够被发现、明确选择并通过内部 lane 互相委派工作。消息不会依赖飞书 Bot 回投，Agent 也不需要看到全量群聊目录。

### Multi-Agent 协作

- 所有运行中的 Bridge 注册到不随 `CODELARK_HOME` 改变的本机服务发现目录。`codelark sessions` 支持按 Home、真实群名、Bot 名、runtime、状态和关键词组合筛选；结果只暴露一个可直接用于发送的稳定 `target`。
- Agent 可以向另一个 CodeLark session 发送普通输入或 `/stop`、`/model` 等 slash 命令，也可以先用 `/new` 创建专用任务群再委派。CodeLark skill 会区分跨群 Agent 与 runtime 自带 subagent，不会把两套机制混用，也不会擅自占用主题相近的旧群。
- 目标选择严格核对真实 chat-name 与 bot-name。无法精确确定或存在多个候选时，使用选择卡让用户确认，并允许输入其他名称重新查询；不会因为单个 fuzzy result 匹配了错误字段就直接发送。
- 源群显示“Agent 消息已发送”，目标群显示“收到 Agent 消息”。两张卡均包含来源/目标群聊、Bot 和真实消息正文；长内容可折叠但不会截断。binding UUID、飞书 `oc_...` 群 ID 和 Bridge/session UUID 均可作为兼容输入，展示仍统一为一个 canonical target。
- 跨 Agent 消息默认是旁路协作，不自动移交当前主线，也不会携带未被用户指代的完整上下文或权限。收到其他群的来源 metadata 同样不会自动获得修改当前状态、索取上下文或打断主线的权限。

### 消息、附件与自动化

- CodeLark 通用消息能力合并到统一 `codelark` skill，覆盖飞书文本、富文本、卡片、图片、文件、问题卡片、自动化卡片和 Agent 通讯。setup wizard 默认安装它与职责单一的 `condition-monitor`，npm 升级后首次启动会自动刷新已安装 skill。
- `<clk-send>` 使用飞书官方 `msg_type + content`，不维护易过期的消息类型白名单；SDK 与 tmux/mirror 路径都会真正发送文本。图片和文件支持通过 `local_path` 上传，旧 `type + path` 继续兼容；本地预览或路径展示不再被误认为已经交付。
- 新增独立 `condition-monitor` skill：根据用户描述生成只读 Python 条件脚本，条件为 false 时保持静默，变为 true 时向指定群聊或 Agent 发送一次文本/卡片并自动停止。任务使用稳定 UUID、持久保存并在 Bridge 重启后恢复；飞书 UUID 与 Agent receipt 保证通知不会因发送后重启而重复。
- 新增 `codelark send` 与 `codelark monitor` 脚本接口，便于后台程序复用同一服务发现、消息发送和持久监控能力。

### 可靠性与体验

- Codex TUI 中“目标更新失败”等非致命诊断以正文横幅展示，不再把仍然成功完成的 turn 误报为失败终态。
- Codex 在启动时完成自更新并正常退出后，tmux provider 会重新启动新版 TUI，不再把成功更新识别成启动失败。
- 群头像上传结果按内容缓存，减少 `/new` 重复等待；头像内容变化时缓存键也会变化，因此更新后的头像仍会重新上传。
- 引用飞书特殊消息时，提示模型使用当前群 Bot 或用户身份通过 lark-cli 读取，避免误用无权限的测试身份。

### 升级

```bash
npm install -g --yes codelark@0.3.0 && codelark
```

## v0.2.2

发布日期：2026-08-04

`0.2.2` 聚焦运行时完整性、长任务反馈和运维可观测性：正式补齐 Cursor Agent，修复 Kimi 与跨 runtime 接管的生命周期边界，并同步升级飞书卡片、Operator UI、配置入口和日志合同。

### Change list

- 新增 Cursor Agent 支持，可以创建、接管和恢复 Cursor session；首次工作区索引时会持续显示当前状态，不再看起来像卡死。
- 完善 Kimi Code 和跨 runtime 会话生命周期，修复重启接管、会话切换、tmux 丢失和错误终态。
- 显著优化会话与飞书链路性能：`/t` 不再同步扫描大体积历史，慢回调和卡片 API 也不会长时间阻塞聊天。
- 重新设计 Operator UI，并统一 `/current`、`/set` 和网页配置界面；现在可以直观看到各 runtime 的状态、会话和有效配置。
- 优化卡片与长任务反馈：统一时间和状态栏，补充错误、重连、模型不一致与工作区索引提示。
- 流式附件可以在模型运行中及时发送；`/then` 仍会等待当前 turn 结束，不会在模型只输出一半时提前触发。
- 优化结构化日志，保留关键原始信息并兼容旧日志分析，方便定位飞书、tmux 和 session 问题。
- 收紧聊天与 session 绑定：拒绝重复绑定，不再用通配 channel 接管未知聊天；云文档建群时直接加入相关用户，不再发起冗余成员邀请。
- setup 和 runtime 统一使用标准 `~/.lark-cli` 环境，移除 CodeLark 私有 lark-cli 配置投影与 shim，避免覆盖或分叉用户已有授权。
- Cursor、Kimi、Codex 和 Claude 的关键路径均经过真实 executable/协议测试；Cursor 和配置卡片还完成了真实飞书端验证。

### 升级

```bash
npm install -g --yes codelark@0.2.2 && codelark
```

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
