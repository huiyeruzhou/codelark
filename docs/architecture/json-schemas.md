# JSON Schema 与本地数据契约

CodeLark 为 `~/.codelark` 下的本地数据文件发布 JSON Schema。入口文件在仓库根目录的 `schemas/manifest.json`。

这些 schema 主要服务三件事，不负责自动升级：

- 在 bridge 读取前校验用户手动编辑过的本地文件。
- 给 `doctor` 或显式修复脚本提供机器可读的文件清单。
- 把禁止回流的旧字段写成可测试的契约。

如果数据结构需要调整，运行时代码或一次性脚本必须显式处理；JSON Schema 只描述“当前应该长什么样”。项目不维护历史 schema 兼容面，所以当前发布的 schema 版本都从 `1` 开始。

## 文件清单

| 运行时文件 | Schema | 说明 |
| --- | --- | --- |
| `config.json` | `schemas/config.v1.schema.json` | 结构化配置，版本字段是 `schemaVersion: 1`。 |
| `version-check.json` | `schemas/version-check.v1.schema.json` | 每日 npm 版本检查状态：最新版本、忽略到的版本、最后检查日期；bridge 启动时读取一次并在进程内缓存。 |
| `data/sessions.json` | `schemas/data/sessions.v1.schema.json` | 以 Bridge session id 为 key 的 map；保存当前 BridgeSession 的 runtime-local identity，例如 `runtime.codex.threadId`、`runtime.claude.sessionId/cwd` 或 `runtime.kimi.sessionId/cwd`。 |
| `data/channel-chats.json` | `schemas/data/channel-chats.v1.schema.json` | 以 ChannelChat id 为 key 的 map；使用 `bridgeSessionId` 指向 session，禁止保存底层 runtime identity 和旧 binding 运行时字段。 |
| `data/channel-default-targets.json` | `schemas/data/channel-default-targets.v1.schema.json` | 以 channel instance id 为 key 的默认目标 map；使用 `bridgeSessionId`，启动时会丢弃缺少它的旧记录。 |
| `data/messages/*.json` | `schemas/data/messages.v1.schema.json` | 单个 BridgeSession 的消息数组。 |
| `data/permissions.json` | `schemas/data/permissions.v1.schema.json` | 权限请求链接。 |
| `data/offsets.json` | `schemas/data/string-map.v1.schema.json` | 通道消费偏移 map。 |
| `data/dedup.json` | `schemas/data/number-map.v1.schema.json` | 去重时间戳 map。 |
| `data/audit.jsonl` | `schemas/data/audit.v1.schema.json` | 审计记录，当前新记录按 JSONL 追加；schema 描述单条记录形状和旧 `audit.json` 数组形状。 |

`version-check.json` 不属于用户配置，也不参与配置迁移。缺失或损坏时按三个 `null` 字段重新开始；同一自然日的检查日期会在访问 npm registry 前先在内存中 claim，避免当天第一批并发消息重复查询。registry 查询失败也会写入当天日期，下一条消息不会立即重试。

## 版本策略

JSON Schema 本身不执行迁移。`schemas/manifest.json` 只声明当前文件清单、当前 schema 路径和缺失文件策略：

1. 读取 `schemas/manifest.json`。
2. 将每个 `files[].path` 解析到 `~/.codelark` 下。
3. 如果文件不存在，按 `missingFile` 策略处理。
4. 用当前 schema 校验当前文档。

`schemaVersion` 是当前配置文件格式的断言，不是自动升级开关。破坏性调整发生时，如果项目决定不兼容旧格式，就直接更新 v1 schema 和代码。

## Runtime 身份迁移

当前启动迁移主要修复历史 Codex thread 身份重构，并清理旧 binding 运行时字段。这是显式 TypeScript 代码，不是 schema 自动升级能力。

迁移前，旧数据里可能出现多种 thread 字段：

- `sdk_session_id`
- `sdkSessionId`
- `desktop_thread_id`
- `desktopThreadId`
- `thread_origin`
- `threadOrigin`
- `thread_id`
- `threadId`
- 旧 binding 上的 `codex_thread_id`
- 旧 binding 上的 `codexThreadId`

Codex 旧字段迁移后的目标只有一个：

```text
BridgeSession.runtime.codex.threadId
```

具体规则：

- session 上的 `sdk_session_id`、`desktop_thread_id`、`thread_id` 会在 session 没有 `runtime.codex.threadId` 时折叠进去。
- 旧 binding 到 ChannelChat 的迁移不在启动路径执行；显式脚本只保留 `active: true` 的旧记录，并把 `workingDirectory`、`model`、`mode`、`chatDisplayName` 迁到对应 session 的空字段，成功后删除旧 `data/bindings.json`。
- 旧 `data/ui-session-meta.json` 里的名称会合并到 `sessions.json.name`；只有本地 Codex thread 名称而没有 BridgeSession 时不会再创建新 BridgeSession，然后删除 `ui-session-meta.json`。
- 旧 `data/channel-default-targets.json` 会从 target selector 字符串改写成 `bridgeSessionId`。如果 selector 指向本地 Codex thread，会先 materialize 成 BridgeSession，再删除旧 selector 字段。

## 身份规则

底层 runtime identity 必须保存在 `BridgeSession.runtime` 下：

```text
data/sessions.json
```

- Codex 使用 `runtime.codex.threadId`。
- Claude Code 使用 `runtime.claude.sessionId` 和 `runtime.claude.cwd`。
- Kimi Code 使用 `runtime.kimi.sessionId` 和 `runtime.kimi.cwd`。

同一个 `BridgeSession.runtime` 只能表示一个 active runtime namespace。schema 对 Claude 和 Kimi runtime 要求 `activeRuntime`，并禁止同一 runtime object 同时保存其他 agent 的 local identity。

`data/channel-chats.json` 只能通过 `bridgeSessionId` 指向 session。它不应保存任何底层 runtime identity，因为 ChannelChat 的职责是“IM chat -> BridgeSession”，不是“IM chat -> Codex thread / Claude session / Kimi session”。

Schema 会拒绝这些已删除身份字段：

- `sdk_session_id` / `sdkSessionId`
- `desktop_thread_id` / `desktopThreadId`
- `thread_origin` / `threadOrigin`
- `thread_id` / `threadId`
- ChannelChat 上的 `codex_thread_id` / `codexThreadId`

## 与架构链路的关系

Schema 约束的是这条链路：

```text
runtime-local identity
  -> data/sessions.json 中的 BridgeSession.runtime.*
  -> data/channel-chats.json 中的 ChannelChat.bridgeSessionId
  -> channelType + chatId 对应的 IM chat
```

如果 schema 允许 ChannelChat 保存底层 runtime identity，这条链路就会出现两个身份来源，history、mirror、reuse 和 `/t` 切换都会变得不一致。因此 schema 层必须把 Codex thread、Claude session 和 Kimi session 身份固定在 BridgeSession 上。
