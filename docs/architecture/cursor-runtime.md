# Cursor runtime

## 目标

Cursor 支持两种独立 provider：`acp` 直接读取官方进程的协议事件，适合需要实时正文和工具结果的群；`tmux` 保留原生 CLI/桌面界面。通过当前会话的 `/p acp` 或 `/p tmux` 选择。切换命令走独立控制通道；运行中选择 ACP 会立即给出“结束并切换 ACP”按钮，确认后结束旧执行、保存旧身份并提交新配置，不必等待原任务结束后重发命令。全局 `cursorProvider` 只设置默认值，不应把已有另一协议的会话 ID 直接恢复到新 provider。

Cursor 的 `tmux` provider 在 CodeLark 持有的 tmux session 中运行官方 `agent` TUI。tmux 负责进程生命周期和输入；Cursor 自己在后台写入原生会话库与 transcript JSONL，CodeLark 用原生记录恢复思考摘要和工具结果，并与 transcript 的消息、正式终态对齐，回答正文、思考摘要和工具结果不依赖终端屏幕的 ANSI/局部重绘。原生问卷的题号和输入确认使用当前终端界面。

Cursor Desktop 已有对话同样使用 `cursor:tmux`，内部传输方式为 `desktop`：CodeLark 只通过 Cursor 自带 Desktop Bridge 向同一条可见对话提交输入，从同一对话的原生 SQLite bubbles 读取输出，并通过 Desktop Bridge 实时状态确认终态；旧版本原生库不可读时才使用 transcript。一个 Bridge session 固定绑定一个 Cursor chat UUID、cwd 和来源 transport；不处理 TUI 内 `/new`、`/fork`、`/resume` 导致的 chat ID 变化。

## ACP 实时输出

`cursor:acp` 启动官方 `agent acp`，通过 stdio JSON-RPC 运行 `initialize → authenticate → session/new|load → session/prompt`。正文、工具开始/结果直接更新当前卡片，不等待 SQLite/JSONL checkpoint，也不依赖 tmux。恢复时 `session/load` 的历史事件仅用于原生上下文，不能当作本轮新输出再次发到群里。模型内部 thought chunk 只对应“正在思考”状态，不把原始 thought 当回答或摘要。

任务清单在 provider 边界把原生 `content` 转成展示契约的 `text`。标准 ACP `plan.entries` 是完整列表；Cursor 的 `cursor/update_todos` 则按 `merge` 决定替换或按 `id` 合并，重复通知不会生成重复项目，取消的项目不冒充完成。原生 `session/load` 不发送完整清单，历史工具事件又缺少 `merge`，因此恢复后仅只读一次当前会话库 root 引用的 Todo，作为后续增量的初始列表；不扫描消息历史、不轮询数据库。缺失或未知格式保留未知状态，不猜测任务完成。卡片丢弃没有标题的旧任务数据，避免显示 `undefined`。

本版原生 ACP 不支持 TUI 的原位 steer。运行中收到普通追加时，CodeLark 先请求 `session/cancel`，等待原生 prompt 确认结束，再提交新输入。确认期间收到的多条追加按到达顺序合并到下一次 prompt，保留每条消息的 Get 确认；后续卡片使用最后一条输入的回复位置，因此话题内继续留在话题，话题外输入按现有规则开新话题。每个 bridge session 只有一个执行者，取消超时或进程断开要明确报错，不能重放旧 prompt 猜测恢复。

取消请求不等于旧输出已结束：在 `session/prompt` 终态之前收到的正文和工具结果仍同步到原卡，并保留到本地历史；真正被替换的任务不能再写入。旧卡以“已停止”收尾。模型尚未生成的后半句话不会由桥接层补造；网络与卡片分页收尾可能晚于新卡出现，但不得把两轮内容混在一起。

`session/request_permission` 使用现有审批卡。`cursor/ask_question` 逐题显示选项，支持单选、多选和自由文本。当前 Cursor ACP adapter 会丢弃 `freeformText`，因此只要回答包含自由文本，CodeLark 就取消问卷所在轮、等待确认，再把完整问答作为新用户消息继续同一会话；不会把文字伪装成选项 ID。问题过期、连接结束或会话改绑后，旧问题卡不再接受回答。

切换按钮只适用于发卡时的绑定和活动任务；新任务开始、绑定改变或重复点击时不执行旧操作。清理原终端失败时不提交 ACP 配置和身份。只有配置改成 ACP、原生身份仍属于 tmux 的不完整切换，也通过同一确认流程修复；普通输入仍禁止将 TUI ID 交给 ACP。

通过命令行操作时，先发送 `/p acp` 创建确认，再发送 `/p acp --confirm` 确认当前聊天的这一次切换。它使用与按钮完全相同的一次性确认和任务校验，没有待确认操作或原任务已变化时不会停止任何执行。

