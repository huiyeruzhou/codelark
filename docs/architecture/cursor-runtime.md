# Cursor runtime

## 目标

Cursor Agent CLI 会话由 CodeLark 在 provider-owned tmux session 中运行官方 `agent` TUI。tmux 负责进程生命周期和输入；Cursor 自己在后台写入 chat metadata 与 transcript JSONL，CodeLark 从 transcript 读取结构化输出，不解析终端屏幕的 ANSI/局部重绘。

Cursor Desktop 已有对话同样使用 `cursor:tmux`，内部传输方式为 `desktop`：CodeLark 只通过 Cursor 自带 Desktop Bridge 向同一条可见对话提交输入，从同一对话的原生 SQLite bubbles 读取输出，并通过 Desktop Bridge 实时状态确认终态；旧版本原生库不可读时才使用 transcript。一个 Bridge session 固定绑定一个 Cursor chat UUID、cwd 和来源 transport；不处理 TUI 内 `/new`、`/fork`、`/resume` 导致的 chat ID 变化。

## 官方证据

调查使用 [Cursor 官方安装脚本](https://cursor.com/install) 安装的 `2026.07.23-e383d2b`，并在 `2026.10.01-e373342` 复核。安装产物在 `~/.local/bin` 提供 `agent` 与 `cursor-agent` 两个软链，二者指向同一版本目录中的 `cursor-agent` 启动脚本；CodeLark 优先使用 `~/.local/bin/agent`，因此不要求 Bridge 的 PATH 包含 `~/.local/bin`。

官方 CLI 支持：

- `agent`：启动交互式 TUI；
- `agent --resume <chatId>`：恢复指定会话；
- `--model`、`--force`、`--trust`：模型、执行模式和工作区信任控制；
- `-p --output-format stream-json`：headless 结构化输出，可用于协议取证，但不是本 provider 的执行路径。

官方包 `@cursor/sdk@1.0.24` 也提供 `Agent.create`、`Agent.resume` 和 `run.stream()`，但 SDK 的公开 API 不包含 CLI slash-command 控制面。当前需求需要直接运行官方 TUI 并保留其命令行为，因此首版不引入 SDK 生产依赖。

## 后台会话文件

交互式 TUI 与 headless CLI 共用 chat persistence。主状态位于：

```text
<CURSOR_CONFIG_DIR 或 ~/.cursor>/chats/<md5(realpath(cwd))>/<chatId>/
├── store.db
└── meta.json
```

`store.db` 使用 WAL，表只有：

```sql
CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
```

消息主体是 Cursor 私有序列化 blob，CodeLark 不解析。`meta.json` schema v1 提供 `title`、`createdAtMs`、`updatedAtMs`、`hasConversation`、`isSubagent` 与 `cwd`，用于会话发现和列表。

Cursor Desktop 的会话目录与 Cursor Agent CLI 并不完全重合。Desktop 的可见会话索引位于用户数据目录：macOS 默认为 `~/Library/Application Support/Cursor/User`，Linux 默认为 `${XDG_CONFIG_HOME:-~/.config}/Cursor/User`，Windows 默认为 `%APPDATA%/Cursor/User`。CodeLark 的 `/t cursor` 会额外读取：

- `globalStorage/conversation-search.db`：Desktop 可见、未归档的 conversation id、标题和活动时间；
- `globalStorage/state.vscdb` 的 `composerHeaders`：新版 Desktop 会话的 workspace；
- `workspaceStorage/*/state.vscdb` 中的 `composer.composerData` 和同目录 `workspace.json`：旧版 composer 会话与 workspace 的映射。

列表把 Desktop 与 `~/.cursor/chats` 的 CLI 会话按 conversation id 合并；同一 id 同时存在时以 Desktop index 的 title/cwd/transport 身份为准，同时保留 CLI `store.db` 供结构化记录核验。无法可靠恢复 cwd，或原 workspace 已不存在的残留索引不会展示。Desktop 会话不会再通过 `agent --resume <chatId>` 恢复；这会建立第二个 writer。若此前没有 transcript，CodeLark 会在 Desktop Bridge 提交首条新输入后等待同一 chat id 的 transcript 出现，再开始读取输出。

可读 transcript 位于：

```text
<CURSOR_DATA_DIR 或 ~/.cursor>/projects/<workspace-slug>/
└── agent-transcripts/<encoded-chatId>/<encoded-chatId>.jsonl
```

同时兼容旧的 `agent-transcripts/<encoded-chatId>.jsonl`。官方 transcript writer 会在执行中 append 或重写 snapshot；真实工具/子 Agent 故事中也可能直到本轮接近结束才把可读 JSONL flush 到磁盘。可见记录包括：

- `{role:"user|assistant|tool", message:{content:[...]}}`；
- `text` 与 `tool_use` content block；
- `{type:"turn_ended", status:"success|error|aborted"}` 终态。

CodeLark 把这些行归一化为公共 message/tool/task mirror record 和 SSE 事件。Cursor 会用原子替换重写 transcript snapshot，因此 mirror watch transcript 所在目录而不是文件 inode；否则第一次 replace 后 watcher 可能失效，只能等 hot 2.5 秒或 cold 60 秒轮询兜底。官方 writer 还会在 assistant 回答后写入仅包含 `<|eos|>` 的内部边界块，并可能在同一 turn 先写一份 assistant state、稍后再写内容不同的最终 revision；后一个 revision 不是新的回答。对 `2026.07.23-e383d2b` 真实样本的 `store.db` 取证表明，同一 assistant message 具有 `reasoning` 与 `text` 两个 block：前者的签名载荷明确是 OpenAI `summary_text`，后者标记为 `openaiPhase=final_answer`。transcript writer 会丢失 block 类型，把正文放在前面、加粗的 thinking summary 放在后面并用空行连接；正文与 summary 都可能在下一版 snapshot 中同时改写。parser 优先比较相邻 revision 的最后一个空行边界；如果只有一版带摘要，或下一版同时改写正文并移除摘要，则只在 `turn_ended` 前后用当前 chat 的 `store.db` 核验独立 text/reasoning blocks，并要求重新扁平化后与 transcript snapshot 精确相等。核验成功后恢复 `reasoningKind=summary`，同时给正文 revision 分配稳定 `replacementKey`；没有结构化证据时不把任意末尾粗体正文猜成摘要。direct provider 通过通用 `history_item` 交付 `thinking_summary`，mirror turn 使用同一中间语义；公共历史 renderer 把它作为弱化引用插在最终回答之前，不混入正文，也不占外层卡片标题。不能匹配 `Responding...` 等具体文案，也不能让 Feishu renderer 解析 Cursor 私有文本。真实 TUI 取样表明 Cursor 完成态不显示该 summary，等待期只显示淡化的 `Working`；CodeLark 保留摘要属于自身的可观察性设计，而不是复刻一个并不存在的 Cursor title。

Cursor 不调用名为 `completed` 的工具结束一轮。assistant message 后由客户端独立追加 `{"type":"turn_ended","status":"success"}`；失败或中断也由该 terminal record 的状态表达。CLI 与旧版 transcript 路径必须以 `turn_ended` 驱动终态，不能用工具名、正文停止增长或 TUI 光标位置猜测完成。同一读取批次只保留最新版正文，跨增量批次则把后续 revision 作为替换事件继续交付。多轮时 Cursor 还会重写整份 transcript、删除上一轮位于 EOF 的 `turn_ended`；旧 byte offset 可能因此落入新 user JSON 中部。增量 parser 跳过残行后若先看到完整 assistant row，必须以它建立隐式 turn 并恢复正文，不能只交付后面的成功终态。多轮后的最终 transcript snapshot 可能只保留文件末尾一个 `turn_ended`；测试应以 user/归一化后的可见 assistant record 确认轮次，以文件末尾终态确认整体完成，不能把物理 assistant/终态行数当成轮数。

Cursor 后台活动还可能连续写入只有 `<timestamp>…</timestamp>` 的 `user` 行。只有时间戳、空白或 `<|eos|>` 的纯文本行不代表新的用户输入，parser 在改动回合及 occurrence 状态之前忽略它们，避免空卡泛洪及打断当前工具/回答；同一规则用于完整 snapshot 和增量读取。含真实正文、`user_query`、图片或其他非文本 block 的 user 行仍建立新回合，相同的真实提问也仍保留各自的 occurrence。

### Desktop 原生输出与实时生命周期

Desktop direct 与 mirror 共用 `CursorDesktopSessionSource`：读取 `globalStorage/state.vscdb` 的 `cursorDiskKV`，以 user bubble 建立 turn，以 tool bubble ID 关联开始和真实结果。SQLite 主文件和 WAL 均参与变更检测；内存 revision ledger 将原地更新的迟到结果追加到上次读取位置之后，已初始化且签名仍可匹配时不再用消息发送时间水位过滤它。进程重启仍用持久化水位抑制历史重放。Read/Grep 已被 Cursor 清理的正文只说明“未保留完整原始输出”，不重读现在的文件伪造历史结果。

**持久化 `composer.status` 不能决定当前回合结束。** 2026-10-09 真实取证中，root 仍为旧 `aborted`、时间停在用户提交时，但工具持续新增，标准 v1 `listThreads` 返回 `running`。direct 与 mirror 在读取前刷新同一 thread 的实时状态，只有 `completed` / `error` 连续两次且该对话内容不变时才收尾；`running`、等待输入的 `idle`、`unknown` 或查询失败都保留当前回合。状态观察绑定查询前的对话内容，查询中新增用户/工具使旧终态失效；其他对话写同一库不会阻塞本线程收尾。mirror 即使文件字节未变化也检查实时状态。每个 turn 的终态签名固定，已确认关闭的历史修订不重开卡片。

同一 turn 反复创建消息与同一卡片整卡重绘是两个独立问题。Feishu history renderer 现在为工具详情提供稳定 element ID；工具完成只更新标题、边框和正文，新工具追加到已有组，局部请求不写 `expanded` 或替换已有 children。正常连续工具调用不再触发整卡更新；组件能力缺失、结构不兼容、失败或超预算仍沿用既有整卡恢复/continuation。

## 模型配置与实际生效边界

模型应用能力由当前会话的内部 transport 决定，不能仅凭 CodeLark 保存成功或卡片上的 `model:` 判断已经切换。

### 执行入口与能力契约

Cursor 对外只有一个 provider：`tmux`，identity 固定为 `cursor:tmux`。`CursorTmuxProvider` 内部区分 `desktop` / `cli` 两种 transport，分别使用 Desktop Bridge 和官方 TUI。`resolveCursorTransport` 根据已绑定会话的来源选择传输方式；provider 配置不能将 Desktop thread 改走 CLI。

`runtime/cursor/capabilities.ts` 定义当前集成的 `CursorCapabilities`；`resolveCursorCapabilities` 在解析会话 transport后返回该契约。`/model`、`/reasoning`、`/current` 表单和执行参数构造共享它，不再各自维护“Desktop 是否支持配置”的判断。

| 内部 transport（provider 均为 `tmux`） | `modelCatalog` | `modelConfiguration` |
| --- | --- | --- |
| `desktop` | `unavailable`：标准接口无目录；可选 v4 单独探测原生目录 | `external`：模型和 effort 由 Desktop 管理，CodeLark 不写假应用配置 |
| `cli` | `cli`：读取独立 CLI 模型目录 | `process-launch`：模型和 effort 在启动进程时传入，复用 TUI 不会重新应用 |

契约表达的是 **CodeLark 已接入的能力**，不是 Cursor 原生 UI 的全部能力，也不是账号授权。目录、保存的配置和本轮运行回报是三个不同的数据来源；管理员是否允许某个模型必须由权限证据确认。静态契约描述标准 transport 的能力，不代表已安装实验补丁。Desktop 模型控制在异步请求时检查目标实例协议 v4，并调用专用原生操作；不能因全局存在补丁就打开所有会话的配置写入。

| 执行场景 | CodeLark 如何传 model | 生效模型由谁控制 |
| --- | --- | --- |
| 已绑定 Cursor Desktop 对话 | `resolveCursorInvocationModel` 返回 `undefined`；`sendMessage` 仅发送 threadId、text 和 delivery/force，没有 model 字段 | Cursor Desktop 对话自己的模型选择 |
| 新建 Cursor Agent tmux 进程、无已有 chat UUID | 启动参数包含解析后的 `--model`，空配置回退到 `gpt-5.3-codex` | CLI 根据启动参数选择模型 |
| 冷恢复已有 Cursor Agent chat UUID | 仅 session scope 的 model override 转成 `--model`；不把 home/channel 默认值传给已有会话 | 有覆盖时使用启动参数，否则跟随 Cursor 已有会话 |
| 复用仍在运行的 Cursor Agent TUI | 不重新启动，也不因配置变化注入模型切换命令 | 运行中 TUI 自己的模型状态 |

### 配置入口与模型目录

- `/provider` 始终报告 `tmux`。Desktop 会话的 `/p tmux` 保持原对话，不重启、不弹 CLI 重启确认、不修改 transport；`/p default` 只清除无关覆盖。CLI 会话保留既有 `/p tmux` 重启行为。`/tmux-screen` 按 transport 读取 Desktop 状态或 CLI 屏幕，provider 字段统一为 `tmux`。
- `/model <slug>` 和 `/current` 的 CLI 模型选择器保存 session scope 的 `runtime.cursor.model`；保存不会给已有 TUI 注入切换命令。Cursor 原生 TUI 支持 `/model` 选择器，这是 Cursor 的能力，不能与 CodeLark 尚未接入运行中切换混为一谈。`/model <文字>` 会筛选原生选择器，不保证立即应用一个 slug。
- Desktop 的 `/model` 通过可选 v4 协议读取目标对话的原生模型选择器和当前选择；`/model <id>` 调用同一 thread 的原生 setter，回读匹配后才确认成功。模型列表采用 Cursor 自身的账号/管理员过滤，切换前再次校验，不借用 CLI 目录。`/current` 隐藏独立 model/effort 表单，提供进入同一 `/model` 入口的按钮，旧表单的相关修改仍整体拒绝。Desktop 不再另存一份未应用的 TOML 模型覆盖；原生 composer 保存选择，是唯一配置来源。标准 v1 及旧增强 v2/v3 没有模型操作，明确提示可选能力未启用；`/reasoning` 仍须在 Cursor 中调整。
- `/set cursorDefaultModel` 和管理 UI 保存默认配置，遵守上述新建/恢复边界。`/model default` 在 CLI 路径只删除 session override；新建 CLI 会话仍可能使用上层默认或内置 `gpt-5.3-codex`，不能笼统理解为所有启动都省略 `--model`。
- CLI 路径的 `/model`、`/current` 及全局 `/set` 共用 `agent models` 返回的目录，但不展示其 `current/default` 标记，也不根据它们预选模型或定位页码。配置 slug 在目录中时才预选；无覆盖或自定义 slug 不在目录中时不伪造已选值。
- **模型目录不等于账号可用权限。** 2026-10-09 实测目录包含用户确认被管理员禁用的 Fable；原生 TUI 选择器没有该选项，但用启动参数仍可显示该名称。启动成功和名称显示都不是生成请求获准的证明，未发起生成请求的实验不能称为“模型可用”。当前 CLI 目录文本不提供管理员禁用标记，因此 CodeLark 明确提示实际使用受账号权限限制，不根据目录推断权限，也不硬编码某个模型的禁用状态。
- 对话卡片初始化时，Desktop 显示“跟随 Cursor Desktop”，不再把 CodeLark 保存的覆盖值标为运行模型。随后由本轮 hook/event 更新运行回报。

### 尚未接入或仍需改善的行为

- v4 的 `getThreadModels` / `setThreadModel` 经已认证的 main → renderer action 调用 AISettingsService、管理员策略和 modelConfigService。仅更新目标 composer，不更新全局偏好、不提交 prompt、不修改正在生成轮次的模型标签。原生回读只证明模型选择成功，实际生成及模型权限仍须用后续原生执行回报确认。
- Cursor hook 可以同时给出 `model=<模型>-high` 与 `model_id=<基础模型>`，另一些 hook 只有基础模型的 `model`。当前 Desktop transport 从 `afterAgentThought` 更新模型，不再让工具 hook 的基础模型覆盖思考 variant；仅凭不同原始 hook 的后缀差异不能断言切换了模型或思考级别。
- `/tmux-screen` 的 Desktop 状态优先读取最近 hook，其次是持久化 summary，最后回退到显示策略。最近记录不能证明一个新轮次的模型；审计时应关联 conversation ID、generation ID 和时间，优先核对 `beforeSubmitPrompt` 等原始运行记录。

2026-10-09 对生产版本的取证发现：session 保存模型 A 后，下一轮仍通过 Desktop 的 `sendMessage` 提交且没有 model 参数；同一 generation 的 `beforeSubmitPrompt` 回报模型 B，旧卡片从 A 更新成 B。管理员禁用模型 A 与 CodeLark 未下发模型参数是两项事实，不能推断为 Desktop 收到 A 后自动回退到 B。本次修正消除了无关 CLI current 展示及 Desktop 假成功，Desktop 模型切换现由可选 v4 另行接入，CLI 运行中模型同步尚未接入。

## 生命周期

### Cursor Desktop

1. `/t` 从 Desktop conversation index 识别出的会话写入 `provider=tmux, transport=desktop`，保留原 thread UUID。读取旧 `provider=desktop` 时按 Desktop transport 兼容，启动或再次选择时迁移为新结构；没有 Desktop thread id 的 fresh session 使用 CLI transport。
2. 发送前读取 `~/.cursor/desktop-bridge/*.json`，验证目录/文件仅当前用户可读、协议版本、live PID、Unix socket 和 64 位 hex token，再通过 Bearer 鉴权向 `/` 提交 `listThreads`。目标必须是 live 列表中的精确 thread id。
3. 输入使用 `sendMessage` 单次提交，不受 CLI 的 `--force` 权限设置影响。默认 `auto` 在无补丁 v1 使用原生 queue，在增强 v2+ 请求 `delivery=steer`；因此普通消息无需修改 Cursor.app。显式 steer 遇到 v1 在发送前报错。运行中追加绕过本地轮次排队、复用原输出 observer；增强尝试将该消息的 queue item 提升为 steer。返回 `submitted`、`queued` 或 `steered` 时按实际语义处理，steer 降为 queued 必须显示原因，不重发。无 discovery、stale PID、目标 thread 不存在、不可发送、HTTP 错误或超时都明确失败，绝不改走 CLI/ACP。
4. 原生库可读时采用上述共享 source；以下 hooks/transcript 行为仅为旧版兼容路径。provider 在提交前同时记录 transcript EOF，并订阅按 Cursor logs root 共享的异步 hook tailer。tailer 用递归 `fs.watch` 唤醒一次串行异步 reconcile，并保留低频异步 fallback 防止平台漏报、合并事件或 log rotation；它只维护一份文件 offset、半包尾部和内存事件 ring，不随并发 turn 重复扫描。`afterAgentThought.text` 作为弱化引用逐条进入正文历史；超过 2000 字符时完整放入默认收起的思考面板，不截断内容。footer 只保留简短的“正在思考”，并用 thought hook 的真实 reasoning model variant 更新模型；`preToolUse` / `postToolUse` 以 Cursor 原生 `tool_use_id` 更新同一个工具块的开始与结果。工具 hook 的 base model 不回退卡片模型，`beforeShellExecution` / `afterShellExecution` 也不生成会抢在工具块前面的泛化 footer。其他 conversation 和 baseline 之前的历史都不会发出。
5. provider 同时从发送前 transcript EOF 续读回答正文与终态。`queued` 时上一轮可能先产出 hooks、assistant 和 `turn_ended`，因此在本次新 turn 被 transcript 识别前丢弃这些旧 hook；旧 turn 终态不能结束本轮。hook 工具以名称和输入关联 transcript 的合成 ID，最终 transcript 结果只更新已有工具，不新建重复项。
6. 原生路径由 Desktop Bridge status 负责后端生命周期，SQLite bubbles 负责思考、正文与工具结果；兼容路径由 hooks 负责实时过程、transcript 负责正文与 `turn_ended`。`/stop` 及 Stop 按钮通过 v3 `stopThread` 调用已绑定 agent 的原生 `abortChatAndWait()`，并持有引用直到请求完成，不依赖本地 active task，也不向物理 tmux 发按键。确认只表示 `interrupt-requested`；observer 保持读取，终态仍以原生事件/transcript 为准。v1/v2 不支持 Stop 时明确报错，不能将本地 abort 描述为后端停止。修正后的 v4 事件提供 snapshot/finish/stop/error 信号；v2/v3 的事件 action 跨 await 使用失效访问器，默认不再调用，仍由 hooks/transcript 收取输出。

Cursor 的 Beta 设置必须启用 `Allow CLI to access desktop agents`。该能力由 Cursor 自己的版本/账号 feature gate 控制；开关不存在时 CodeLark 不能代替 Cursor 开启，只能保持显式不可用。

### Cursor Agent tmux

当前内置默认模型固定为 `gpt-5.3-codex`，而不是省略 `--model` 交给官方 `auto`。在 Cursor Agent `2026.07.23-e383d2b` 的隔离 A/B 中，`auto` 会把同一 assistant state 写入四次后以 `WritableIterable is closed` 失败，显式 `gpt-5.3-codex` 则只写一次并成功；用户仍可通过 `/model` 覆盖。兼容 parser 会折叠同一 turn 的完全相同 assistant state，但真实 `turn_ended error` 仍按失败交付，不能伪装成功。

1. provider 为 Bridge session 使用固定 tmux 名 `clk-cursor-<bridgeSessionId>`。
2. 冷启动运行 `agent [--model ...] [--force] --trust`；配置 effort 时使用 Cursor 官方参数化模型语法 `model[effort=...]`，并保留已有 `context`、`fast` 等模型参数。已有 chat ID 时附加 `--resume <chatId>`。显式 `/p tmux` 完成前重新校验聊天 binding；如果启动期间 `/clear` 或 `/t` 已改绑，只清理旧 tmux，不写回旧 session。
3. provider 检查 pane 未退出、未停在登录页且已出现输入编辑器。Cursor 首次进入较大工作区时会先做 workspace indexing，这一阶段进程仍存活但 pane 可能完全空白；它属于合法冷启动，而不是 CLI 退出或 prompt parser 失败。显式 `/p tmux` 会在等待 TUI 前立即回复“首次打开工作区时可能需要先建立索引”；普通消息触发冷启动时，当前流式卡片会立即显示同类说明，并从第 10 秒起持续更新已等待时间。readiness 默认最多等待 180 秒；若窗口用尽但 pane 仍活着，只结束当前 IM turn，并说明索引可能仍在进行，同时保留 tmux，下一条消息会重新执行 readiness 后复用它。登录页、pane 退出等确定失败仍立即报错并清理；未登录时提示先运行 `agent login`。
4. 普通用户消息原样注入 TUI。tmux 的 `paste-buffer + Enter` 只证明按键已发送，不证明 Cursor 已接受本轮；workspace indexing 尚未收口时，Cursor 可能把文字留在带 `→` 的输入编辑器里并吞掉第一次 Enter。provider 会在短暂渲染宽限后抓屏确认：输入框已经清空才算投递成功；若原文仍在输入框，则按固定间隔重发 Enter，并在同一流里说明“正在确认提交”。运行期输入栏会显示 `Add a follow-up`，并在同一行右对齐显示 `ctrl+c to stop`；后者是操作提示，不属于草稿值，解析时必须先剥离。这条确认不解析回答，只验证输入所有权边界。输入框清空后立即向用户转移为“Cursor Agent 已接收消息，正在运行”；不得因 transcript 尚未 flush 而继续显示启动确认。首次消息真正提交后，再从当前 cwd 新增的 chat sidecar/transcript 发现 UUID，并写入 Bridge session。
5. provider 从当前 transcript offset 开始轮询增量，直到 `turn_ended`，同时把文本、工具调用与终态转换成公共事件；bridge 输入状态被清空但 tmux 仍存活时，依靠已持久化 UUID/transcript 和真实输入框完成冷接管，不重启 TUI。
6. 当前 IM turn 由 Cursor provider 从本轮 transcript offset 读取并形成 direct stream；独立 Cursor mirror runtime 观察同一 transcript，使本地 TUI 后续输出也能同步到 IM。identity 出现后建立 suppression 边界；direct turn 完成时保留一段 mirror grace suppression，但不等待 mirror terminal，因为当前 terminal owner 明确是 direct transcript stream。这样既不重复结束同一回合，也不会产生“等待一个不归 mirror 所有的 terminal”超时误报。
7. tmux 丢失时按同一 UUID 执行 `agent --resume`，从旧 transcript 末尾继续读取；不得重放上一轮回答。
8. stop、clear、unbind、archive 和群生命周期清理使用同一个 provider-owned tmux session 名，并进入共享 stop/cleanup owner。

## 验收用户故事

- **本地 workflow**：Cursor direct transcript turn 与后台 mirror 之间只有一个 terminal owner，不出现空 completed、重复 final 或历史重放。
- **真实进程**：已登录官方 `agent` 首次启动前注入一次超过旧 30 秒门限的确定性延迟，证明等待期间有可见进度且不会误杀；若首次 Enter 被冷索引阶段吞掉，抓屏确认会在原文仍留在输入框时补发提交。输入被真实 TUI 接收后、第一个 transcript 输出或终态前，必须出现用户可见的“正在运行”状态。随后冷启动一个 UUID，第二轮在清空 bridge 输入状态后复用同一 tmux/UUID，杀掉 tmux 后仍恢复同一 UUID；三轮都只有一个 completed 且不重放旧文本。延迟 wrapper 只控制启动时序，实际 TUI、tmux、backend 和 transcript 仍全部来自官方 Cursor Agent。
- **真实飞书**：隔离 bridge 创建或复用测试群并邀请当前用户；用户身份发送 `/runtime cursor`、`/p tmux` 和普通消息。冷启动场景还要在 `/p tmux` 完成前读到索引原因提示；随后用户身份回读最终卡片、Cursor UUID/transcript/provider output path，测试群保留到用户确认。`runtime-message::cursor-tmux` 还会读取隔离 bridge 输出的最终 CardKit checkpoint，要求卡片具有共享会话标题、`tmux` header tag、`cursor`/model metadata 区域和统一 history 区域；thinking summary 必须作为独立的引用样式历史项出现在最终正文之前，不能丢失、混入正文或误占卡片标题。只在历史回显中找到 prompt，或者只看到正确回答文本，都不算 UI 验收通过。

## Slash 命令

[Cursor 官方 slash 命令](https://cursor.com/docs/cli/reference/slash-commands)属于交互式 TUI 控制面，直接在 tmux 中执行，不由 SDK 或 transcript parser 实现。

CodeLark 自己也使用 `/...` 命令，因此原生 Cursor 命令通过 `/tmux <Cursor 命令>` 发送，例如 `/tmux /mcp list`。`/new`、`/fork`、`/resume` 虽可发送给 TUI，但首版不自动重绑变化后的 chat ID；需要切换底层会话时优先使用 CodeLark `/new` 和 `/t`。

## 兼容性边界

- Cursor 是独立 `RuntimeAgent`，provider identity 统一为 `cursor:tmux`；`desktop` / `cli` 仅是内部 transport，不是可切换的 provider。
- Cursor chat UUID、cwd、transcript 和 tmux 生命周期不复用 Codex/Kimi 的身份字段。
- Cursor CLI 不存在、未登录、pane 提前退出、Desktop Bridge 不可用、transcript 未出现或长时间无活动时返回明确错误，不回退到其他 runtime/provider。
- readiness 超时与 pane 退出不是同一种错误：前者保留仍存活的 provider-owned tmux 供观察和下一轮接管，后者按失败进程清理。
- Codex、Claude Code 与 Kimi Code 既有 routing、session 和 mirror 行为保持不变。

共享 hook tailer 按实际读取字节推进游标，单次异步读取最多 256 KiB，剩余增量继续异步调度。每个文件保留未完成的 hook 标题、JSON 和 UTF-8 解码状态，避免跨次写入丢失中文或思考内容；文件轮转时重置解析状态。


### 可选 Desktop 增强的安装与完整卸载

**实验性、默认不安装。** 这是直接修改 Cursor.app 中 main、Desktop、Glass 三个 JavaScript bundle 的兼容补丁，非官方扩展或公开 API，可能影响应用签名。普通收发使用标准 v1，不依赖补丁；增强提供 steer（v2+）、原生 Stop（v3+）和会话模型切换（v4）。同一 provider 仍叫 `tmux`。

```bash
# 只读状态和安装计划，不修改应用
codelark cursor-desktop-patch status
codelark cursor-desktop-patch install
# 明确选择修改应用后，才使用此参数安装 / 升级
codelark cursor-desktop-patch install --allow-app-modification
# 查看将恢复的原始文件，再按需完整卸载
codelark cursor-desktop-patch uninstall --dry-run
codelark cursor-desktop-patch uninstall
```

所有命令可传 `--app <Cursor.app>`。`restore` 是完整卸载的兼容别名。安装器验证三个 bundle 的锚点和语法后生成私有备份与 SHA-256 清单，原子替换；升级前必须能验证已有安装的原始备份链。卸载先校验全部文件，沿多轮升级链恢复最初没有 CodeLark 标记的版本，不只是撤销最近一次升级。文件遭外部修改、备份损坏或与当前 Cursor 版本不匹配时拒绝覆写，保留备份以供恢复。重复卸载不产生改动。

安装、卸载不会自动重启 Cursor，也不会由 bridge 启动、hot update 或升级自动执行。手动重启后新进程才加载变更；磁盘 `status` 会明确显示 `runtimeVerified=false`，不能用 discovery 公告版本替代实际窗口的功能验证。Glass 与 Desktop 使用各自的服务标识，增强实现共用。

2026-10-09 的真实 v3 部署虽可启动并列举 thread，但 Stop/事件 action 在 await 后取 ServicesAccessor 导致 Illegal state。事件失败又被吞为空结果，使每秒轮询反复弹错。v4 在首次 await 前同步取得全部服务，向客户端返回事件错误；新 bridge 也不调用已知有缺陷的 v2/v3 事件 action。v4 模型切换仅完成隔离协议、原生服务模拟和安装包副本检查，尚未安装验证；不能将测试或安装成功表述为生产功能已可用。普通断开输出订阅或 bridge 退出不应自动终止用户的 Desktop 任务。

用户另反馈实际已 steer 却报告 queued：投递现在先检查 queue item 的 delivery，已有 steer 不重复提升；提升后重新读取状态，避免将重复调用的 false 当作仍排队。进行中和条目消失只报告尚不能确认；只有明确的普通队列状态才报 queued。相应测试模拟原生访问器同步失效、自动 steer 和提升返回 false 的竞态。
