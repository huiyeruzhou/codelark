# 会话与配置工作流

这页深入解释 IM 会话、agent 切换、tmux 屏幕和配置层级。第一次使用请先看 [5 分钟上手：日常工作流](daily-workflow.md)；完整命令索引见 [命令体系](../product/commands.md)。

## 核心概念

CodeLark 的 IM 对话由三层组成：

| 层级 | 含义 | 常用入口 |
| --- | --- | --- |
| Chat | 飞书私聊、群聊、话题或云文档评论入口。它只记录“这个聊天当前接到哪个 BridgeSession”。 | `/t`、`/t 1`、`/t unbind` |
| BridgeSession | CodeLark 管理的一条工作会话，保存工作目录、当前 agent、模型和底层会话身份。 | `/new`、`/clear`、`/` |
| Runtime session | Codex thread、Claude Code/Kimi Code/ZCode session 或 Cursor chat，是底层 agent 自己的会话身份。 | `/t` 接管、`/his` 查看历史 |

`/runtime` 选择当前会话使用 Codex、Claude Code、Kimi Code、Cursor Agent 还是 ZCode。新 Codex 会话优先使用 app-server，tmux 是可选的终端入口；其他 runtime 沿用各自的运行方式。同一个聊天可以记住各 agent 的 BridgeSession，来回切换时会回到之前那条会话。

## 推荐日常流程

大多数任务只需要下面这条主线：

```text
/new "任务名" "~/work/project"
直接发送任务
/tmux-screen
```

之后直接发送普通消息继续追问。需要在同一个群切到新对话时使用 `/clear`；需要接回本地旧会话时使用 `/t`：

```text
/clear "下一阶段" "~/work/project"
/t
/t 1
```

`/clear` 遇到未结束或状态不明的任务时，会显示“终止并新建”。点击一次就会请求结束旧任务并新建对话，无需等状态变成空闲或重复发送命令；取消则保留原对话。

`/clear` 不会删除旧对话。`/clear` 和 `/new` 都继承当前会话实际生效的配置，包括 agent、各 runtime 的 model/provider、权限模式、推理强度、网络设置、会话交互设置及系统提示。继承值写入新会话配置，重启后仍然保留；命令显式指定的目录优先，没有当前会话时才使用默认配置。

使用共享 Codex app-server 时，新会话沿用同一个后端，但建立新的 thread；旧 thread、运行任务和 tmux 句柄不会复制。`/clear` 保留当前聊天里其他 runtime 的已有映射，`/new` 只为新群创建新的 runtime 映射。

## 在 Codex Desktop 继续同一会话

新建 Codex 会话默认使用 app-server。普通消息、停止和运行状态由协议处理，tmux 是可选的查看入口。

macOS 已安装官方 Codex Desktop、且 Codex CLI 支持远程连接时，自动复用或准备由 macOS 独立管理的共享服务。新的 tmux 查看窗口建立后，聊天中会提示已检测到 Desktop，并使用了 `--remote`。在 Desktop 打开同一条会话即可继续；关闭查看窗口或重启 CodeLark 不会停止这个独立服务。

其他情况下，CodeLark 按需启动本实例的私有后端，多个聊天共用。私有后端随创建它的 Bridge 正常关闭；后续启动会在同一地址恢复已持久保存的线程，正在执行的任务不会自动重发。私有地址不会自动写入 Desktop 环境。如果要让 Desktop 在 Bridge 退出后继续执行，请使用独立共享服务。

独立共享服务使用自己的 Codex 登录状态；仅设置 `CODEX_API_KEY` 不能替代这个登录。私有后端支持把显式 API key 注入当前后端的内存认证，既不覆盖已有 `auth.json`，也不替 Desktop 登录。

第一次配置时，如果 Desktop 已经打开，按提示退出后重新打开一次，让它取得共享连接地址。服务在 Desktop 之后才启动时，也可能需要重开 Desktop。正在运行的 stdio Desktop 无法原地转移 writer lock；CodeLark 不会擅自终止应用，也不会把该条输入改投 tmux，而是在冲突卡片中提供“重启并重试”按钮。用户点击后，`scripts/restart-codex-desktop.sh` 先确认共享 endpoint 已就绪，再正常退出并重开 Desktop；退出失败时不会强制杀进程。纯文本输入会在重启成功后自动重试，含附件的输入需要重新发送。CodeLark 自动保存连接配置，无需每次手动设置环境变量。实际注销再登录、两个登录项同时启动的顺序仍待专用 Mac 验证；当前验收范围见 [Desktop GUI 验收](../testing/codex-desktop.md)。

