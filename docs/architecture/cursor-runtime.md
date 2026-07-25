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

同时兼容旧的 `agent-transcripts/<encoded-chatId>.jsonl`。官方 transcript writer 在正常执行时增量 append：

- `{role:"user|assistant|tool", message:{content:[...]}}`；
- `text` 与 `tool_use` content block；
- `{type:"turn_ended", status:"success|error|aborted"}` 终态。

CodeLark 把这些行归一化为公共 message/tool/task mirror record 和 SSE 事件。

## 生命周期

1. provider 为 Bridge session 使用固定 tmux 名 `clk-cursor-<bridgeSessionId>`。
2. 冷启动运行 `agent [--model ...] [--force] --trust`；已有 chat ID 时附加 `--resume <chatId>`。
3. provider 检查 pane 未退出、未停在登录页且已出现输入编辑器；未登录时提示先运行 `agent login`。
4. 普通用户消息原样注入 TUI。首次消息后，从当前 cwd 新增的 chat sidecar/transcript 发现 UUID，并写入 Bridge session。
5. provider 从当前 transcript offset 开始轮询增量，直到 `turn_ended`，同时输出文本、工具调用与终态。
6. 独立 Cursor mirror runtime 继续观察同一 transcript，使本地 TUI 后续输出也能同步到 IM。
7. stop、clear、unbind、archive 和群生命周期清理使用同一个 provider-owned tmux session 名。

## Slash 命令

[Cursor 官方 slash 命令](https://cursor.com/docs/cli/reference/slash-commands)属于交互式 TUI 控制面，直接在 tmux 中执行，不由 SDK 或 transcript parser 实现。

CodeLark 自己也使用 `/...` 命令，因此原生 Cursor 命令通过 `/tmux <Cursor 命令>` 发送，例如 `/tmux /mcp list`。`/new`、`/fork`、`/resume` 虽可发送给 TUI，但首版不自动重绑变化后的 chat ID；需要切换底层会话时优先使用 CodeLark `/new` 和 `/t`。

## 兼容性边界

- Cursor 是独立 `RuntimeAgent`，provider identity 为 `cursor:tmux`。
- Cursor chat UUID、cwd、transcript 和 tmux 生命周期不复用 Codex/Kimi 的身份字段。
- Cursor CLI 不存在、未登录、pane 提前退出、transcript 未出现或长时间无活动时返回明确错误，不回退到其他 runtime。
- Codex、Claude Code 与 Kimi Code 既有 routing、session 和 mirror 行为保持不变。
