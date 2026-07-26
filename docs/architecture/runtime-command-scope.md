# 斜杠命令与运行时/Bridge 配置边界

本文整理当前 IM slash 命令、配置项与 `BridgeSession` 存储边界，作为 Codex、Claude Code 和 Kimi Code 三类 runtime 的收口依据。

当前入口：

- 命令别名：`src/bridge/command/aliases.ts`
- 命令分发：`src/bridge/command/dispatch.ts`
- SessionRuntime 命令：`src/bridge/command/runtime-settings.ts`
- Provider 切换命令：`src/bridge/command/provider-settings.ts`
- Codex thread 预创建：`src/bridge/command/runtime-bootstrap.ts`
- Runtime session helper：`src/bridge/command/runtime-session.ts`
- 命令展示 helper：`src/bridge/command/presentation/`
- GlobalRuntime / Bridge 配置命令：`src/bridge/command/global-settings.ts`
- 配置结构与 env 映射：`src/configuration/schema.ts`、`src/configuration/fields.ts`、`src/runtime/config-projections.ts`
- 配置读取/覆盖：`src/configuration/sources.ts`、`src/configuration/service.ts`
- Legacy 配置 adapter：`src/configuration/legacy.ts` / `legacy-types.ts`，只保留给 migration 和 compatibility 测试，生产代码不直接依赖
- BridgeSession 类型：`src/domain/session.ts / src/runtime/contracts.ts`
- JSON 存储：`src/storage/json-store.ts`

## 收口原则

- 终端工具、运维命令、Bridge 控制命令不写 Runtime 默认值。
- SessionRuntime 命令只写当前 `BridgeSession` 的运行覆盖值。
- GlobalRuntime 命令只写对应 runtime 自己的默认值；Codex、Claude 和 Kimi 的配置不能互相 fallback。
- GlobalBridge 配置只影响 bridge 自身行为，例如工作空间根、UI 服务、通道、消息展示和状态观测。
- provider/thread/session id 这类身份字段属于 runtime-specific identity，不应继续作为通用 `BridgeSession` 顶层字段扩散。

## 命令分组

### 终端工具

这些命令提供远程终端或文件查看能力，属于 bridge 的操作面。它们读取当前 effective `session.workspace`、tmux 行数/输入回显偏好，以及当前 BridgeSession 绑定的 tmux session identity；普通 tmux 文本固定补 Enter，不提供配置开关。偏好来自 scoped TOML，tmux session identity 来自后端会话存储。

| 命令 | 当前职责 | 存储交互 |
| --- | --- | --- |
| `/shell` | 在当前会话目录通过 `codex sandbox` 执行 shell command | 读取 effective `session.workspace`；自己的 sandbox 参数来自命令实现，不写 `/sandbox` 配置 |
| `/tmux*` | 远程控制任意 tmux session，包括 attach/switch/new/status/screen/set | `/tmux-set` 的行数/输入回显写 Session TOML；`/tmux-attach`、`/tmux-new` 和 provider 自动生成的 tmux session name 作为运行身份保留在 BridgeSession JSON |
| `/cat` | 查看当前工作目录下文件内容 | 读取 effective `session.workspace` |
| `/file` | 把本地文件回传到 IM；超过 20 MB 时先确认，确认后由通道后台上传并回链接 | 读取 effective `session.workspace` 和通道发送能力 |

### 运维命令

这些命令观察或修复 bridge 运行状态，不改变 Codex/Claude/Kimi 的模型执行参数。

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
| `/t`、`/thread`、`/threads` | 列表、接管、切换、归档本地 Codex thread、Claude session、Kimi session 和 Bridge session | 写 `ChannelChat.bridgeSessionId`；接管本地 runtime 会话时写对应 `BridgeSession.runtime.codex.threadId/title`、`runtime.claude.sessionId/cwd` 或 `runtime.kimi.sessionId/cwd` |
| `/t rename` | 重命名当前 BridgeSession，部分通道同步群名 | 写 `BridgeSession.name` |
| `/provider`、`/p` | 在当前 runtime 的 provider 间切换；Codex/Claude 支持 `sdk|pty|tmux`，Kimi 当前只支持 `tmux` | 写 Session TOML 的 `runtime.codex.provider` / `runtime.claude.provider` / `runtime.kimi.provider`；tmux 时只把自动生成 tmux session name 和必要的 runtime identity 作为运行身份写 BridgeSession JSON |
| `/stop` | 停止当前运行任务 | 触发 bridge 任务控制；tmux provider 下映射为 tmux interrupt |

