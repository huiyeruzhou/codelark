# 斜杠命令与运行时/Bridge 配置边界

本文整理当前 IM slash 命令、配置项与 `BridgeSession` 存储边界，作为后续把 `CodexRuntime` 扩展到 Claude Code 前的收口依据。

当前入口：

- 命令别名：`src/bridge/command/aliases.ts`
- 命令分发：`src/bridge/command/dispatch.ts`
- SessionRuntime 命令：`src/bridge/command/runtime-settings.ts`
- Provider 切换命令：`src/bridge/command/provider-settings.ts`
- Codex thread 预创建：`src/bridge/command/runtime-bootstrap.ts`
- Runtime session helper：`src/bridge/command/runtime-session.ts`
- 命令展示 helper：`src/bridge/command/presentation/`
- GlobalRuntime / Bridge 配置命令：`src/bridge/command/global-settings.ts`
- 配置结构与 env 映射：`src/configuration/schema.ts`、`src/configuration/fields.ts`、`src/configuration/projections.ts`
- 配置读取/覆盖：`src/configuration/static-loader.ts`、`src/configuration/service.ts`
- Legacy 配置 adapter：`src/configuration/legacy.ts` / `legacy-types.ts`，只保留给 migration 和 compatibility 测试，生产代码不直接依赖
- BridgeSession 类型：`src/domain/session.ts / src/runtime/contracts.ts`
- JSON 存储：`src/storage/json-store.ts`

## 收口原则

- 终端工具、运维命令、Bridge 控制命令不写 Runtime 默认值。
- SessionRuntime 命令只写当前 `BridgeSession` 的运行覆盖值。
- GlobalRuntime 命令只写对应 runtime 自己的默认值；Codex 配置不能 fallback 到 Claude，Claude 配置也不能 fallback 到 Codex。
- GlobalBridge 配置只影响 bridge 自身行为，例如工作空间根、UI 服务、通道、消息展示和状态观测。
- provider/thread/session id 这类身份字段属于 runtime-specific identity，不应继续作为通用 `BridgeSession` 顶层字段扩散。

## 命令分组

### 终端工具

这些命令提供远程终端或文件查看能力，属于 bridge 的操作面。它们读取当前 effective `session.workspace` / tmux session 配置；这些值来自 scoped TOML，不应被当成 GlobalRuntime 配置。

| 命令 | 当前职责 | 存储交互 |
| --- | --- | --- |
| `/shell` | 在当前会话目录通过 `codex sandbox` 执行 shell command | 读取 effective `session.workspace`；自己的 sandbox 参数来自命令实现，不写 `/sandbox` 配置 |
| `/tmux*` | 远程控制任意 tmux session，包括 attach/switch/new/status/screen/set | 用户配置写 Session TOML 的 `session.tmux*`；provider 自动生成的 tmux session name 作为运行身份保留在 BridgeSession JSON |
| `/cat` | 查看当前工作目录下文件内容 | 读取 effective `session.workspace` |
| `/file` | 把本地文件回传到 IM | 读取 effective `session.workspace` 和通道发送能力 |

### 运维命令

这些命令观察或修复 bridge 运行状态，不改变 Codex/Claude 的模型执行参数。

| 命令 | 当前职责 | 存储交互 |
| --- | --- | --- |
| `/doctor` | 诊断配置、日志、通道、会话健康 | 读取 config、runtime 状态、日志、session/binding |
| `/health`、`/check` | 当前或全部 session 健康检查 | 读取/展示 `runtime_status`、`health_*`、stream/tool 进度字段 |
| `/current` | 展示当前聊天绑定的 BridgeSession 和 runtime 摘要 | 读取 binding/session/effective runtime |
| `/his`、`/history` | 展示当前 BridgeSession 消息历史 | 读取 `data/messages/<session>.json` |
| `/status` | 展示全局 bridge/adapters 状态 | 读取 bridge runtime 状态，不写 Runtime 配置 |
| `/hot-update` | 派发本地 bridge hot update | 运行运维脚本，不写 Runtime 配置 |

