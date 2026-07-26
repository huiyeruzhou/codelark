# 会话、Provider 与配置工作流

这页从日常使用角度串起 IM 会话、agent/provider、tmux pane 查看和配置层级。完整命令索引见 [命令体系](../product/commands.md)，provider 设计说明见 [运行时与提供方](../product/runtime-providers.md)。

## 核心概念

CodeLark 的 IM 对话由三层组成：

| 层级 | 含义 | 常用入口 |
| --- | --- | --- |
| Chat | 飞书私聊、群聊、话题或云文档评论入口。它只记录“这个聊天当前接到哪个 BridgeSession”。 | `/t`、`/t 1`、`/t unbind` |
| BridgeSession | CodeLark 管理的一条工作会话，保存工作目录、当前 runtime、provider、模型和底层 runtime 身份。 | `/new`、`/clear`、`/current` |
| Runtime session | Codex thread、Claude Code session 或 Kimi Code session，是底层 agent 自己的会话身份。 | `/t` 接管、`/his` 查看历史 |

`/runtime` 选择当前会话使用 Codex、Claude Code 还是 Kimi Code。`/provider` 选择当前 runtime 的驱动方式，例如 SDK、pty 或 tmux。切换 runtime 不会清空另一个 runtime 已记住的 provider；同一个聊天可以记住 Codex、Claude 和 Kimi 各自的 BridgeSession，来回切换时会尽量回到之前那条会话。

## 推荐日常流程

新聊天里可以按这个顺序开始：

```text
/status
/t
/t 1
/current
```

`/status` 看 bridge 和通道状态。`/t` 打开本地会话表；选择一条会话后发送 `/t 1` 或点击卡片中的选择项接管。`/current` 查看当前会话卡片；顶部“配置分栏”可分别编辑通用会话配置与 Codex、Claude Code、Kimi Code 配置。

如果要从空白会话开始：

```text
/new my-task ~/work/project
```

如果当前聊天已经在一个长对话里，但你想在同一个聊天上下文切到新对话：

```text
/clear my-next-task ~/work/project
```

`/clear` 不会删除旧对话；之后仍可用 `/t` 找回并 attach。当前 Kimi 会话显式设置过的 model 会随 active runtime 继承到新 BridgeSession，卡片和下一次 Kimi 启动不会退回 `default`。

## 会话列表和下拉选框

`/t` 默认显示当前 runtime 最近 20 条本地会话，并发送一张表格卡片：

- 会话下拉：选择表格中的某条本地会话，效果等同 `/t <序号>`。
- 数量下拉：切换显示 20、50 或 100 条，也可发送 `/t n 50`、`/t n 100`。
- runtime 下拉：切换列表查看 Codex、Claude Code 或 Kimi Code 会话，也可发送 `/t codex n 100`、`/t claude n 100` 或 `/t kimi n 100`。

表格首列会标出当前聊天正在绑定的会话，以及其他聊天已经绑定的会话。接管其他聊天绑定的会话时，如果目标还在运行会被拒绝；如果目标空闲，CodeLark 会先发确认卡片，确认后解绑原聊天并把会话 attach 到当前聊天。

“用户输入轮数”来自后台增量缓存。bridge 首次看到大型历史文件时，该列可能暂时显示 `-`，但 `/t` 和接管不会等待整份 JSONL；后台统计完成后刷新 `/t` 即显示精确轮数，后续只统计新增后缀。

runtime 和数量下拉只切换卡片里的候选列表，不会改变当前会话。选择具体目标并点击“接管”后才会修改 binding。如果当前会话仍在运行，CodeLark 会先询问是否停止；取消时旧任务和 binding 都不变，确认后会先停止旧任务，再把后续消息切到所选 runtime。

停止 Kimi Code 时，CodeLark 会按 Kimi TUI 约定连续发送两次 `Ctrl-C`；这会取消当前 turn 并保留可复用的 tmux 会话。Codex 和 Claude Code 仍只发送一次。

常用 session 管理命令：

