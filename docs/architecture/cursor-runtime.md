# Cursor tmux runtime

## 目标

CodeLark 直接在 provider-owned tmux session 中运行 Cursor 官方 `agent` TUI。tmux 负责进程生命周期和输入；Cursor 自己在后台写入 chat metadata 与 transcript JSONL，CodeLark 从 transcript 读取结构化输出，不解析终端屏幕的 ANSI/局部重绘。

首版 provider 只有 `cursor:tmux`。一个 Bridge session 固定绑定一个 Cursor chat UUID 和 cwd；不处理 TUI 内 `/new`、`/fork`、`/resume` 导致的 chat ID 变化。

## 官方证据

调查使用 [Cursor 官方安装脚本](https://cursor.com/install) 安装的 `2026.07.23-e383d2b`。安装产物提供 `agent` 与 `cursor-agent` 两个命令名。

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

可读 transcript 位于：

```text
<CURSOR_DATA_DIR 或 ~/.cursor>/projects/<workspace-slug>/
└── agent-transcripts/<encoded-chatId>/<encoded-chatId>.jsonl
```

同时兼容旧的 `agent-transcripts/<encoded-chatId>.jsonl`。官方 transcript writer 会在执行中 append 或重写 snapshot；真实工具/子 Agent 故事中也可能直到本轮接近结束才把可读 JSONL flush 到磁盘。可见记录包括：

- `{role:"user|assistant|tool", message:{content:[...]}}`；
- `text` 与 `tool_use` content block；
- `{type:"turn_ended", status:"success|error|aborted"}` 终态。

CodeLark 把这些行归一化为公共 message/tool/task mirror record 和 SSE 事件。官方 writer 还会在 assistant 回答后写入仅包含 `<|eos|>` 的内部边界块，并可能在同一 turn 先写一份 assistant state、稍后再写内容不同的最终 revision；后一个 revision 不是新的回答。对 `2026.07.23-e383d2b` 真实样本的 `store.db` 取证表明，同一 assistant message 具有 `reasoning` 与 `text` 两个 block：前者的签名载荷明确是 OpenAI `summary_text`，后者标记为 `openaiPhase=final_answer`。transcript writer 会丢失 block 类型，把正文放在前面、加粗的 thinking summary 放在后面并用空行连接；正文与 summary 都可能在下一版 snapshot 中同时改写。parser 优先比较相邻 revision 的最后一个空行边界；如果只有一版带摘要，或下一版同时改写正文并移除摘要，则只在 `turn_ended` 前后用当前 chat 的 `store.db` 核验独立 text/reasoning blocks，并要求重新扁平化后与 transcript snapshot 精确相等。核验成功后恢复 `reasoningKind=summary`，同时给正文 revision 分配稳定 `replacementKey`；没有结构化证据时不把任意末尾粗体正文猜成摘要。direct provider 通过通用 `history_item` 交付 `thinking_summary`，mirror turn 使用同一中间语义；公共历史 renderer 把它作为弱化引用插在最终回答之前，不混入正文，也不占外层卡片标题。不能匹配 `Responding...` 等具体文案，也不能让 Feishu renderer 解析 Cursor 私有文本。真实 TUI 取样表明 Cursor 完成态不显示该 summary，等待期只显示淡化的 `Working`；CodeLark 保留摘要属于自身的可观察性设计，而不是复刻一个并不存在的 Cursor title。

Cursor 不调用名为 `completed` 的工具结束一轮。assistant message 后由客户端独立追加 `{"type":"turn_ended","status":"success"}`；失败或中断也由该 terminal record 的状态表达。CodeLark 必须以 `turn_ended` 驱动终态，不能用工具名、正文停止增长或 TUI 光标位置猜测完成。同一读取批次只保留最新版正文，跨增量批次则把后续 revision 作为替换事件继续交付。多轮时 Cursor 还会重写整份 transcript、删除上一轮位于 EOF 的 `turn_ended`；旧 byte offset 可能因此落入新 user JSON 中部。增量 parser 跳过残行后若先看到完整 assistant row，必须以它建立隐式 turn 并恢复正文，不能只交付后面的成功终态。多轮后的最终 transcript snapshot 可能只保留文件末尾一个 `turn_ended`；测试应以 user/归一化后的可见 assistant record 确认轮次，以文件末尾终态确认整体完成，不能把物理 assistant/终态行数当成轮数。

## 生命周期

当前内置默认模型固定为 `gpt-5.3-codex`，而不是省略 `--model` 交给官方 `auto`。在 Cursor Agent `2026.07.23-e383d2b` 的隔离 A/B 中，`auto` 会把同一 assistant state 写入四次后以 `WritableIterable is closed` 失败，显式 `gpt-5.3-codex` 则只写一次并成功；用户仍可通过 `/model` 覆盖。兼容 parser 会折叠同一 turn 的完全相同 assistant state，但真实 `turn_ended error` 仍按失败交付，不能伪装成功。

1. provider 为 Bridge session 使用固定 tmux 名 `clk-cursor-<bridgeSessionId>`。
2. 冷启动运行 `agent [--model ...] [--force] --trust`；已有 chat ID 时附加 `--resume <chatId>`。显式 `/p tmux` 完成前重新校验聊天 binding；如果启动期间 `/clear` 或 `/t` 已改绑，只清理旧 tmux，不写回旧 session。
3. provider 检查 pane 未退出、未停在登录页且已出现输入编辑器。Cursor 首次进入较大工作区时会先做 workspace indexing，这一阶段进程仍存活但 pane 可能完全空白；它属于合法冷启动，而不是 CLI 退出或 prompt parser 失败。显式 `/p tmux` 会在等待 TUI 前立即回复“首次打开工作区时可能需要先建立索引”；普通消息触发冷启动时，当前流式卡片会立即显示同类说明，并从第 10 秒起持续更新已等待时间。readiness 默认最多等待 180 秒；若窗口用尽但 pane 仍活着，只结束当前 IM turn，并说明索引可能仍在进行，同时保留 tmux，下一条消息会重新执行 readiness 后复用它。登录页、pane 退出等确定失败仍立即报错并清理；未登录时提示先运行 `agent login`。
4. 普通用户消息原样注入 TUI。tmux 的 `paste-buffer + Enter` 只证明按键已发送，不证明 Cursor 已接受本轮；workspace indexing 尚未收口时，Cursor 可能把文字留在带 `→` 的输入编辑器里并吞掉第一次 Enter。provider 会在短暂渲染宽限后抓屏确认：输入框已经清空才算投递成功；若原文仍在输入框，则按固定间隔重发 Enter，并在同一流里说明“正在确认提交”。这条确认不解析回答，只验证输入所有权边界。输入框清空后立即向用户转移为“Cursor Agent 已接收消息，正在运行”；不得因 transcript 尚未 flush 而继续显示启动确认。首次消息真正提交后，再从当前 cwd 新增的 chat sidecar/transcript 发现 UUID，并写入 Bridge session。
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

- Cursor 是独立 `RuntimeAgent`，provider identity 为 `cursor:tmux`。
- Cursor chat UUID、cwd、transcript 和 tmux 生命周期不复用 Codex/Kimi 的身份字段。
- Cursor CLI 不存在、未登录、pane 提前退出、transcript 未出现或长时间无活动时返回明确错误，不回退到其他 runtime。
- readiness 超时与 pane 退出不是同一种错误：前者保留仍存活的 provider-owned tmux 供观察和下一轮接管，后者按失败进程清理。
- Codex、Claude Code 与 Kimi Code 既有 routing、session 和 mirror 行为保持不变。