### Bridge 控制

这些命令改变 IM chat、BridgeSession、provider transport 或 bridge 任务状态。它们会影响下一轮路由，但不应归为模型 runtime 参数。

| 命令 | 当前职责 | 存储交互 |
| --- | --- | --- |
| `/new`、`/n` | 创建新的正式 BridgeSession，或基于当前会话目录新建线程 | 创建 `BridgeSession`；工作目录和模型/mode/reasoning/provider 继承写入新 session TOML |
| `/clear` | 当前聊天切到新的 BridgeSession | 创建/切换 binding，必要时终止当前任务 |
| `/t`、`/thread`、`/threads` | 列表、接管、切换、归档本地 Codex thread 和 Bridge session | 写 `ChannelChat.bridgeSessionId`；接管 Codex 时写 `BridgeSession.runtime.codex.threadId/title` |
| `/t rename` | 重命名当前 BridgeSession，部分通道同步群名 | 写 `BridgeSession.name` |
| `/provider`、`/p` | 在 Codex SDK provider 与 Codex TUI pty/tmux provider 间切换 | 写 Session TOML 的 `runtime.codex.provider` / `runtime.claude.provider`；tmux 时只把自动生成 tmux session name 和必要的 `runtime.codex.threadId` 作为运行身份写 BridgeSession JSON |
| `/stop` | 停止当前运行任务 | 触发 bridge 任务控制；tmux provider 下映射为 tmux interrupt |
| `/perm` | 权限审批回调 | 读写 permission link 状态 |

### 会话运行时配置

这些命令写当前会话的运行覆盖值。当前通过 `ConfigService` 写 Session TOML，旧 BridgeSession JSON 中的同名 runtime 配置字段只作为 v1 启动迁移输入，不再作为运行时 fallback。

| 命令 | 当前写入字段 | Codex 语义 | Claude Code 迁移判断 |
| --- | --- | --- | --- |
| `/runtime` | `runtime.activeRuntime` | `codex` 时普通消息进入 Codex routing provider | `claude` 时普通消息进入 Claude Code pty provider；不改变 `/provider` |
| `/mode`、`/m` | `runtime.codex.mode` | `normal/yolo`，`yolo` 强制 `danger-full-access` 与 `permissionMode=never` | 可映射到 Claude permission mode，但枚举不能直接复用 |
| `/reasoning`、`/r` | `runtime.codex.reasoningEffort` | `modelReasoningEffort` | Claude 不应 fallback 到 Codex reasoning；需要 Claude 自己的 thinking/budget 配置或不支持 |
| `/sandbox`、`/sb` | `runtime.codex.sandboxMode` | Codex sandbox mode | Claude Code 没有同名 sandbox；不能共用 |
| `/network`、`/net` | `runtime.codex.networkAccess` | Codex network access | Claude Code 网络通常由工具权限/环境决定，不能共用 |
| `/model` | `runtime.codex.model` | Codex model；已有本地 Codex thread 时只允许查看 | 应拆成 runtime-specific model，例如 Codex model 与 Claude model 分开 |

当前有效 Codex runtime 参数由 `resolveSessionRuntimeConfig()` 产出：

| 有效参数 | 当前 fallback | 收口问题 |
| --- | --- | --- |
| `mode` | Session TOML `runtime.codex.yoloMode` -> v2 global `runtime.codex.yoloMode` | Codex 专属；旧 BridgeSession JSON 同名字段只作为迁移输入 |
| `model` | Session TOML `runtime.codex.model` -> v2 global `runtime.codex.model` | Codex/Claude 模型名空间分开，不能互相 fallback |
| `codexProvider` | Session TOML `runtime.codex.provider` -> v2 global `runtime.codex.provider` -> tmux/pty 环境探测 -> `sdk` | 旧 BridgeSession JSON `runtime.codex.provider` 只作为迁移输入，不再作为运行时 fallback |
| `sandboxMode` | `mode=yolo` 强制；否则 Session TOML `runtime.codex.sandboxMode` -> v2 global `runtime.codex.sandboxMode` | Codex 专属 |
| `networkAccessEnabled` | Session TOML `runtime.codex.networkAccess` -> v2 global `runtime.codex.networkAccess` | Codex 专属 |
| `reasoningEffort` | Session TOML `runtime.codex.reasoningEffort` -> v2 global `runtime.codex.reasoningEffort` | Codex 专属 |
| `skipGitRepoCheck` | v2 global `runtime.codex.skipGitRepoCheck` | Codex 专属全局默认 |

