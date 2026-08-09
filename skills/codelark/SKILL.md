---
name: codelark
description: Use when an agent runs through CodeLark and needs to send Feishu/Lark messages or local files, ask the user with a card, create /every or /then automation cards, inspect available CodeLark chats, or send ordinary input to another CodeLark-managed agent.
---

# CodeLark

Use completed/final responses for CodeLark control blocks. Keep ordinary user-facing prose outside the blocks. Do not expose control-block implementation details unless the user asks.

## Send Feishu messages

Use `<clk-send>` with the official Feishu `msg_type + content` shape. Put JSON directly inside the block, without a Markdown fence.

Text, including an official Feishu @ tag:

```text
<clk-send>
{"msg_type":"text","content":{"text":"<at user_id=\"ou_xxx\">名字</at> 请查看结果"}}
</clk-send>
```

Rich post:

```text
<clk-send>
{"msg_type":"post","content":{"zh_cn":{"title":"进度","content":[[{"tag":"text","text":"任务已完成"}]]}}}
</clk-send>
```

Feishu interactive card:

```text
<clk-send>
{"msg_type":"interactive","content":{"header":{"template":"blue","title":{"tag":"plain_text","content":"任务状态"}},"elements":[{"tag":"markdown","content":"已完成"}]}}
</clk-send>
```

Upload a local image or file with CodeLark's `local_path` extension. The path must be absolute and already exist:

```text
<clk-send>{"msg_type":"image","local_path":"/absolute/result.png"}</clk-send>
<clk-send>{"msg_type":"file","local_path":"/absolute/report.pdf"}</clk-send>
```

The legacy `{"type":"image|file","path":"...","caption":"..."}` shape remains supported. Prefer the official shape for new output. Multiple instructions may use `{"items":[...]}`.

## Ask with a card

Use `<clk-ask>` when the user must choose, confirm, approve, or provide one short value before work can continue:

```text
<clk-ask>
{"question":"请选择发布策略","options":["灰度","全量"],"input":{"label":"补充说明","placeholder":"可留空"},"submitText":"提交","allowTextReply":true}
</clk-ask>
```

Keep options short, mutually exclusive, and at most eight. Do not use a card when an ordinary text question is enough.

## Create automation cards

Send a normal command back into the current CodeLark lane with target `current`:

```text
<clk-input>{"target":"current","text":"/every-form"}</clk-input>
<clk-input>{"target":"current","text":"/then-form"}</clk-input>
```

If the user already supplied all values, create the task directly:

```text
<clk-input>{"target":"current","text":"/every 20m 检查实验进度"}</clk-input>
<clk-input>{"target":"current","text":"/then 总结当前任务结果"}</clk-input>
```

## Discover chats and talk to another agent

CodeLark does not inject the global chat catalog into prompts. Query it only when the task needs another chat. Use the executable's compound filters and JSON output:

```bash
codelark sessions --query diffusion --json
codelark sessions --home /home/user/.codelark --chat-name "project" --bot-name "reviewer" --runtime codex --json
```

Filters are combined with AND. `--query` is fuzzy across fields; `--chat-id`, `--chat-name`, `--bot-name`, `--home`, `--runtime`, and `--status` are exact. `chat_id` is always the internal UUID returned by CodeLark; do not substitute a platform or bridge ID. If zero sessions match, report that. If multiple sessions match, refine the filters instead of guessing.

Send ordinary text to another session's existing lane:

```text
<clk-input>
{"target":{"chat_id":"internal-chat-id","codelark_home":"/absolute/home"},"text":"请检查训练状态并回复我"}
</clk-input>
```

The target selector also accepts `chat_name`, `bot_name`, `runtime`, and `query`; all supplied fields are combined with AND. CodeLark sends only after the selector resolves to exactly one live session. The target receives the text unchanged, so `/stop`, `/model`, and other commands keep their normal CodeLark meaning.

Incoming Agent messages include one `<codelark_source>` wrapper with readable source-chat, source-Bot, and one reply target. To reply, copy its exact `chat_id` and `codelark_home` into the target; do not substitute another ID. CodeLark submits the whole multiline message as one input and shows compact sent/received cards in both groups after the target Bridge accepts it.

## Rules

- Verify local files before sending them.
- Put every CodeLark control block on its own line. Inline tag names in prose are ordinary text.
- Use Feishu's official message schema; do not invent `msg_type` values.
- Escape JSON correctly, especially quotes inside `<at user_id="...">`.
- Do not claim a cross-Agent send succeeded; CodeLark owns acceptance and failure cards.
- Use `target: current` only for commands intended for the current chat.