ACP 使用 `<Cursor配置根>/acp-sessions/<id>/store.db`，与 TUI 的 `chats/...` 分离。运行状态保存 `sessionProvider`，避免混用两个来源的 UUID。`/p` 切换保留 `previousSession` 供回退，但不会自动把旧 TUI 正文当作新消息发送。需要保留整段原生上下文的迁移必须先停止旧执行，再调用 `cloneCursorCliSessionForAcp` 将 SQLite 一致快照复制到新的 ACP UUID，验证 `session/load` 后再改绑定；源库不修改，两个进程不共用一个库。

Bridge 持有 ACP 子进程。Bridge 停止/热更新会中断并关闭这些子进程，之后从已保存的 ACP ID 恢复上下文；不宣称热更新期间原生任务仍继续。没有完成确认的输入不会自动重发。执行模式 `cursorForce` 受原生持久化权限限制，不能把重连时省略 `--force` 描述为已经撤销旧库里的 Run Everything。

回归使用真实 Cursor CLI 与隔离模型后端：在最终 checkpoint 前验证两段正文及真实执行 `printf` 的工具结果已抵达；覆盖中断、多次输入、恢复去重、问卷选项与自由文本续接、TUI 快照导入。Bridge 工作流另验中断确认前不启动新轮、连续追加不丢失、用户输入出现在卡片、回复目标和 Get 归属。

## tmux 进程恢复与手动同步

普通群消息提交前检查 tmux 的 `pane_dead`。窗口存在但 Cursor 已退出时，使用原 `--resume <chatId>` 自动拉起；存活进程继续复用，原生接收确认前不报告输入成功。输入进入 follow-ups 后，即使旧编辑框文字仍可见，也不能重试提交；仅在原生界面明确提供 `enter steer` 时推进一次。粘贴后先等本条内容出现在原生编辑框，再发送一次 Enter；确认阶段不依据残留草稿或缺失的运行提示补交普通 Enter。旧输入的延迟落盘不能否定本条输入；只有本条内容新增的原生记录才能确认接收。停止请求立即取消输入确认循环。收到本条输入的原生确认前，旧轮次的外部终态不能结束本条请求。

Cursor 启动时若登录过期，会自动运行官方 `agent login`，在当前卡片提供浏览器授权链接；网页确认仍由用户完成。部分 CLI 把认证失败显示成“模型不可用”且可用列表为空，Bridge 仅在这种失败后调用 `agent models` 区分认证错误与真正的模型不可用，普通启动不增加额外网络请求。同一登录目录的多个群共用一次登录，各自可停止等待；最后一个等待者退出后关闭本次登录进程。登录成功后按原 UUID、目录、模型恢复一次，再提交尚未发送的消息；不自动换模型、不重放已接收输入。环境变量 API key/token 失效时明确要求更新对应变量，网页登录不能覆盖它们。启动失败保留当前窗口的错误现场，下一次输入仍可自动重建死进程；不改变其他 tmux 窗口的设置。

自动登录恢复目前发生在提交输入之前。已经被原生接收的回合若中途认证失效，仍报告该回合失败，不重复提交历史输入。桥接重启不会持久化浏览器登录子进程；重新发消息会重新检查并发起登录。

CodeLark 管理的普通消息提交前先检查编辑框：空闲时先通过 Backspace/Delete 让编辑器与父层输入状态一致，若仍有内容再用一次 Ctrl+C 清除完整草稿，并回读确认空输入框。长驻 CLI 可能显示残留文字而父层已为空，此时只按 Ctrl+C 不生效；Ctrl+U 又只能删除一行。单字符草稿经编辑键清空后不再发 Ctrl+C。运行中或 follow-ups 队列存在时若编辑框另有草稿，保留现场并报告本条未发送，不能中断当前轮或把新问题拼在旧稿后。手动 `/tmux-key` 控制键不走此替换流程。`cursor-idle-submit.e2e.test.ts` 覆盖中文、多行来源标记残留后的连续独立输入，fake 模型校验请求内容和次数。

Cursor 的首次输入、空闲续聊、运行中追加和 `/tmux` 文本均整块粘贴，原样保留换行，然后只发送提交键。不能复用逐行粘贴加 `Alt+Enter` 的通用输入方式：恢复会话期间换行键可能作为 ESC/回车混入粘贴正文，原生实际收到的内容与待确认请求不一致，延长等待或继续按 Enter 都无法修复已损坏的文本。真实 CLI 回归包含完整来源标记、中文、多行正文及换行键落入粘贴文本的故障回放；假模型校验实际接收到的完整请求。

本地新输入通过独立 mirror 同步。Cursor user 记录显式提取 `user_query`，用于与群输入做准确去重；上一条失败群消息不能把随后不同的本地输入当作自身回声。CLI transcript 按 snapshot 读取，即使 inode 不变、文件变大，也按事件身份接续；短暂空文件不能清掉已读位置，避免下一次写入重放历史。