### 全局运行时配置

当前 `RuntimeConfig` 把 provider 固定成 `codex`，并把 Codex 执行参数、工作空间、UI 和 stream 状态混在 `runtime` 下。接入 Claude 前需要拆成 runtime-specific 默认值。

建议目标结构：

```ts
interface GlobalRuntimeConfig {
  defaultRuntime: 'codex' | 'claude';
  codex: {
    defaultModel?: string;
    defaultMode?: 'normal' | 'yolo';
    skipGitRepoCheck?: boolean;
    sandboxMode?: CodexSandboxMode;
    networkAccess?: boolean;
    reasoningEffort?: CodexReasoningEffort;
  };
  claude: {
    executable?: 'claude' | 'ccr';
    defaultModel?: string;
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    idleTimeoutMinutes?: number;
  };
}
```

当前 key 归属建议：

| 当前 `/set` key | 新归属 | 说明 |
| --- | --- | --- |
| `defaultModel` | `runtime.codex.defaultModel`，新增 `runtime.claude.defaultModel` | 不能再作为跨 runtime 通用 fallback |
| `defaultMode` | `runtime.codex.defaultMode`，Claude 只做显式映射 | 不同 runtime 权限语义不同 |
| `codexSkipGitRepoCheck` | `runtime.codex.skipGitRepoCheck` | Codex 专属 |
| `codexSandboxMode` | `runtime.codex.sandboxMode` | Codex 专属 |
| `codexNetworkAccess` | `runtime.codex.networkAccess` | Codex 专属 |
| `codexReasoningEffort` | `runtime.codex.reasoningEffort` | Codex 专属 |
| `defaultProvider` | Bridge 控制默认值 | `sdk/tmux` 是 Codex provider transport，不是模型默认值 |
| `claudeExecutable` | `runtime.claude.executable` | 只允许 `claude` 或 `ccr`；这是 Claude Code 启动命令，不是 provider |

### 全局 Bridge 配置

这些配置属于 bridge 自身，不属于任何 runtime 的模型执行参数。

| 配置或命令 | 新归属 | 说明 |
| --- | --- | --- |
| `defaultWorkspaceRoot` | `bridge.sessionCreation.defaultWorkspaceRoot` | 影响 `/new <relative>`，不是 provider 参数 |
| `historyMessageLimit` | `bridge.history.defaultLimit` | 影响 `/history` 展示 |
| `streamStatusIdleStartSeconds` | `bridge.feedback.streamStatusIdleStartSeconds` | 运行观测 |
| `streamStatusCheckIntervalSeconds` | `bridge.feedback.streamStatusCheckIntervalSeconds` | 运行观测 |
| `/ui` | 固定显示策略 | 工具详情始终显示 |
| `uiAllowLan`、`uiAccessToken` | `bridge.ui` | UI server |
| Feishu / Weixin channel config | `channels[]` | 通道连接、访问控制、消息呈现 |
| `/require-at` | channel instance 或 chat policy | 飞书群聊触发策略 |

## BridgeSession 与 Codex/ClaudeCode 差异

当前 `BridgeSession` 是 bridge 本地会话容器，已经承担以下通用职责：