| 操作 | 命令 | 说明 |
| --- | --- | --- |
| attach 本地会话 | `/t 1` | 按当前 `/t` 表中的序号接管会话。 |
| attach 指定会话 | `/t <thread_id|session_id>` 或 `/t <bridge_id>` | Codex 使用 thread_id；Claude/Kimi 使用 session_id；也可用名称匹配，冲突时先回到 `/t` 用序号。 |
| detach 当前聊天 | `/t unbind` | 当前聊天脱离原会话，并立即绑定到新的临时 BridgeSession；原会话保留，可再次 `/t` 接回。 |
| 临时会话 | `/t 0` | 切到隐藏的临时 BridgeSession。 |
| 重置临时会话 | `/t 0 reset` | 丢弃当前临时上下文并生成新的临时 BridgeSession。 |
| 归档当前本地会话 | `/t archive` | 归档当前绑定的本地 Codex/Claude/Kimi 会话，并解除相关绑定。 |
| 归档指定会话 | `/t archive 1` | 按当前 runtime 的 `/t` 表序号归档。 |
| 重命名当前会话 | `/t rename <名称>` | 群聊通道会同步修改群名，并自动带 bot 前缀。 |

## 新建、清空和接回旧会话

`/new <name> [path]` 会创建新的 IM 群聊会话。未写 path 时继承当前会话目录；未绑定时使用全局默认工作目录。名称或路径包含空格时，用英文引号包起来：

```text
/new "前端 调试" "~/work/my project"
```

`/clear [name] [path]` 在当前聊天里创建一个新对话并绑定过去，适合“同一个聊天继续做新任务”。如果当前任务仍在运行，或者 tmux TUI 追加输入还没有结束，CodeLark 会先要求确认是否终止旧对话。

`/t unbind` 是 detach 当前聊天，而不是删除会话。detach 后直接发普通文本会进入新的临时 BridgeSession；想接回旧会话时，发送 `/t` 找到它再 `/t <序号>`。

## 切换 agent 和 provider

切换 agent：

```text
/runtime codex
/runtime claude
/runtime kimi
```

切换 provider：

```text
/provider
/p tmux
/p pty
/p sdk
```

Codex 支持 `sdk`、`pty`、`tmux`。Claude Code 支持 `tmux`、`pty`、`sdk`，默认是 `tmux`。Kimi Code 当前只支持 `tmux`，发送普通文本后 CodeLark 会自动补一次 `Ctrl-S` steer。显式发送 `/p tmux` 会重建当前 runtime 的同名 provider-owned tmux；Kimi 会恢复已有 Kimi session id，并在 TUI ready 后更新绑定。`/provider` 不带参数时会显示当前 runtime 的 provider 和可选值。

`/current` 卡片顶部有“通用配置、Codex、Claude Code、Kimi Code”四个分栏：

- 通用配置严格按“对话名称、工作目录、tmux 输出行数”显示；切到该分栏不会改变当前 agent。
- Codex、Claude Code、Kimi Code 分栏只显示各自的 model、provider、mode、reasoning 等配置，不重复显示通用字段。选择另一个 runtime 分栏会沿用既有行为，切换当前 agent 并刷新卡片。
- 输入框留空或下拉选择“跟随上层配置”时，只删除当前分栏对应的 session-level 覆盖，立即恢复 home/local/channel 等上层配置的当前有效值；保存一个分栏不会串写其他分栏。

运行中不能随意切换 runtime/provider。遇到拒绝提示时，先等当前任务结束，或发送 `/stop` 停止当前任务，再切换。

## tmux 状态下输入和 pane 查看

选择 tmux provider：

```text
/p tmux
```

之后普通文本会先进入同一个 BridgeSession 的 provider-owned tmux TUI。CodeLark 会等待 TUI ready；如果启动时出现 Codex update、trust、goal 或 permission 选择，会把选择卡片发到 IM，用户选择完成后再把原始输入转发进去。

查看当前 tmux pane：

```text
/tmux-screen
/tmux-screen 120
/tmux-screen 120 5s
/tmux-screen stop
```

`/tmux-screen` 只查看当前绑定的 tmux session，不会自动恢复缺失的 provider session，也不会等待正在排队的普通对话。带 `5s` 会启动定时刷新，最低 3 秒；`stop` 停止当前聊天的刷新。

手动输入 tmux：