真实 CLI 回归 `cursor-recovery.e2e.test.ts` 覆盖官方 API 401 后登录链接出现、模拟网页授权后原会话自动恢复且仅提交一次、停止后授权不补交、模型确实不可用时不发起登录或换模型，以及死进程自动拉起、原会话身份不变、失败群输入后本地手动对话在模型完成前出卡，并收尾为成功。`cursor-steer.e2e.test.ts` 覆盖 follow-ups 与旧草稿同时显示的边界，fake 后端确认仅收到一次同轮追加；取消和同 inode 历史重写由定向状态回归覆盖。

## 原生问卷与等待回答

CLI 的 `AskQuestion` 在用户回答前保存在 `ConversationStateStructure.pending_tool_calls`（protobuf field 4）。此时 transcript 和 field 1 的已提交消息可能都没有问题；仅轮询 transcript 会让飞书一直显示“上次响应很久之前”，而原生 CLI 实际在等人回答。

Bridge 从当前原生 root 读取问卷，通过现有会话巡检逐题发送卡片。卡片正文纵向保留完整问题和选项，下方用短编号按钮选择，不能把长选项按钮放在整段题目旁边。单选可以点击按钮，文字回答直接发在当前群，多选回复用逗号分隔的编号。等待期间显示“等待你的回答”，不把无模型输出误报成模型卡死。问卷和工具结果来自原生存储；终端只用来确认当前题号并输入答案，不用于生成回答正文。

回答通过即时串行控制入口绕过当前轮的消息等待；提交前校验聊天绑定、原生会话、工具调用和题号，提交后必须看到下一题或同一工具的原生结果才报告成功。重复、过期及跨聊天回调不能回答其他问题。Bridge 恢复时读取尚未完成的原生问卷，并复用已发送的问题卡片。其他 Codex 会话的 thread/resume 在后台独立恢复，不能阻塞 Cursor 的问卷、输出订阅或结束卡。若终端已填入 Other 文字，多选编号不会静默清除或带上旧文字；需要回复新文字覆盖，或在终端调整后再回答。覆盖时先确认 Other 已获焦点，将光标移到行尾后清空，并确认空输入框，再写入并确认新文字；不能假定 Ctrl-U 总会删除整行。普通追加消息不得向问卷输入框注入新任务或重试 Enter；未知问卷界面保留等待提示，要求查看 `/tmux-screen`，不自动选择默认答案。

本地回归 `src/__tests__/e2e/local-process/cursor/cursor-ask-question.e2e.test.ts` 启动已安装的官方 CLI，将两个官方 endpoint 指向隔离的 HTTP/HTTP2 fake 后端。fake 模型实际发出 `AskQuestion` 并接收原生工具结果；测试经过聊天调度、卡片/文字回答、SQLite 和 transcript，直到同一轮输出完成标记。测试不直接写原生数据库，不使用真实模型账号；未安装 CLI 的环境明确跳过此用例。

## 官方证据