- IM chat 的绑定目标：`ChannelChat.bridgeSessionId` 指向它。
- 当前工作目录：effective `session.workspace`，持久化在 scoped TOML。
- 用户可见名称：`name`，以及创建/更新时间。
- 本地消息历史：`data/messages/<sessionId>.json`。
- 运行状态与健康状态：`runtime_status`、`queued_count`、`health_*`、tool/stream/mirror 字段。
- session 生命周期：`session_type`、`hidden`、`parent_session_id`、`expires_at`。

当前 session runtime schema 把 provider-specific 状态放在 `runtime` 容器中：

- `runtime.codex.threadId`：Codex thread/resume identity。
- `runtime.codex.title`：从本地 Codex thread 读取的原始标题。
- `runtime.codex.provider`：旧 JSON 中的 Codex transport 选择只作为迁移输入；当前 transport 选择由 scoped TOML `runtime.codex.provider` 表达。
- 旧 `runtime.codex.sandboxMode/networkAccess/reasoningEffort/provider/model/mode`：只作为迁移输入；当前执行参数读取 scoped TOML。
- `runtime.general.tmuxSessionName`：仅作为 provider 自动生成 tmux session identity 保留；用户 tmux 配置读取 scoped TOML。

### Codex 当前语义

Codex 在 bridge 中有两种身份来源：

- Bridge 自己创建的 IM session：没有 `runtime.codex.threadId` 时按 `im_sdk/new_bridge_thread` 运行；SDK 或 tmux 事件返回 thread id 后写回 `runtime.codex.threadId`。
- 接管已有本地 Codex thread：`/t` 从 `~/.codex` session index 读取 thread，创建或复用 BridgeSession，并写 `runtime.codex.threadId/title`；cwd 写入对应 Session TOML 的 `session.workspace`。

Codex thread id 是跨 bridge 与 Codex native 的共享身份，所以 `/t archive`、mirror/reuse、UI session 列表都依赖 `BridgeSession.runtime.codex.threadId`。

### Claude Code 上游语义

`feishu-claude-code-bridge` 的 Claude Code 会话模型更简单：

- scope 是 IM 侧会话范围：普通群/私聊用 `chatId`，话题群用 `chatId:threadId`，文档评论用 `doc:<fileToken>`。
- session store 只保存 `{ sessionId, cwd, updatedAt, idleTimeoutMinutes? }`。
- resume 必须同时匹配 `sessionId` 和 `cwd`；如果 cwd 变了，旧 session 会被视为 stale 并清掉。
- workspace/cwd 独立存储，`/cd` 或 `/ws use` 改 cwd 时会清空当前 Claude session。
- `claude -p --output-format stream-json --verbose --resume <sessionId>` 的 `system/init` 事件带 `session_id/cwd/model`；上游收到 `system` 事件后立即持久化 session id。
- 近期 Claude session 列表按 cwd 读取 `~/.claude/projects/<encoded-cwd>/*.jsonl`，session id 来自 jsonl 文件名。

这说明 Claude Code 的核心身份不是 Codex 的 `thread_id`，而是 provider-specific 的 `{sessionId, cwd}` 组合。`cwd` 改变时不能继续 resume；这条约束应该进入 bridge 的 runtime identity 层。

### 对现有 BridgeSession 的结论

Codex 与 ClaudeCode 可以共享：

- `BridgeSession.id/name/session_type/hidden/parent_session_id/expires_at`。
- `ChannelChat -> BridgeSession` 绑定模型、`systemPrompt` 和运行身份字段。
- 本地消息历史、运行队列、健康状态、权限回调和通道发送能力。

不能共享为同一字段：

- `runtime.codex.threadId` 与 Claude `sessionId`。前者可跨 Codex native index 查找和归档，后者必须绑定 cwd 才可 resume。
- `runtime.codex.model` 与 `runtime.claude.model`。Codex 与 Claude 的模型名空间不同，只能 fallback 到各自 runtime 默认值。
- `runtime.codex.provider`。它是 Codex SDK/pty/tmux transport 配置，运行时读取 scoped TOML，不再读取 BridgeSession JSON 同名字段。
- `runtime.codex.sandboxMode/networkAccess/reasoningEffort`。Claude 需要自己的 permission/thinking/timeout 配置。

