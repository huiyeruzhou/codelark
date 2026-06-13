# 会话、Provider 与配置工作流

这页从日常使用角度串起 IM 会话、agent/provider、tmux pane 查看和配置层级。完整命令索引见 [命令体系](../product/commands.md)，provider 设计说明见 [运行时与提供方](../product/runtime-providers.md)。

## 核心概念

CodeLark 的 IM 对话由三层组成：

| 层级 | 含义 | 常用入口 |
| --- | --- | --- |
| Chat | 飞书私聊、群聊、话题或云文档评论入口。它只记录“这个聊天当前接到哪个 BridgeSession”。 | `/t`、`/t 1`、`/t unbind` |
| BridgeSession | CodeLark 管理的一条工作会话，保存工作目录、当前 runtime、provider、模型和底层 thread 身份。 | `/new`、`/clear`、`/current` |
| Runtime thread | Codex thread 或 Claude Code session，是底层 agent 自己的会话身份。 | `/t` 接管、`/his` 查看历史 |

`/runtime` 选择当前会话使用 Codex 还是 Claude Code。`/provider` 选择当前 runtime 的驱动方式，例如 SDK、pty 或 tmux。切换 runtime 不会清空另一个 runtime 已记住的 provider；同一个聊天可以记住 Codex 和 Claude 各自的 BridgeSession，来回切换时会尽量回到之前那条会话。

## 推荐日常流程

新聊天里可以按这个顺序开始：

```text
/status
/t
/t 1
/current
```

`/status` 看 bridge 和通道状态。`/t` 打开本地会话表；选择一条会话后发送 `/t 1` 或点击卡片中的选择项接管。`/current` 查看当前会话卡片，并在同一张卡片里改会话名、工作目录和当前 runtime 的配置。

如果要从空白会话开始：

```text
/new my-task ~/work/project
```

如果当前聊天已经在一个长对话里，但你想在同一个聊天上下文切到新对话：

```text
/clear my-next-task ~/work/project
```

`/clear` 不会删除旧对话；之后仍可用 `/t` 找回并 attach。

## 会话列表和下拉选框

`/t` 默认显示当前 runtime 最近 20 条本地会话，并发送一张表格卡片：

- 会话下拉：选择表格中的某条本地会话，效果等同 `/t <序号>`。
- 数量下拉：切换显示 20、50 或 100 条，也可发送 `/t n 50`、`/t n 100`。
- runtime 下拉：切换列表查看 Codex 或 Claude Code 会话，也可发送 `/t codex n 100` 或 `/t claude n 100`。

表格首列会标出当前聊天正在绑定的会话，以及其他聊天已经绑定的会话。接管其他聊天绑定的会话时，如果目标还在运行会被拒绝；如果目标空闲，CodeLark 会先发确认卡片，确认后解绑原聊天并把会话 attach 到当前聊天。

常用 session 管理命令：