### 会话运行时配置

这些命令写当前会话的运行覆盖值。当前通过 `ConfigService` 写 Session TOML，旧 BridgeSession JSON 中的同名 runtime 配置字段只作为 v1 启动迁移输入，不再作为运行时 fallback。

| 命令 | 当前写入字段 | Codex 语义 | 其他 runtime 语义 |
| --- | --- | --- | --- |
| `/runtime` | `runtime.activeRuntime` | `codex` 时普通消息进入 Codex routing provider；`claude` 时普通消息默认进入 Claude Code tmux provider；`kimi` 时普通消息进入 Kimi tmux provider | 切换 runtime 不改变各 runtime 已记住的 `/provider` |
| `/mode`、`/m` | `runtime.codex.mode` / `runtime.claude.yoloMode` | Codex `yolo` 强制 `danger-full-access` 与 `permissionMode=never` | Claude Code 只保留 YOLO 开关，运行时由 `yolo_mode` 推导 CLI/SDK permission 参数 |
| `/reasoning`、`/r` | `runtime.codex.reasoningEffort` | `modelReasoningEffort` | Claude 不应 fallback 到 Codex reasoning；Kimi 的 think 来自 wire mirror 状态区，不写 bridge reasoning 配置 |
| `/sandbox`、`/sb` | `runtime.codex.sandboxMode` | Codex sandbox mode | Claude Code 没有同名 sandbox；不能共用 |
| `/network`、`/net` | `runtime.codex.networkAccess` | Codex network access | Claude Code 网络通常由工具权限/环境决定，不能共用 |
| `/model` | `runtime.<agent>.model` | 当前 runtime 的模型；已有本地 Codex thread 时只允许查看 | Codex/Claude/Kimi 模型名空间分开，不能互相 fallback |

当前有效 Codex runtime 参数由 `resolveSessionRuntimeConfig()` 产出：