当前 `BridgeSession` 权威存储结构：

```ts
interface BridgeSessionRuntimeState {
  activeRuntime?: 'codex' | 'claude';
  codex?: {
    threadId?: string;
    title?: string;
  };
  claude?: {
    sessionId?: string;
    cwd?: string;
  };
  general?: {
    systemPrompt?: string;
    // Provider runtime identity, not user tmux config.
    tmuxSessionName?: string;
  };
}
```

启动迁移会把旧 `model/preferred_mode/codex_thread_id/codex_title/reasoning_effort/codex_provider/codex_sandbox_mode/codex_network_access/tmux_*` 顶层字段一次性搬到 scoped TOML 或 runtime identity 字段，并从 `sessions.json` 删除旧字段。业务代码中的 `BridgeSession` 类型不再暴露这些旧顶层字段，也不把 BridgeSession JSON 当配置后端。

Accessor 边界：

- `getBridgeSessionCodexThreadId(session)` 读 `runtime.codex.threadId`。
- `setBridgeSessionCodexThreadId(sessionId, threadId)` 写 `runtime.codex.threadId`。
- `resolveCodexRuntimeConfig(session)` 只能读 scoped TOML / v2 ConfigService effective config，以及 Codex thread identity。
- `resolveClaudeRuntimeConfig(session)` 只能读 scoped TOML / v2 ConfigService effective config，以及 Claude session identity。

## 当前优先调整点

- `/provider`、`/p` 从 “CodexRuntime 参数” 移到 “Bridge 控制”，因为它选择 bridge 如何驱动当前 runtime，不是模型执行参数。Codex 支持 `sdk|pty|tmux`，Claude 支持 `pty|sdk`，切换时只修改当前 active runtime 的 provider。
- `/set` 展示与 schema 应拆成 GlobalRuntime(Codex)、GlobalRuntime(Claude)、GlobalBridge，而不是一个扁平配置表。
- `schemas/config.v1.schema.json` 以 `runtime.codex`、`runtime.claude`、`runtime.bridgeControl`、`runtime.bridge` 作为权威分组；旧扁平字段不再作为配置兼容输入。
- `BridgeStore` 接口中的 `findSessionByCodexThreadId()`、`updateSessionCodexThreadId()` 是 Codex 专属 API；接 Claude 前应新增 provider-neutral accessor 或 runtime-specific registry，避免加出 `findSessionByClaudeSessionId()` 这类平行顶层接口。
- Claude Code 接入前，不要把 `BridgeSession.runtime.codex.model` 当通用字段使用；应使用 `runtime.codex.model` 与 `runtime.claude.model` 两个 runtime-specific 字段。

## 真实 E2E 开关

真实 pty e2e 默认跳过，避免常规 `npm test` 依赖本机 CLI 登录状态。

- Codex pty/tmux：设置 `CODELARK_REAL_CODEX_E2E=1`，可选 `CODELARK_REAL_CODEX_E2E_MODEL=<model>`。
- Claude Code pty：设置 `CODELARK_REAL_CLAUDE_E2E=1`，可选 `CODELARK_REAL_CLAUDE_E2E_EXECUTABLE=ccr|claude`、`CODELARK_REAL_CLAUDE_E2E_PROMPT=<prompt>`、`CODELARK_REAL_CLAUDE_E2E_EXPECT=<expected text>`。

Claude Code pty e2e 会按全局 Claude executable 语义启动真实 TUI：`ccr` 对应 `ccr code`，`claude` 对应 `claude`。如果只想验证本地临时 `ccr` 配置，应设置 `/set claudeExecutable ccr` 并将目标会话切到 `/runtime claude`。Claude SDK provider 走 `@anthropic-ai/claude-agent-sdk` 原生事件路径，不使用 pty TUI，也不等同于 `ccr code`。