已有旧会话会在下一条输入前自动迁移：先确认 app-server 可连接，再精确结束 CodeLark 为该 thread 创建的旧 tmux writer，最后由协议恢复同一 thread；迁移失败会在发送输入前明确报错，不会偷偷回退或重复提交。普通 tmux 会话和 `-view` 查看窗口不会被迁移逻辑结束。CLI 明确不支持 app-server 监听时才保留旧适配器。`CODELARK_CODEX_APP_SERVER=0` 关闭自动选择，但已绑定的协议线程仍使用原后端；连接或认证失败不会偷偷切换执行进程。由其他独立 Codex 进程占用的会话不会被强行终止，需要先正常结束那个进程才能交给共享服务，不能通过删除锁文件解决。

`/clear`、`/new` 只继承后端选择，第一条真实输入才创建原生线程；后台订阅不会提前创建空线程。显式 `/p tmux` 会预热线程；若尚未发送过输入，Codex 可能还未保存其历史，后端退出后需要 `/clear` 新建。

需要恢复 Desktop 默认运行方式时，在本机终端执行：

```bash
codelark codex-desktop disable
```

这会停止 CodeLark 管理的共享服务及其中正在执行的任务，移除自动启动配置；随后重开 Desktop。卸载 CodeLark 前也应先执行此命令。重新启用时，移除 `~/.codelark/codex-desktop/disabled`，再创建新的 Codex 会话；原来的服务环境快照会继续复用。`CODELARK_CODEX_DESKTOP_REMOTE=0` 只关闭当前 Bridge 的自动选择，不会停止已经运行的共享服务。

## 查看 app-server 启动情况

在 Web 工作台侧栏打开 **app-server**。这个页面显示当前 CodeLark 实例使用的服务，包括启动情况、托管方、地址、可确认的 PID、时间、最近错误和关联会话数；即使启动失败时还没有创建 Codex thread，也会显示这次准备结果。页面每 5 秒更新，打开或刷新页面不会启动后端或恢复会话。

启动情况、连接状态和对话活动分别展示。CodeLark 自己创建的进程可以确认启动和退出；外部服务或 macOS launchd 管理的进程如果没有进程证据，会显示启动状态未确认，并单独显示协议是否已连接。连接已断开不等于进程已退出，Bridge 已连接也不代表 Desktop 已连接。

概览、会话列表和会话配置同时显示当前会话实际使用的后端以及终端用途。app-server 与 tmux 可以同时存在：前者负责执行和协议事件，后者是查看或人工操作入口。“默认优先 app-server”只表示选择策略，不能说明已有旧会话已经迁移；实际后端在准备成功后更新。

旧版 Bridge 没有提供状态接口，或当前 Bridge 不可用时，页面显示状态不可用；不会沿用上一次的“已连接”或“空闲”。启动记录来自当前 Bridge 已观察到的操作，历史失败仍可通过日志排查。

## 会话列表和下拉选框

`/t` 默认显示当前 runtime 最近 20 条本地会话，并发送一张表格卡片：

- 会话下拉：选择表格中的某条本地会话，效果等同 `/t <序号>`。
- 数量下拉：切换显示 20、50 或 100 条，也可发送 `/t n 50`、`/t n 100`。
- runtime 下拉：切换列表查看 Codex、Claude Code、Kimi Code、Cursor Agent 或 ZCode 会话，也可发送 `/t zcode n 100`。

表格首列会标出当前聊天正在绑定的会话，以及其他聊天已经绑定的会话。接管其他聊天绑定的会话时，如果目标还在运行会被拒绝；如果目标空闲，CodeLark 会先发确认卡片，确认后解绑原聊天并把会话 attach 到当前聊天。

“用户输入轮数”来自后台增量缓存。bridge 首次看到大型历史文件时，该列可能暂时显示 `-`，但 `/t` 和接管不会等待整份 JSONL；后台统计完成后刷新 `/t` 即显示精确轮数，后续只统计新增后缀。

runtime 和数量下拉只切换卡片里的候选列表，不会改变当前会话。选择具体目标并点击“接管”后才会修改 binding。如果当前会话仍在运行，CodeLark 会先询问是否停止；取消时旧任务和 binding 都不变，确认后会先停止旧任务，再把后续消息切到所选 runtime。

停止 Kimi Code 时，CodeLark 会按 Kimi TUI 约定连续发送两次 `Ctrl-C`；这会取消当前 turn 并保留可复用的 tmux 会话。旧 Codex TUI 和 Claude Code 只发送一次。共享 Codex 会话通过协议中断当前任务，并等待后端确认结束。

常用 session 管理命令：