```text
/tmux pwd
/tmux pwd<Enter>
/tmux-key <C-c>
```

`/tmux ...` 会把普通文本写入当前绑定的 tmux session，并固定补一个 Enter；如果输入已经显式以 `<Enter>` 结尾则不重复补。这个行为不提供配置开关。`/tmux-key ...` 用来发送控制键。发送后会自动截屏返回。

tmux 绑定和默认值：

| 命令 | 说明 |
| --- | --- |
| `/tmux-status` | 查看当前 tmux 绑定、展示行数和输入设置。 |
| `/tmux-switch` | 列出本机 tmux sessions。 |
| `/tmux-attach <session>` | 把当前 BridgeSession 绑定到已有 tmux session。 |
| `/tmux-new [session]` | 新建并绑定 tmux session；已存在则直接绑定。 |
| `/tmux-set lines <1-500>` | 设置 `/tmux` 和 `/tmux-screen` 默认展示行数。 |
| `/tmux-set echo on/off` | 设置 `/tmux ...` 回复中是否回显本次输入。 |

`/tmux-set` 写的是当前 BridgeSession 的 session-level 配置。想修改全局默认展示行数，用 `/set tmuxCaptureLines <1-500>`。

## 配置层级：home level 和 chat level

CodeLark 的配置分两类理解最清楚：

| 层级 | 写入位置 | 典型入口 | 生效范围 |
| --- | --- | --- | --- |
| home level | `~/.codelark/config.toml` | `/set`、Web 工作台配置页 | 全局默认值和通道默认值。新会话会继承这些默认值。 |
| chat/session level | `~/.codelark/config/sessions/<session-id>.toml` | `/runtime`、`/provider`、`/model`、`/cd`、`/tmux-set`、`/current` 卡片 | 当前聊天绑定的 BridgeSession。只影响这条会话。 |

`/set` 打开的是 home level TOML 配置卡片，顶部下拉可切换：

- 通用配置：默认 agent、默认工作目录、tmux 默认展示行数、tmux 输入回显。
- Codex：默认模型、YOLO 模式、provider、skip git repo check、sandbox、network、reasoning。
- Claude：默认模型、YOLO 模式、provider、Claude executable、reasoning、空闲超时。
- Kimi：默认模型、provider。
- Bridge：UI 访问和流式状态提示。
- 通道配置（feishu-default）：历史消息数量、流式反馈、Markdown 反馈、群聊是否需要 @bot 等。

也可以直接写单项：

```text
/set runtime codex
/set runtime kimi
/set defaultWorkspaceRoot ~/work
/set defaultProvider tmux
/set claudeProvider tmux
/set tmuxCaptureLines 80
```

当前聊天的 runtime/provider/model/cwd 优先使用 session-level 覆盖。也就是说，`/set defaultProvider tmux` 会影响以后新建或没有覆盖的会话；已经在当前聊天里执行过 `/provider sdk` 的会话，会继续使用自己的 session-level provider，直到再次发送 `/provider ...` 或在 `/current` 卡片里保存新值。

`/current` 只呈现允许写入 session 的配置：通用分栏严格包含对话名称、当前工作目录、tmux 展示行数；三个 runtime 分栏分别包含各自的模型、provider、权限等会话级覆盖。默认工作目录、UI 访问、通道设置等只能写入 home 或其他上层作用域，不会伪装成会话配置；当前工作目录继续使用通用分栏里的“工作目录”或 `/cd` 修改。

## 什么时候看哪张卡片

| 目标 | 入口 |
| --- | --- |
| 看 bridge、通道和当前绑定 | `/status` |
| 找本地 Codex/Claude/Kimi 会话并 attach | `/t` |
| 改当前会话名、cwd、runtime 配置 | `/current` |
| 改全局默认值和通道默认值 | `/set` |
| 看 tmux provider 的当前屏幕 | `/tmux-screen` |
| 看 pty provider 的当前屏幕 | `/pty-screen` |
| 查看最近模型消息历史 | `/his` |

排障时先发 `/current` 确认当前聊天绑到了哪条 BridgeSession，再发 `/provider` 和 `/tmux-status` 确认 runtime/provider 与 tmux 绑定是否符合预期。