| 操作 | 命令 | 说明 |
| --- | --- | --- |
| attach 本地会话 | `/t 1` | 按当前 `/t` 表中的序号接管会话。 |
| attach 指定会话 | `/t <thread_id>` 或 `/t <bridge_id>` | 也可用名称匹配，冲突时先回到 `/t` 用序号。 |
| detach 当前聊天 | `/t unbind` | 当前聊天脱离原会话，并立即绑定到新的临时 BridgeSession；原会话保留，可再次 `/t` 接回。 |
| 临时会话 | `/t 0` | 切到隐藏的临时 BridgeSession。 |
| 重置临时会话 | `/t 0 reset` | 丢弃当前临时上下文并生成新的临时 BridgeSession。 |
| 归档当前本地会话 | `/t archive` | 归档当前绑定的本地 Codex/Claude 会话，并解除相关绑定。 |
| 归档指定会话 | `/t archive 1` | 按当前 runtime 的 `/t` 表序号归档。 |
| 重命名当前线程 | `/t rename <名称>` | 群聊通道会同步修改群名，并自动带 bot 前缀。 |

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
```

切换 provider：

```text
/provider
/p tmux
/p pty
/p sdk
```

Codex 支持 `sdk`、`pty`、`tmux`。Claude Code 支持 `tmux`、`pty`、`sdk`，默认是 `tmux`。`/provider` 不带参数时会显示当前 runtime 的 provider 和可选值。

`/current` 卡片顶部有 runtime 下拉，可以直接在 Codex 和 Claude Code 之间切换并刷新卡片。卡片表单保存时只更新当前显示 runtime 的配置项；例如切到 Claude Code 后保存，不会修改 Codex 的 sandbox 或 network 设置。

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

`/tmux ...` 会把普通文本写入当前绑定的 tmux session，并按当前会话设置决定是否自动补 Enter。`/tmux-key ...` 用来发送控制键。发送后会自动截屏返回。

tmux 绑定和默认值：

| 命令 | 说明 |
| --- | --- |
| `/tmux-status` | 查看当前 tmux 绑定、展示行数和输入设置。 |
| `/tmux-switch` | 列出本机 tmux sessions。 |
| `/tmux-attach <session>` | 把当前 BridgeSession 绑定到已有 tmux session。 |
| `/tmux-new [session]` | 新建并绑定 tmux session；已存在则直接绑定。 |
| `/tmux-set lines <1-500>` | 设置 `/tmux` 和 `/tmux-screen` 默认展示行数。 |
| `/tmux-set enter on/off` | 设置 `/tmux ...` 是否自动补 Enter。 |
| `/tmux-set echo on/off` | 设置 `/tmux ...` 回复中是否回显本次输入。 |

`/tmux-set` 写的是当前 BridgeSession 的 session-level 配置。想修改全局默认展示行数，用 `/set tmuxCaptureLines <1-500>`。

## 配置层级：home level 和 chat level

CodeLark 的配置分两类理解最清楚：

| 层级 | 写入位置 | 典型入口 | 生效范围 |
| --- | --- | --- | --- |
| home level | `~/.codelark/config.toml` | `/set`、Web 工作台配置页 | 全局默认值和通道默认值。新会话会继承这些默认值。 |
| chat/session level | `~/.codelark/config/sessions/<session-id>.toml` | `/runtime`、`/provider`、`/model`、`/cd`、`/tmux-set`、`/current` 卡片 | 当前聊天绑定的 BridgeSession。只影响这条会话。 |

`/set` 打开的是 home level TOML 配置卡片，顶部下拉可切换：

- 通用配置：默认 agent、默认工作目录、tmux 默认展示行数、tmux 自动回车、tmux 输入回显。
- Codex：默认模型、YOLO 模式、provider、skip git repo check、sandbox、network、reasoning。
- Claude：默认模型、YOLO 模式、provider、Claude executable、reasoning、空闲超时。
- Bridge：UI 访问和流式状态提示。
- 通道配置（feishu-default）：历史消息数量、流式反馈、Markdown 反馈、群聊是否需要 @bot 等。

也可以直接写单项：

```text
/set runtime codex
/set defaultWorkspaceRoot ~/work
/set defaultProvider tmux
/set claudeProvider tmux
/set tmuxCaptureLines 80
```

当前聊天的 runtime/provider/model/cwd 优先使用 session-level 覆盖。也就是说，`/set defaultProvider tmux` 会影响以后新建或没有覆盖的会话；已经在当前聊天里执行过 `/provider sdk` 的会话，会继续使用自己的 session-level provider，直到再次发送 `/provider ...` 或在 `/current` 卡片里保存新值。

## 什么时候看哪张卡片

| 目标 | 入口 |
| --- | --- |
| 看 bridge、通道和当前绑定 | `/status` |
| 找本地 Codex/Claude 会话并 attach | `/t` |
| 改当前会话名、cwd、runtime 配置 | `/current` |
| 改全局默认值和通道默认值 | `/set` |
| 看 tmux provider 的当前屏幕 | `/tmux-screen` |
| 看 pty provider 的当前屏幕 | `/pty-screen` |
| 查看最近模型消息历史 | `/his` |

排障时先发 `/current` 确认当前聊天绑到了哪条 BridgeSession，再发 `/provider` 和 `/tmux-status` 确认 runtime/provider 与 tmux 绑定是否符合预期。