| 有效参数 | 当前 fallback | 收口问题 |
| --- | --- | --- |
| `mode` | Session TOML `runtime.codex.yoloMode` -> v2 global `runtime.codex.yoloMode` | Codex 专属；旧 BridgeSession JSON 同名字段只作为迁移输入 |
| `model` | Session TOML `runtime.codex.model` -> v2 global `runtime.codex.model` | Codex/Claude/Kimi 模型名空间分开，不能互相 fallback |
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
  defaultRuntime: 'codex' | 'claude' | 'kimi';
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
    yoloMode?: 'off' | 'on';
    idleTimeoutMinutes?: number;
  };
  kimi: {
    defaultModel?: string;
    provider?: 'tmux';
  };
}
```

当前 key 归属建议：

| 当前 `/set` key | TOML 归属 | 说明 |
| --- | --- | --- |
| `runtime` | `runtime.agent` | 选择新会话默认 agent |
| `defaultModel` | `runtime.codex.model` | Codex 专属 |
| `defaultMode` | `runtime.codex.yolo_mode` | Codex 专属 |
| `codexSkipGitRepoCheck` | `runtime.codex.skip_git_repo_check` | Codex 专属 |
| `codexSandboxMode` | `runtime.codex.sandbox_mode` | Codex 专属 |
| `codexNetworkAccess` | `runtime.codex.network_access` | Codex 专属 |
| `codexReasoningEffort` | `runtime.codex.reasoning_effort` | Codex 专属 |
| `defaultProvider` | `runtime.codex.provider` | `sdk/pty/tmux` 是 Codex provider transport |
| `claudeExecutable` | `runtime.claude.executable` | 只允许 `claude` 或 `ccr`；这是 Claude Code 启动命令，不是 provider |
| `kimiModel` | `runtime.kimi.model` | Kimi Code 专属模型名 |
| `kimiProvider` | `runtime.kimi.provider` | 当前只允许 `tmux` |

### 全局 Bridge 配置

这些配置属于 bridge 自身，不属于任何 runtime 的模型执行参数。

| 配置或命令 | TOML 归属 | 说明 |
| --- | --- | --- |
| `defaultWorkspaceRoot` | `bridge.default_workspace` | 影响 `/new <relative>`，不是 provider 参数 |
| `historyMessageLimit` | `channels[].config.history_message_limit` | 影响 `/history` 展示 |
| `streamStatusIdleStartSeconds` | `channels[].config.stream_status_idle_start_seconds` | 尾栏响应计时显示延迟；默认 0，从任务开始显示 |
| `streamStatusCheckIntervalSeconds` | `channels[].config.stream_status_check_interval_seconds` | 无其他卡片更新时的尾栏刷新间隔；默认 5 秒 |
| `/ui` | 固定显示策略 | 工具详情始终显示 |
| `uiAllowLan`、`uiAccessToken` | `bridge.ui` | UI server |
| Feishu / Weixin channel config | `channels[]` | 通道连接、访问控制、消息呈现 |
| `/require-at` | 当前消息的 `channelType` 对应 `channels[]` 项 | 飞书群聊触发策略；精确修改当前 App/通道实例 |

`/require-at` 与 `/set requireMention` 最终都写 `~/.codelark/config.toml`，但目标选择不同：前者按当前消息的 `channelType` 找到对应 channel id，后者属于全局设置卡，修改默认 Feishu channel。单 App 默认通道中两者效果相同；多 App、隔离测试 App 或非默认 channel 中，使用 `/set requireMention` 可能改到另一项，看起来就像“没有生效”。因此当前聊天的 mention 策略优先使用 `/require-at`，全局默认模板才使用 `/set --group channels.feishu`。运行中的 Bridge 在下一次 channel config sync 后应用变更。

## BridgeSession 与 Codex/ClaudeCode/KimiCode 差异

当前 `BridgeSession` 是 bridge 本地会话容器，已经承担以下通用职责：

- IM chat 的绑定目标：`ChannelChat.bridgeSessionId` 指向它。
- 当前工作目录：effective `session.workspace`，持久化在 scoped TOML。
- 用户可见名称：`name`，以及创建/更新时间。
- 本地消息历史：`data/messages/<sessionId>.json`。
- 运行状态与健康状态：`runtime_status`、`queued_count`、`health_*`、tool/stream/mirror 字段。
- session 生命周期：`session_type`、`hidden`、`parent_session_id`、`expires_at`。

当前 session runtime schema 把 provider-specific 状态放在 `runtime` 容器中：

- `runtime.codex.threadId`：Codex thread/resume identity。
- `runtime.claude.sessionId/cwd`：Claude Code resume identity。
- `runtime.kimi.sessionId/cwd`：Kimi Code resume identity。
- `runtime.codex.title`：从本地 Codex thread 读取的原始标题。
- `runtime.codex.provider`：旧 JSON 中的 Codex transport 选择只作为迁移输入；当前 transport 选择由 scoped TOML `runtime.codex.provider` 表达。
- 旧 `runtime.codex.sandboxMode/networkAccess/reasoningEffort/provider/model/mode`：只作为迁移输入；当前执行参数读取 scoped TOML。
- `runtime.general.tmuxSessionName`：provider 自动生成或 `/tmux-attach`/`/tmux-new` 手动绑定的 tmux session identity，由后端 BridgeSession 存储持久化；不再作为用户 TOML 配置项。

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

Codex、ClaudeCode 与 KimiCode 可以共享：

- `BridgeSession.id/name/session_type/hidden/parent_session_id/expires_at`。
- `ChannelChat -> BridgeSession` 绑定模型、`systemPrompt` 和运行身份字段。
- 本地消息历史、运行队列、健康状态、权限回调和通道发送能力。

不能共享为同一字段：

- `runtime.codex.threadId` 与 Claude `sessionId`。前者可跨 Codex native index 查找和归档，后者必须绑定 cwd 才可 resume。
- `runtime.codex.model`、`runtime.claude.model` 与 `runtime.kimi.model`。Codex、Claude 和 Kimi 的模型名空间不同，只能 fallback 到各自 runtime 默认值。
- `runtime.codex.provider`。它是 Codex SDK/pty/tmux transport 配置，运行时读取 scoped TOML，不再读取 BridgeSession JSON 同名字段。
- `runtime.codex.sandboxMode/networkAccess/reasoningEffort`。Claude 只保留自己的 YOLO、thinking 和 idle timeout 配置；不再暴露独立 `permission_mode` 配置。

当前 `BridgeSession` 权威存储结构：

```ts
interface BridgeSessionRuntimeState {
  activeRuntime?: 'codex' | 'claude' | 'kimi';
  codex?: {
    threadId?: string;
    title?: string;
  };
  claude?: {
    sessionId?: string;
    cwd?: string;
  };
  kimi?: {
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
- `resolveKimiRuntimeConfig(session)` 只能读 scoped TOML / v2 ConfigService effective config，以及 Kimi session identity。

## 当前优先调整点

- `/provider`、`/p` 从 “CodexRuntime 参数” 移到 “Bridge 控制”，因为它选择 bridge 如何驱动当前 runtime，不是模型执行参数。Codex 和 Claude 都支持 `sdk|pty|tmux`，Claude 默认 `tmux`；Kimi 当前只支持 `tmux`。切换时只修改当前 active runtime 的 provider。
- `/set` 展示与写入遵循 TOML section：顶部下拉切换 `[runtime]`、`[runtime.codex]`、`[runtime.claude]`、`[runtime.kimi]`、`[bridge]` 和默认 Feishu `[[channels]]`，表单只保存当前 section。
- `/set --group runtime` 中的 `session.tmux_capture_lines`、`session.tmux_echo_input` 是 home 级“新 session 默认值”。`session.tmux_auto_enter` 只保留为旧配置/内部迁移字段，所有用户入口都不得展示或写入，普通 tmux 文本固定补 Enter。
- `/current` 顶部配置分栏必须把通用 session 设置与 runtime 设置分开：通用分栏严格按“对话名称、工作目录、tmux 输出行数”显示；Codex、Claude、Kimi 分栏只拥有各自 runtime 字段。选择通用分栏不得切换 agent，保存任一分栏不得读取或串写其他分栏的表单键。
- Operator UI 与 `/set` 共享同一配置能力清单：Web 表单提交字段必须与后端 Zod input contract 全等；runtime 默认值和通用 tmux 默认值不得只接一端。App secret、授权状态等敏感或状态型字段可以是显式受控例外，但必须在测试矩阵中说明 owner，不能静默缺失。
- `schemas/config.v2.schema.json` 描述 `config.toml` 解析后的当前结构，以 `runtime.codex`、`runtime.claude`、`runtime.kimi`、`session`、`bridge` 和 `channels` 作为权威分组；旧扁平字段不再作为配置兼容输入。
- `BridgeStore` 接口中的 `findSessionByCodexThreadId()`、`updateSessionCodexThreadId()` 是 Codex 专属 API；接 Claude 前应新增 provider-neutral accessor 或 runtime-specific registry，避免加出 `findSessionByClaudeSessionId()` 这类平行顶层接口。
- 不要把 `BridgeSession.runtime.codex.model` 当通用字段使用；应使用 `runtime.codex.model`、`runtime.claude.model` 与 `runtime.kimi.model` 三个 runtime-specific 字段。

## 真实 E2E 开关

真实 pty/tmux e2e 默认跳过，避免常规 `npm test` 依赖本机 CLI 登录状态。

- Codex pty/tmux：设置 `CODELARK_REAL_CODEX_E2E=1`，可选 `CODELARK_REAL_CODEX_E2E_MODEL=<model>`。
- Claude Code tmux：常规单元/工作流测试 mock tmux 和 Claude JSONL；真实 tmux 验证应在安装 tmux/Claude Code 并登录后手动开启。
- Claude Code pty：设置 `CODELARK_REAL_CLAUDE_E2E=1`，可选 `CODELARK_REAL_CLAUDE_E2E_EXECUTABLE=ccr|claude`、`CODELARK_REAL_CLAUDE_E2E_PROMPT=<prompt>`、`CODELARK_REAL_CLAUDE_E2E_EXPECT=<expected text>`。

Claude Code pty/tmux 会按全局 Claude executable 语义启动真实 TUI：`ccr` 对应 `ccr code`，`claude` 对应 `claude`。如果只想验证本地临时 `ccr` 配置，应设置 `/set claudeExecutable ccr` 并将目标会话切到 `/runtime claude`。Claude SDK provider 走 `@anthropic-ai/claude-agent-sdk` 原生事件路径，不使用 TUI，也不等同于 `ccr code`。