调查使用 [Cursor 官方安装脚本](https://cursor.com/install) 安装的 `2026.07.23-e383d2b`，并在 `2026.10.01-e373342` 复核。安装产物在 `~/.local/bin` 提供 `agent` 与 `cursor-agent` 两个软链，二者指向同一版本目录中的 `cursor-agent` 启动脚本；CodeLark 优先使用 `~/.local/bin/agent`，因此不要求 Bridge 的 PATH 包含 `~/.local/bin`。

官方 CLI 支持：

- `agent`：启动交互式 TUI；
- `agent --resume <chatId>`：恢复指定会话；
- `--model`、`--force`、`--trust`：模型、执行模式和工作区信任控制；
- `-p --output-format stream-json`：headless 结构化输出，可用于协议取证，但不是本 provider 的执行路径。

官方包 `@cursor/sdk@1.0.24` 也提供 `Agent.create`、`Agent.resume` 和 `run.stream()`，但 SDK 的公开 API 不包含 CLI slash-command 控制面。当前需求需要直接运行官方 TUI 并保留其命令行为，因此首版不引入 SDK 生产依赖。

## 后台会话文件

CLI 的主会话正文与 SQLite checkpoint 可能长时间不刷新，不能把这段记录空白直接认定为模型没有执行。在已有 `<transcript>.tool-events/` 工具事件目录的环境，CodeLark 只读最近一条会话、来源路径和事件类型均匹配的工具活动，用真实事件时间补充卡片状态及健康观察。不会安装或执行 hook，不把工具开始事件当成完成，不从这些事件生成模型最终回答。没有工具事件目录时继续读取原生会话。正文追上后以正文为准，同一轮的最近活动时间只前进，迟到正文的旧时间不会覆盖已经观察到的新工具活动；原生终态之后的迟到工具事件不能重开旧轮次。该补充目前展示最近工具活动，不替代完整工具历史。

卡片超过 30 分钟没有新执行记录时，显示“长时间未收到新的执行记录，尚未确认当前执行状态”，不继续重复最初的“正在运行”，也不据此中断或重发输入。等待问卷回答时仍优先显示待回答问题；新记录出现后恢复正常状态说明。

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

CLI 原生根状态使用 protobuf，`meta[0].latestRootBlobId` 指向当前状态，`rootPromptMessagesJson`（bytes 字段 1）给出有序消息 blob 引用。CodeLark 只按这些引用读取原生 JSON 消息；不扫描孤立旧 blob 来推断工具成功。原生消息保留 `text` / `reasoning`、`tool-call.toolCallId` 与 `tool-result`，导出的 transcript 则可能合并正文和思考、丢掉工具结果。当前实现因此用原生记录恢复展示语义，仍用 transcript 的正式终态结束回合。未知或不可读的原生格式保留 transcript 路径，不伪造工具完成。`meta.json` schema v1 提供 `title`、`createdAtMs`、`updatedAtMs`、`hasConversation`、`isSubagent` 与 `cwd`，用于会话发现和列表。

`/cd` 修改 Bridge 的工作目录，不能改变仍在运行的原生 CLI chat 的存储位置。直接流发送前先按已绑定的 chat UUID 找到原生 metadata、store 和 transcript；当前目录找不到时，再跨目录查同一个 UUID，绝不替换为新目录最近的其他会话。读取基线、输入回执和后续正文/终态必须使用同一份原生记录；已有 tmux 不会因 `/cd` 自动切换目录。这样既避免静默等待不存在的 transcript，也避免重新读取旧轮造成重复输出。

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

CodeLark 把这些行归一化为公共 message/tool/task mirror record 和 SSE 事件。Cursor 会用原子替换重写 transcript snapshot，因此 mirror watch transcript 所在目录而不是文件 inode；否则第一次 replace 后 watcher 可能失效，只能等 hot 2.5 秒或 cold 60 秒轮询兜底。官方 writer 还会在 assistant 回答后写入仅包含 `<|eos|>` 的内部边界块，并可能在同一 turn 先写一份 assistant state、稍后再写内容不同的最终 revision；后一个 revision 不是新的回答。对 `2026.07.23-e383d2b` 真实样本的 `store.db` 取证表明，同一 assistant message 具有 `reasoning` 与 `text` 两个 block：前者的签名载荷明确是 OpenAI `summary_text`，后者标记为 `openaiPhase=final_answer`。transcript writer 会丢失 block 类型，把正文放在前面、加粗的 thinking summary 放在后面并用空行连接；正文与 summary 都可能在下一版 snapshot 中同时改写。parser 优先比较相邻 revision 的最后一个空行边界；如果只有一版带摘要，或下一版同时改写正文并移除摘要，则只在 `turn_ended` 前后用当前 chat 的 `store.db` 核验独立 text/reasoning blocks，并要求重新扁平化后与 transcript snapshot 精确相等。核验成功后恢复 `reasoningKind=summary`，同时给正文 revision 分配稳定 `replacementKey`；没有结构化证据时不把任意末尾粗体正文猜成摘要。direct provider 通过通用 `history_item` 交付 `thinking_summary`，mirror turn 使用同一中间语义；公共历史 renderer 把它放进默认折叠的“思考摘要”，保留原生段落；最终回答独立展示，不占外层卡片标题。摘要修订通过稳定子元素更新正文，不重置用户的展开状态。不能匹配 `Responding...` 等具体文案，也不能让 Feishu renderer 解析 Cursor 私有文本。真实 TUI 取样表明 Cursor 完成态不显示该 summary，等待期只显示淡化的 `Working`；CodeLark 保留摘要属于自身的可观察性设计，而不是复刻一个并不存在的 Cursor title。

Cursor 不调用名为 `completed` 的工具结束一轮。assistant message 后由客户端独立追加 `{"type":"turn_ended","status":"success"}`；失败或中断也由该 terminal record 的状态表达。CLI 与旧版 transcript 路径必须以 `turn_ended` 驱动终态，不能用工具名、正文停止增长或 TUI 光标位置猜测完成。同一读取批次只保留最新版正文，跨增量批次则把后续 revision 作为替换事件继续交付。多轮时 Cursor 还会重写整份 transcript、删除上一轮位于 EOF 的 `turn_ended`；旧 byte offset 可能因此落入新 user JSON 中部。增量 parser 跳过残行后若先看到完整 assistant row，必须以它建立隐式 turn 并恢复正文，不能只交付后面的成功终态。多轮后的最终 transcript snapshot 可能只保留文件末尾一个 `turn_ended`；测试应以 user/归一化后的可见 assistant record 确认轮次，以文件末尾终态确认整体完成，不能把物理 assistant/终态行数当成轮数。

Cursor 后台活动还可能连续写入只有 `<timestamp>…</timestamp>` 的 `user` 行。只有时间戳、空白或 `<|eos|>` 的纯文本行不代表新的用户输入，parser 在改动回合及 occurrence 状态之前忽略它们，避免空卡泛洪及打断当前工具/回答；同一规则用于完整 snapshot 和增量读取。含真实正文、`user_query`、图片或其他非文本 block 的 user 行仍建立新回合，相同的真实提问也仍保留各自的 occurrence。

### Desktop 原生输出与实时生命周期

镜像源优先服从 Bridge 已绑定的 `transport`，不能用会话发现索引覆盖 Desktop/CLI 身份。Desktop 的索引或 workspace 映射缺失时，同 ID 的旧 CLI metadata 可能仍存在；只要原生 conversation 可读，仍读取原生库。原生库临时不可读而退到 transcript 后，每 30 秒检查能否恢复原生读取，避免永久盯住延迟导出的文件。

Desktop direct 与 mirror 共用 `CursorDesktopSessionSource`：读取 `globalStorage/state.vscdb` 的 `cursorDiskKV`，以 user bubble 建立 turn，以 tool bubble ID 关联开始和真实结果。SQLite 主文件和 WAL 均参与变更检测；内存 revision ledger 将原地更新的迟到结果追加到上次读取位置之后，已初始化且签名仍可匹配时不再用消息发送时间水位过滤它。进程重启仍用持久化水位抑制历史重放。Read/Grep 已被 Cursor 清理的正文只说明“未保留完整原始输出”，不重读现在的文件伪造历史结果。

**持久化 `composer.status` 不能决定当前回合结束。** 2026-10-09 真实取证中，root 仍为旧 `aborted`、时间停在用户提交时，但工具持续新增，标准 v1 `listThreads` 返回 `running`。direct 与 mirror 在读取前刷新同一 thread 的实时状态，只有 `completed` / `error` 连续两次且该对话内容不变时才收尾；`running`、等待输入的 `idle`、`unknown` 或查询失败都保留当前回合。状态观察绑定查询前的对话内容，查询中新增用户/工具使旧终态失效；其他对话写同一库不会阻塞本线程收尾。mirror 即使文件字节未变化也检查实时状态。每个 turn 的终态签名固定，已确认关闭的历史修订不重开卡片。

同一 turn 反复创建消息与同一卡片整卡重绘是两个独立问题。Feishu history renderer 现在为工具详情提供稳定 element ID；工具完成只更新标题、边框和正文，新工具追加到已有组，局部请求不写 `expanded` 或替换已有 children。正常连续工具调用不再触发整卡更新；组件能力缺失、结构不兼容、失败或超预算仍沿用既有整卡恢复/continuation。

### 长断档历史补发

Cursor mirror（Desktop 原生库与 transcript 共用）在生成或投递历史卡片之前检查积压。存在超过 2 分钟的记录，且上次实际同步距今至少 30 分钟（无同步位置时看最早积压），或旧记录达到 100 条 / 10 轮回复时，停止自动补发，只发一张“选择历史同步范围”卡。长期空闲后刚到达的新回复不触发此确认。

- **跳过历史**：跳过选择时刻之前的积压，后续新内容继续同步。
- **最近 20 条回复**：在同一张卡中翻页查看最近 assistant 回复摘要，每页 5 条、从新到旧，每条最多截取 1500 字符；不补工具调用、推理过程或历史 continuation 卡。完整记录仍可在 Cursor 查看。
- 读取积压、内存缓冲与失败重试队列共用此检查。等待选择时暂停 mirror 输出，并保留最多 20 条最新摘要，不持续堆积投递队列。`/sync-history` 可重新打开选择；也可直接用 `/sync-history skip`、`/sync-history 20`。
- 读取游标、摘要、选择 ID 与结果落盘；自动提示最多尝试一次，网络超时或重启不会反复发提示。提示发送失败时可以用上述命令恢复。旧按钮校验群绑定、thread 与选择 ID，已处理的选择按钮不再次补发。翻页按钮更新原卡，重启后仍可继续翻页；`/sync-history` 可重开已选的20条。以后再次断档仍会发起新的选择。

选择后的时间水位仅用于游标丢失或源重建时抑制旧记录；正常增量中的同一 turn 新回复/迟到工具结果即使保留旧时间戳也继续交付。

此策略只控制 Cursor mirror 到聊天群的输出，不停止 Cursor 任务，不改变 provider/transport，不拦截已由 direct turn 接管的记录。其他 runtime 的同步策略保持原状。

## CLI 思考摘要和工具展示

CLI 原生 `reasoning.text` 是进度摘要来源。某些模型在摘要字段中先输出 `Thinking Process:` 起草过程，末尾才给出要求的粗体标题与单段摘要。CodeLark 只展示最后这份摘要；起草过程不进入回复正文。识别限定在原生 `reasoning` 字段，普通回答即使讨论 `Thinking Process:` 也原样保留；缺少完整摘要时不把草稿当回答。

工具按当前用户回合、完整参数和同参数调用次数匹配原生 `toolCallId`，再读取该 ID 的实际结果。保留已有 transcript 工具 ID，因此 SQLite 稍晚写入、snapshot 重写、mirror 恢复都不会重复创建工具。结果晚到且 JSONL 未变化时仍能更新状态；明确失败结果展示错误，未知结果继续等待。`Glob` 的 `glob_pattern` 和 `target_directory` 进入公共文件搜索展示，不再展示一块未解释的参数 JSON。

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
4. 普通用户消息以整块 bracketed paste 保留换行，再提交一次 Enter；冷启动、空闲续聊、运行中追加和显式 `/tmux` 文本共用这条发送方式。已知原生会话时，接收确认读取当前根 `ConversationState.turns` 所引用的 `UserMessage`，包括 `text_blob_id` 外置文本。`turns` 也依赖 Cursor 的 checkpoint 写入，并不保证接收瞬间落盘；`rootPromptMessagesJson` 是可能更晚才更新的模型上下文，不能作为唯一接收来源；工具结果仍从后者读取。只跟随当前根中的有序引用，不扫描孤立 blob，不把两份记录相加；相同文字再次提交必须出现新的记录。旧格式没有 turns 时兼容读取模型上下文。首次还没有原生 store 的冷启动才使用屏幕接收证据，随后发现 UUID 并写入 Bridge session。

普通多行草稿既可能紧跟输入箭头，也可能缩进显示在空箭头下一行。识别范围覆盖两种编辑框布局，不依赖来源标签。桥接重启仅撤销监听，必须保留取消原因 `BRIDGE_SHUTDOWN_REASON`，Cursor 不得把它当作失败清理并删除 tmux；恢复后读取原生会话继续同步，不重新发送原请求。

接收确认不设固定截止时间：已发送的输入在首次 checkpoint 迟到时仍保持原卡等待，定期显示待确认状态；晚到记录确认后点 Get，继续读取同一任务的工具和结果。`CODELARK_CURSOR_TMUX_INPUT_READY_TIMEOUT_MS` 只控制发送前的冷启动 readiness，不再把发送后的慢回执变成任务失败。进程退出、认证失败或用户取消仍结束等待，不能依靠延长超时或重复发送掩盖问题。

接收确认只比较当前输入正文在提交前后的记录次数。前一条消息可能在后一条等待期间才写入 checkpoint；其他正文的记录增加，既不证明本条已经接收，也不证明收错内容，必须继续等待本条自己的记录。没有本条回执时不能提前点 Get，不能因为总记录数增加就报“输入不一致”。

提交前先确认粘贴内容已显示在编辑框，再按一次 Enter。提交后即使残留草稿，也不能猜测提交键丢失并补交；出现 follow-ups 同样不能把残留文字视作未提交草稿。等待确认接受当前任务的 AbortSignal，停止后不继续发键。输入接收与模型完成分别确认，不能要求模型先输出或完成才添加 Get。
运行中追加通过独立、按聊天串行的即时输入队列发送，不等待上一轮的 session lock 或 conversation barrier；Cursor CLI 复用已有 TUI 和输出流，Desktop 复用原 observer。首条消息与追加消息都在确认输入提交后添加 Get 表情，未提交或失败时不提前确认。当前 Cursor CLI 的第一次 Enter 会先将运行中输入放入 follow-ups；运行中追加会先记录原生消息基线，输入框清空只是中间状态；等待界面明确出现 `enter steer` 后，只再按一次 Enter 请求加入当前轮，并等待原生会话新增这条用户消息才确认接收。终端重绘延迟时继续观察，不能用一次空输入框快照报告成功。已显示 steering 时等待确认，不重复按键；仅提供 interrupt and send 时明确说明消息还在队列，不主动中断任务。


空闲的已知会话同样必须比较提交前后的原生用户消息，不能因为屏幕仍显示空的 `Add a follow-up` 就确认成功：输入框重绘可能落后于粘贴和 Enter。等待原生确认期间，空输入框或重新出现的草稿都不触发重复 Enter。历史中已有相同文字也不能当作这次接收，必须看到新增记录。

配置入口为 Cursor TUI 的 `/config` → General → Steering，对应 `~/.cursor/cli-config.json` 的 `steering: true`；若设置 `CURSOR_CONFIG_DIR`，则读取该目录，其他情况下也尊重 `XDG_CONFIG_HOME/cursor`。配置开启后，还需 Cursor 原生 `agent_context_injection` feature gate、活动 run 和远端 agent 同时可用，界面才会显示 `enter steer`。这时额外 Enter 提交的是带当前 run ID 的 `injectContextAction`，不会主动终止正在执行的回合；仅输入框清空或出现 Get 表情只能证明 Cursor 接收了输入，不能证明模型已经消费。

5. provider 轮询当前 transcript 快照中的新增事件，直到 `turn_ended`，同时把文本、工具调用与终态转换成公共事件。与 Codex/Claude 的输出等待逻辑一致，只要进程仍存活且用户未取消，就继续等待正式终态；没有新 JSONL 或没有固定英文运行提示都不构成失败。Cursor 可能在模型 checkpoint 后才首次写入 transcript，因此首次文件发现也不设固定截止时间；旧的 `CODELARK_CURSOR_TMUX_SESSION_FILE_TIMEOUT_MS` 和 `CODELARK_CURSOR_TMUX_OUTPUT_IDLE_TIMEOUT_MS` 不再控制本路径。抓屏仅检查明确的认证错误或 pane 退出，回答与成功终态仍必须来自 JSONL。用户取消或进程退出会结束等待，不会自动重发用户消息。bridge 输入状态被清空但 tmux 仍存活时，依靠已持久化 UUID/transcript 和真实输入框完成冷接管，不重启 TUI。
6. 当前 IM turn 由 Cursor provider 读取 transcript 快照并形成 direct stream；独立 Cursor mirror runtime 观察同一 transcript，使本地 TUI 后续输出也能同步到 IM。两条路径均从完整用户行恢复回合身份：Cursor 续聊会删掉旧 `turn_ended` 行并重写文件，文件变大也不代表只追加了内容。direct 在提交前记录已有回合和事件，之后仅投递新回合中未发送的事件；SQLite 迟到结果仍可补发，旧回合的迟到结果与终态不进入新卡片。direct 在每个新原生 turn 的首条事件之前发送 native_turn 身份，bridge 将该 turn 归属写入 mirror 读取位置并清除其已缓冲记录。后台 mirror 按这些原生 ID 排除直接流负责的轮次，包括多次 steer、晚到工具结果、快照重写和进程重启；不再用 prompt 匹配和两分钟过期决定 Cursor 输出归属。后台 mirror 不能抢先把终态送入 direct 的收尾通道，必须让直接流按原生顺序先消费 steer、工具和正文，再处理终态。已结束的直接轮次重启后仍不回放；尚未结束的当前轮次单独标记，bridge 重启后由 mirror 接续新输出，不因历史归属而静默。原生轮次同时保存最近一次已确认输入的平台消息来源；多次 steer 和延迟首条确认不能把来源退回旧消息。mirror 接管正文与最终回复时使用该轮次的持久来源，新本地轮次不继承旧话题。本地独立产生的新 turn 仍由 mirror 同步。
7. tmux 丢失时按同一 UUID 执行 `agent --resume`，以提交前快照作为历史边界继续读取；不得重放上一轮回答。

Cursor 后台 mirror 同样等待正式原生终态，不使用通用的 10 分钟缓冲空闲截止，即使卡片仍在异步创建中。CLI transcript 的时间戳来自用户回合，后续工具可能一直沿用该时间；它不代表最近一次工具输出时间，不能据此把新收到的结果判为超时。
8. stop、clear、unbind、archive 和群生命周期清理使用同一个 provider-owned tmux session 名，并进入共享 stop/cleanup owner。

## 验收用户故事

- **连续追加与延迟上下文**：真实 CLI + fake 模型在同一 native run 接收两条快速不同补充、三条快速相同补充；逐条核对输入、唯一 injection ID 和 Get，不重开 run、不按 Enter 复制队列。另在已有会话中延迟首条输入的 checkpoint，等下一条已进入 follow-ups 后才释放，验证不同消息的晚到回执不导致误报或重复提交。空闲续聊用 gate 阻止模型终态与上下文更新，仍须在输入已保存到 turns 时确认接收。

- **工具结果与快照重排**：真实 CLI 从 fake backend 保存工具调用和结果，Bridge 重启后先收到中间正文、随后才允许模型完成；断言正文位于旧原生工具结果之前仍立即到卡片。同一场景的原生库回归还覆盖签名持久化、旧修订暂时消失后恢复不重放。

- **本地 workflow**：Cursor direct transcript turn 与后台 mirror 之间只有一个 terminal owner，不出现空 completed、重复 final 或历史重放。
- **真实进程**：已登录官方 `agent` 首次启动前注入一次超过旧 30 秒门限的确定性延迟，证明等待期间有可见进度且不会误杀；提交前必须确认粘贴文本已在编辑框显示，不能仅凭 tmux 已接收字节就按 Enter；提交后的旧画面不能触发重发。输入被真实 TUI 接收后、第一个 transcript 输出或终态前，必须出现用户可见的“正在运行”状态。随后冷启动一个 UUID，第二轮在清空 bridge 输入状态后复用同一 tmux/UUID，杀掉 tmux 后仍恢复同一 UUID；三轮都只有一个 completed 且不重放旧文本。延迟 wrapper 只控制启动时序，实际 TUI、tmux、backend 和 transcript 仍全部来自官方 Cursor Agent。
- **真实飞书**：隔离 bridge 创建或复用测试群并邀请当前用户；用户身份发送 `/runtime cursor`、`/p tmux` 和普通消息。冷启动场景还要在 `/p tmux` 完成前读到索引原因提示；随后用户身份回读最终卡片、Cursor UUID/transcript/provider output path，测试群保留到用户确认。`runtime-message::cursor-tmux` 还会读取隔离 bridge 输出的最终 CardKit checkpoint，要求卡片具有共享会话标题、`tmux` header tag、`cursor`/model metadata 区域和统一 history 区域；thinking summary 必须作为独立的引用样式历史项出现在最终正文之前，不能丢失、混入正文或误占卡片标题。只在历史回显中找到 prompt，或者只看到正确回答文本，都不算 UI 验收通过。

## Slash 命令

[Cursor 官方 slash 命令](https://cursor.com/docs/cli/reference/slash-commands)属于交互式 TUI 控制面，直接在 tmux 中执行，不由 SDK 或 transcript parser 实现。

CodeLark 自己也使用 `/...` 命令，因此原生 Cursor 命令通过 `/tmux <Cursor 命令>` 发送，例如 `/tmux /mcp list`。`/new`、`/fork`、`/resume` 虽可发送给 TUI，但首版不自动重绑变化后的 chat ID；需要切换底层会话时优先使用 CodeLark `/new` 和 `/t`。

## 兼容性边界

- Cursor 是独立 `RuntimeAgent`，provider identity 统一为 `cursor:tmux`；`desktop` / `cli` 仅是内部 transport，不是可切换的 provider。
- Cursor chat UUID、cwd、transcript 和 tmux 生命周期不复用 Codex/Kimi 的身份字段。
- Cursor CLI 不存在、未登录、pane 提前退出、Desktop Bridge 不可用、transcript 未出现或长时间无活动时返回明确错误，不回退到其他 runtime/provider。
- 输入准备/提交超时保留仍存活的 provider-owned tmux 供观察；运行阶段不设 transcript 空闲截止，提交前认证失效走官方登录恢复；其他启动错误保留窗口供检查，已接收回合的退出/认证错误报告失败并结束。需要终止仍在等待上游的会话时，使用已有停止操作。
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

### 普通回复、思考摘要与公式

Cursor 当前群的普通回答由对话卡片自动同步。公共 CLI 通过调用方 tmux 会话核对当前群，默认拒绝向自己的 Cursor 群额外发送 text/post；跨群消息、附件和专用卡片仍按原协议发送。用户明确要求独立通知时可传 `--separate-message`。这防止长驻会话仍使用旧 skill 内容时继续补发普通回答。

思考摘要取自 Cursor 原生 reasoning 字段，卡片以默认折叠的“思考摘要”展示，保留原有标题与段落；不再把长摘要改成展开的 Markdown 引用。最终回答独立展示，桥接不额外调用模型重写摘要。

飞书普通消息与 JSON 2.0 卡片使用不同的 Markdown 渲染器。官方卡片富文本文档列出 CommonMark 与部分 HTML，未列出 LaTeX 数学公式能力；桥接在出站时将简单公式转换为行内文字、复杂公式转换为图片；含公式的表格直接用原始 Markdown 与 TeX 整表转图，失败时保留文本表格。详见 [流式卡片的数学公式适配](streaming-card.md#数学公式)，不能把代码块语言 `latex` 当作数学排版支持。


### tmux 启动阶段的原生会话身份

首次初始化 tmux 与首条用户输入可能分两次进入 provider。Cursor 在首条 transcript 前已经创建空 chat 的 meta；这时必须保留该原生 ID，不能从同目录旧 transcript 中挑一个“最新会话”。空 chat 只参与 provider 内部身份发现，不进入普通会话列表。明确的 `--resume` 以其 ID 为准；新启动窗口只考虑创建于该 tmux session 启动之后的唯一 CLI chat，出现多个候选就拒绝猜测。显式保存的 ID 在空 chat 尚未生成 transcript 时也不得丢弃。

回归覆盖：同目录已有已完成会话，先初始化一个新空 chat，稍后才提交首条输入；两阶段始终引用新 chat，卡片不得读取旧记录。真实 CLI + 受控模型端到端保留两份原生会话，验证只各提交一次，并由新会话输出完成结果。热更新验收除检查 pane PID，还必须核对 Bridge 原生 ID 与当前启动身份一致。

### CLI 快照修订与自动中断续接

同一轮 CLI 输出通常保留用户输入时的时间戳，终态也可能没有独立时间。只有无法用已保存事件身份接续的历史恢复，才按最后投递时间排除旧记录；成功按轮次和事件签名去重的实时修订必须继续投递，否则后续工具、正文和完成事件会一起消失。正常轮次在重启后仍按保存的事件签名去重，不重放原回答。

CLI 的独立内部行 `Your previous response was interrupted. Continue from where you left off.` 在已有活动轮次时属于自动恢复，沿用原轮次、未完成工具和话题卡片。用户输入中的同一句话带 `user_query` 包装，仍作为新输入处理。回归必须覆盖先投递再续写、双次中断恢复、终态关闭原卡、重启不重复，以及失去身份后的旧历史仍被过滤。