| 操作 | 命令 | 说明 |
| --- | --- | --- |
| attach 本地会话 | `/t 1` | 按当前 `/t` 表中的序号接管会话。 |
| attach 指定会话 | `/t <thread_id|session_id>` 或 `/t <bridge_id>` | Codex 使用 thread_id；Claude/Kimi/Cursor/ZCode 使用各自稳定 session/chat id；也可用名称匹配，冲突时先回到 `/t` 用序号。 |
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

## 切换 agent

切换 agent：

```text
/runtime codex
/runtime claude
/runtime kimi
/runtime cursor
```

传统终端会话执行 `/p tmux` 时，如仍有任务或残留运行状态，会显示“结束并重启”。点击后恢复原对话上下文，无需先 `/stop`；取消不影响当前任务。共享 Codex 会话只打开查看窗口，不会中断正在运行的任务。

CodeLark 默认通过 tmux 运行本地 agent。只有当前 TUI 已退出或确实需要重启时，才发送 `/p tmux`；不需要在每次任务前设置。SDK、pty 等实现差异属于设计层内容，见 [运行时与提供方](../product/runtime-providers.md)。

思考配置按 runtime 的真实能力提供：

| Runtime | 当前会话命令 | 可选值 |
| --- | --- | --- |
| Codex | `/reasoning <值>` | `minimal`、`low`、`medium`、`high`、`xhigh`、`max`、`ultra` |
| Claude Code | `/reasoning <值>` | `low`、`medium`、`high`、`xhigh`、`max` |
| Kimi Code | `/reasoning <值>` | `on`、`off`、`default`；Kimi 没有多档 effort |
| Cursor Agent | `/reasoning <值>` | `low`、`medium`、`high`、`xhigh`、`max`；具体可用值取决于所选模型和账号 |
| ZCode | `//<原生命令>` | CodeLark 不映射思考级别；例如 `//goal` 原样进入 ZCode TUI |

`/reasoning default` 清除当前会话覆盖。全局默认可在 `/set` 对应 runtime 分栏修改；Cursor 会把 effort 合并进参数化模型，例如 `gpt-5.3-codex[effort=high]`，`force` 仍只表示跳过审批，不是思考级别。

`/` 卡片顶部有“通用配置、Codex、Claude Code、Kimi Code、Cursor Agent、ZCode”分栏：

- 通用配置严格按“对话名称、工作目录、tmux 输出行数”显示；切到该分栏不会改变当前 agent。
- 各 agent 分栏只显示自己的模型、权限和思考设置，不重复显示通用字段。选择分栏只查看和编辑当前会话配置，不切换 agent；实际切换使用 `/runtime`。保存先验证整份表单，验证失败不写入任何配置字段。
- 输入框留空或下拉选择“跟随上层配置”时，只删除当前分栏对应的 session-level 覆盖，立即恢复 home/local/channel 等上层配置的当前有效值；保存一个分栏不会串写其他分栏。飞书里继承状态会明确选中“跟随上层配置”，不会显示为空；CardKit 内部使用独立的 inherit value，后端只把该机器值解释为 unset，不能把中文文案交给 sandbox/provider 等枚举写校验。

运行中不能随意切换 agent。遇到拒绝提示时，先等当前任务结束，或发送 `/stop` 停止当前任务，再切换。

如果 Codex 恢复旧 session 时发现记录模型与当前模型不同，CodeLark 会显示“Codex 恢复模型不一致”提醒，列出两个模型并建议发送 `/clear` 新建 session。该提醒不会自动清空或切换当前 session；同一组模型只提示一次。

## tmux 输入和屏幕查看

共享 Codex 会话的普通文本通过 app-server 提交，运行状态和完成结果也来自后端。tmux 用于查看和人工操作；终端里出现菜单不会阻挡飞书提交，查看屏幕也不是恢复任务的必要步骤。

其他终端适配器的普通文本会进入当前 BridgeSession 的 tmux TUI。CodeLark 会等待 TUI ready；如果启动时出现 update、trust、goal 或 permission 选择，会把选择卡片发到 IM，用户选择完成后再把原始输入转发进去。

查看当前 tmux pane：

```text
/tmux-screen
/tmux-screen 120
/tmux-screen 120 5s
/tmux-screen stop
```

`/tmux-screen` 只查看当前绑定的 tmux session，不会自动恢复已退出的 TUI，也不会等待正在排队的普通对话。带 `5s` 会启动定时刷新，最低 3 秒；`stop` 停止当前聊天的刷新。

手动输入 tmux：

```text
/tmux pwd
/tmux pwd<Enter>
/tmux-key <C-c>
```

终端适配器的 `/tmux ...` 会把普通文本写入当前绑定的 tmux session，并固定补一个 Enter；如果输入已经显式以 `<Enter>` 结尾则不重复补。这个行为不提供配置开关。共享 Codex 会话的 `/tmux ...` 通过协议提交任务，不依赖终端按键。`/tmux-key ...` 用来操作实际终端；停止共享任务请用 `/stop`。

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

## `/` 与 `/set`：当前群和全局默认

每个 `/new` 创建的群都会收到初始化说明和“当前会话”卡片，因此不需要记入口：

- `/`（等同 `/current`）打开当前群的会话卡片。
- `/set` 打开全局默认配置卡片。

两者的对应关系如下：

| 层级 | 写入位置 | 典型入口 | 生效范围 |
| --- | --- | --- | --- |
| 全局默认 | `~/.codelark/config.toml` | `/set`、Web 工作台配置页 | 没有来源会话的新群采用；也影响没有单独覆盖该字段的已有群。 |
| 当前群 | `~/.codelark/config/sessions/<session-id>.toml` | `/`、`/runtime`、`/model`、`/cd`、`/tmux-set` | 只影响当前群绑定的会话，并优先于全局默认。 |

`/set` 卡片顶部可以切换：

- 通用配置：默认 agent、默认工作目录、tmux 默认展示行数、tmux 输入回显。
- Codex：默认模型、YOLO 模式、skip git repo check、sandbox、network、reasoning。
- Claude：默认模型、YOLO 模式、Claude executable、reasoning、空闲超时。
- Kimi：默认模型、Thinking 开关。
- Cursor：默认模型、模型 effort 和 force 模式。
- ZCode：默认模型、启动 mode 和固定 tmux provider。
- Bridge：UI 访问和流式状态提示。
- 通道配置（feishu-default）：历史消息数量、流式反馈、Markdown 反馈等。

也可以直接写单项：

```text
/set runtime codex
/set runtime kimi
/set defaultWorkspaceRoot ~/work
/set tmuxCaptureLines 80
```

`/` 卡片只显示可以由当前群覆盖的字段：通用分栏包含对话名称、当前工作目录、tmux 展示行数和本会话是否需要 @bot；agent 分栏包含模型和权限等会话设置。选择“跟随上层配置”会删除当前群的覆盖值，重新跟随 `/set`。

只改当前群，用 `/`；修改全局默认，用 `/set`。从已有群执行 `/new` 或 `/clear` 时，仍以该群当前实际生效的配置为准，不会丢弃它的设置而回退到全局默认。

## 运行中修改配置

`/model`、`/cd`、`/reasoning`、`/sandbox`、`/network` 和会话配置卡都可以在任务运行时保存。当前任务使用原配置，后续新请求读取更新值；旧 tmux 终端需要发送 `/p tmux` 并确认“结束并重启”，才会采用新的启动参数。卡片切换 agent 分栏只选择编辑哪些设置；实际切换 agent 使用 `/runtime`。

| 命令 | 行为 |
| --- | --- |
| `/yolo` 或 `/yolo on` | 开启当前会话、当前 agent 的 YOLO 模式。重复发送仍保持开启。 |
| `/yolo off` | 恢复普通审批模式。 |
| `/yolo status` | 查询设置，不修改。 |
| `/require_at on` | 当前会话的群消息必须 @bot 才处理。 |
| `/require_at off` | 当前会话恢复处理未 @bot 的群消息。开启后需 @bot 发送此命令。 |

Codex 的 YOLO 对应免审批和完整访问权限；关闭后恢复该会话配置的 sandbox。Kimi 当前固定通过 `kimi -y` 运行，会明确提示无法用 `/yolo off` 关闭。`/require_at` 与 `/require-at` 等价，仅影响当前 session，不影响同一机器人所在的其他群；私聊不受影响。`/clear` 和 `/new` 继承这两个设置。升级时，已有会话继承原先通道的 @bot 要求，以后各会话独立保存。

## 什么时候看哪张卡片

| 目标 | 入口 |
| --- | --- |
| 看 bridge、通道和当前绑定 | `/status` |
| 找本地 Codex/Claude/Kimi/Cursor/ZCode 会话并 attach | `/t` |
| 改当前会话名、工作目录和 agent 设置 | `/` |
| 改全局默认值和通道默认值 | `/set` |
| 看本地 tmux TUI 的当前屏幕 | `/tmux-screen` |
| 查看最近模型消息历史 | `/his` |

排障时先发 `/` 确认当前群的 agent 和工作目录，再发 `/tmux-status` 确认 tmux 绑定是否符合预期。
