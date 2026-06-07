# 配置系统现状与 TOML 重构方案

## 目标

CodeLark 需要把“默认值、全局配置、项目配置、环境变量、命令行覆盖、Channel/Session 内持久化覆盖”统一成一套配置系统。重构目标不是只把 `~/.codelark/config.json` 换成 TOML，而是先统一 TOML 文件结构本身：所有持久化配置都使用同一套 TOML shape、来源优先级、查询 API、写入 API、来源解释和 reset 机制。

必须满足：

- 支持命令行覆盖和多级配置，非通道实例字段的基础优先级为 `cli > env > local > home > defaults`。
- 支持 Channel/Session scope 的持久化执行偏好覆盖，例如 `/r` 对当前飞书 Channel 或当前会话 Session 的覆盖；这类持久化配置也应使用 TOML，而不是继续散落在 BridgeSession JSON 中。
- 通道实例清单和通道连接/行为配置只允许出现在 defaults 与 home `config.toml`。`defaults.toml` 仍是 channel 默认值的事实来源；home 中的 `channels` 整组覆盖 defaults，缺省字段由 ConfigService 从 defaults channel 模板补齐并写回 home TOML。local/env/cli/channel/session/request 出现 `channels` 都应校验失败。
- 查询配置时不再在业务代码里手写 override/fallback。
- 全局默认值有清晰收口，能直接看到当前默认配置长什么样；setup wizard 展示和写入的全局配置项也必须从同一个默认配置定义读取。
- 启动时把旧 `config.json` 和 `config.env` 一次性迁移到 `config.toml`；迁移完成后不再支持 `config.env` 作为配置输入。
- 仍然向 daemon/agent/lark-cli 等子进程注入环境变量，但这些环境变量由 `ConfigService.exportProcessEnv()` 从 effective config 生成，不再通过读取或维护 `config.env` 实现。
- 使用合适的第三方库处理 TOML、运行时校验和 CLI 参数解析。

## 当前现状

当前默认配置目录来自 `CODELARK_HOME`，未设置时为 `~/.codelark`。配置逻辑主要分散在：

- `src/configuration/static-loader.ts`：用 `node-config` 解析并合并 defaults/home/local/env/cli 静态 baseline；只返回需要 materialize 的 home patch，不直接写文件。
- `src/configuration/sources.ts`：复用 `node-config` TOML parser 读取 defaults/home/local/channel/session TOML，并提供 `ConfigService` 写入所需的持久化 I/O。
- `src/configuration/service.ts`：`ConfigService` 查询、写入、dynamic overlay、provenance/explain 和 projection 入口。
- `src/configuration/source-values.ts`：封装“只读取某个 source 的显式 override”这种 provenance 判断，业务代码不能各自手写 fallback/source 检查。
- 配置解析库边界：生产代码只有 `src/configuration` 可以直接导入 `node-config` 或 `smol-toml`；业务模块必须通过 `ConfigService`、projection 或迁移 adapter 使用配置。
- `src/local-service/manager.ts` / `src/entrypoints/cli.ts`：CLI `run` 时用同一个 effective config snapshot 同时派生 UI env、Bridge preflight config 和 Bridge env projection，避免一次启动内动态 TOML reload 前后不一致。
- `src/configuration/legacy.ts` / `legacy-types.ts`：仅保留 legacy expanded `Config` adapter 和 migration/compatibility 测试；生产代码不应从这里读取配置。
- `src/operator-ui/application/config.ts` / `channel.ts`：把 UI payload 转成 v2 `ConfigPatch`，通过 `ConfigService` 写回 home TOML。
- `src/bridge/command/global-settings.ts`：`/set` 通过 `ConfigService` 读写 home TOML。
- `src/bridge/command/runtime-settings.ts`：`/r`、`/mode`、`/sandbox`、`/network`、`/model`、`/cd` 等写 Session TOML，不再把同名配置字段写回 BridgeSession JSON。
- `src/domain/session-runtime.ts`：BridgeSession runtime 身份/状态 accessor，以及从 Session TOML 读取显式会话配置 override 的过渡 helper。
- `src/bridge/session/channel-router.ts`：新建 IM draft/visible session 时从 Channel scoped `ConfigService.snapshot()` 读取 runtime、model、mode 和 workspace 默认值。
- `src/bridge/session/support.ts`：基于 `ConfigService.snapshot(channel/session scope)` 解析 effective runtime config；运行时执行和展示路径不再自行拼 session/global fallback，Channel/Session TOML 动态覆盖复用同一套 node-config merge。
- `src/storage/json-store.ts`：BridgeSession JSON 持久化；只保存会话身份、生命周期和运行状态，不再作为用户配置后端。

### 当前来源与存储

| 当前来源或文件 | 当前角色 | 主要问题 |
| --- | --- | --- |
| `~/.codelark/config.toml` | home 全局主配置 | 通道清单只允许在 defaults/home，home partial channel 会 materialize 并写回 |
| `.codelark/config.toml` / `.codelark.toml` | local 项目覆盖 | 不允许定义 `channels` |
| `${CODELARK_HOME}/config/channels/*.toml` | Channel scope 执行偏好 | 不允许定义通道实例清单或飞书凭据 |
| `${CODELARK_HOME}/config/sessions/*.toml` | Session scope 执行偏好 | `/r`、`/mode`、`/model`、`/cd` 等会话覆盖落点 |
| `~/.codelark/config.json` / `config.env` | v1 迁移输入 | 迁移成功后归档，不再作为运行时配置输入 |
| 真实 `process.env.CODELARK_*` | 进程级 env 覆盖 | 只覆盖非 channel 实例字段；旧 env key 由 `env-compat.ts` 兼容并 warning |
| CLI argv | 单次启动覆盖 | `--set path=value` 进入 cli source，不持久化 |
| `data/sessions.json` 中的 `BridgeSession.runtime.*` | 会话身份和运行状态 | 保存 thread id、tmux runtime identity、Claude session id/cwd、health、mirror 等；不保存用户配置 override |

### 当前配置项清单

文档和实现里需要区分两套名字：

- canonical path：TypeScript API、`configFields` key、`ConfigService.get()` 和 explain 使用 camelCase，例如 `runtime.codex.yoloMode`。
- TOML path：文件落盘按 section + snake_case 表达，例如 `runtime.codex.yolo_mode`、`session.tmux_capture_lines`。

| 领域 | canonical path | TOML path | 旧 JSON / session 字段 | 新 env 键 | 兼容旧 env 键 | scoped override |
| --- | --- | --- | --- | --- | --- | --- |
| runtime | `runtime.agent` | `runtime.agent` | `runtime.provider` / `runtime.activeRuntime` | `CODELARK_AGENT` | `CODELARK_RUNTIME` | Session: `runtime.activeRuntime` |
| bridge | `bridge.defaultWorkspace` | `bridge.default_workspace` | `runtime.bridge.defaultWorkspaceRoot` | `CODELARK_DEFAULT_WORKSPACE_ROOT` | - | `session.workspace` 可作为 scoped override |
| bridge | `bridge.uiAllowLan` | `bridge.ui_allow_lan` | `runtime.bridge.uiAllowLan` | `CODELARK_UI_ALLOW_LAN` | - | 否 |
| bridge | `bridge.uiAccessToken` | `bridge.ui_access_token` | `runtime.bridge.uiAccessToken` | `CODELARK_UI_ACCESS_TOKEN` | - | 否 |
| session | `session.workspace` | `session.workspace` | `runtime.general.workingDirectory` | - | - | Local / Channel / Session |
| session | `session.tmuxSessionName` | `session.tmux_session_name` | `runtime.general.tmuxSessionName` | - | - | Session |
| session | `session.tmuxCaptureLines` | `session.tmux_capture_lines` | `runtime.general.captureLines` | - | - | Session |
| session | `session.tmuxAutoEnter` | `session.tmux_auto_enter` | `runtime.general.autoEnter` | - | - | Session |
| session | `session.tmuxEchoInput` | `session.tmux_echo_input` | `runtime.general.echoInput` | - | - | Session |
| codex | `runtime.codex.model` | `runtime.codex.model` | `runtime.codex.defaultModel` / `runtime.codex.model` | `CODELARK_CODEX_MODEL` | `CODELARK_CODEX_DEFAULT_MODEL` | Channel / Session |
| codex | `runtime.codex.yoloMode` | `runtime.codex.yolo_mode` | `runtime.codex.defaultMode` / `runtime.codex.mode` | `CODELARK_CODEX_YOLO_MODE` | `CODELARK_CODEX_DEFAULT_MODE` | Channel / Session |
| codex | `runtime.codex.provider` | `runtime.codex.provider` | `runtime.bridgeControl.defaultCodexProvider` / `runtime.codex.provider` | `CODELARK_CODEX_PROVIDER` | `CODELARK_DEFAULT_CODEX_PROVIDER` | Channel / Session |
| codex | `runtime.codex.skipGitRepoCheck` | `runtime.codex.skip_git_repo_check` | `runtime.codex.skipGitRepoCheck` | `CODELARK_CODEX_SKIP_GIT_REPO_CHECK` | - | 否 |
| codex | `runtime.codex.sandboxMode` | `runtime.codex.sandbox_mode` | `runtime.codex.sandboxMode` | `CODELARK_CODEX_SANDBOX_MODE` | - | Channel / Session |
| codex | `runtime.codex.networkAccess` | `runtime.codex.network_access` | `runtime.codex.networkAccess` | `CODELARK_CODEX_NETWORK_ACCESS` | - | Channel / Session |
| codex | `runtime.codex.reasoningEffort` | `runtime.codex.reasoning_effort` | `runtime.codex.reasoningEffort` | `CODELARK_CODEX_REASONING_EFFORT` | - | Channel / Session，由 `/r` 写入 |
| claude | `runtime.claude.model` | `runtime.claude.model` | `runtime.claude.defaultModel` / `runtime.claude.model` | `CODELARK_CLAUDE_MODEL` | `CODELARK_CLAUDE_DEFAULT_MODEL` | Channel / Session |
| claude | `runtime.claude.yoloMode` | `runtime.claude.yolo_mode` | derived from `runtime.claude.permissionMode` for yolo compatibility | `CODELARK_CLAUDE_YOLO_MODE` | - | Channel / Session |
| claude | `runtime.claude.permissionMode` | `runtime.claude.permission_mode` | `runtime.claude.permissionMode` | `CODELARK_CLAUDE_PERMISSION_MODE` | - | Channel / Session |
| claude | `runtime.claude.provider` | `runtime.claude.provider` | `runtime.claude.provider` | `CODELARK_CLAUDE_PROVIDER` | - | Channel / Session |
| claude | `runtime.claude.executable` | `runtime.claude.executable` | `runtime.claude.executable` | `CODELARK_CLAUDE_EXECUTABLE` | - | 否 |
| claude | `runtime.claude.reasoningEffort` | `runtime.claude.reasoning_effort` | `runtime.claude.reasoningEffort` | `CODELARK_CLAUDE_REASONING_EFFORT` | - | Channel / Session，由 `/r` 写入 |
| claude | `runtime.claude.idleTimeoutMinutes` | `runtime.claude.idle_timeout_minutes` | `runtime.claude.idleTimeoutMinutes` | `CODELARK_CLAUDE_IDLE_TIMEOUT_MINUTES` | - | 可考虑 Session |
| channel | `channels[].enabled` | `channels[].enabled` | derived from `channels[].enabled` | `CODELARK_ENABLED_CHANNELS` export only | - | Home only |
| channel | `channels[].config.historyMessageLimit` | `channels[].config.history_message_limit` | `runtime.bridge.historyMessageLimit` | `CODELARK_HISTORY_MESSAGE_LIMIT` export only | - | Home only |
| channel | `channels[].config.streamStatusIdleStartSeconds` | `channels[].config.stream_status_idle_start_seconds` | `runtime.bridge.streamStatusIdleStartSeconds` | `CODELARK_STREAM_STATUS_IDLE_START_SECONDS` export only | - | Home only |
| channel | `channels[].config.streamStatusCheckIntervalSeconds` | `channels[].config.stream_status_check_interval_seconds` | `runtime.bridge.streamStatusCheckIntervalSeconds` | `CODELARK_STREAM_STATUS_CHECK_INTERVAL_SECONDS` export only | - | Home only |
| feishu | `channels[].config.appId` | `channels[].config.app_id` | `channels[].config.appId` | `CODELARK_FEISHU_APP_ID` export only | - | Home only |
| feishu | `channels[].config.appSecret` | `channels[].config.app_secret` | `channels[].config.appSecret` | `CODELARK_FEISHU_APP_SECRET` export only | - | Home only |
| feishu | `channels[].config.site` | `channels[].config.site` | `channels[].config.site` | `CODELARK_FEISHU_SITE` export only | `CODELARK_FEISHU_DOMAIN` migration only | Home only |
| feishu | `channels[].config.allowedUsers` | `channels[].config.allowed_users` | `channels[].config.allowedUsers` | `CODELARK_FEISHU_ALLOWED_USERS` export only | - | Home only |
| feishu | `channels[].config.streamingEnabled` | `channels[].config.streaming_enabled` | `channels[].config.streamingEnabled` | `CODELARK_FEISHU_STREAMING_ENABLED` export only | - | Home only |
| feishu | `channels[].config.feedbackMarkdownEnabled` | `channels[].config.feedback_markdown_enabled` | `channels[].config.feedbackMarkdownEnabled` | `CODELARK_FEISHU_COMMAND_MARKDOWN_ENABLED` export only | - | Home only |
| feishu | `channels[].config.requireMention` | `channels[].config.require_mention` | `channels[].config.requireMention` | `CODELARK_FEISHU_REQUIRE_MENTION` export only | - | Home only |

### 当前主要问题

1. 旧 `config.json` / `config.env` 已降级为迁移输入，但迁移 E2E 和 compatibility adapter 仍需保留，防止破坏旧用户配置升级路径。
2. `bridge_default_provider_id`、`bridge_feishu_group_policy`、`bridge_feishu_group_allow_from`、`bridge_auto_start` 尚无 v2 字段或明确归属，属于需要产品确认的新语义，不能擅自迁移；边界测试只允许这些 legacy settings 继续作为待决 holdout。
3. 部分调用方仍通过短生命周期 `createConfigService({ migrate: false })` 读取动态配置；这保持了动态 reload，但后续可以考虑在应用层注入同一个 service 实例，减少重复构造。
4. `JsonFileStore` 仍保留 legacy runtime settings projection 给旧内部接口和子进程 env 使用；这些 settings 现在是 projection 输出，不应再作为配置输入。

## 推荐模型

### 核心原则

1. 所有持久化配置都使用 TOML。
2. BridgeSession JSON 不再作为配置存储后端，只保存身份、生命周期、状态和索引引用。
3. 配置系统按 scope/source 合并，而不是按“全局配置 vs session JSON”分裂。
4. latest `configFields` 是当前配置项的唯一事实来源：canonical path、TOML path、env key、CLI option、命令别名、校验规则、scope、secret 和 projection 元数据都在这里声明；历史字段解释只放在 migration 文件里。
5. 业务代码只能通过 `ConfigService` 读写配置，不直接拼 fallback，也不直接改 BridgeSession runtime config 字段。
6. setup wizard、默认 TOML、UI 全局配置页和 `/set` 全局配置列表共享同一份 latest `configFields` / defaults，不允许各自维护字段清单或默认值。

命名规则：

- canonical path、TOML 字段和新 env 键默认使用新语义名，例如 `runtime.codex.model`、`runtime.codex.yoloMode`、`CODELARK_CODEX_MODEL`。
- 旧 JSON path、旧 env 键只作为迁移和兼容 alias，例如 `runtime.codex.defaultModel`、`CODELARK_CODEX_DEFAULT_MODEL`。
- 兼容 alias 的优先级低于新名字；如果新旧 env 同时存在，使用新 env，并记录 warning，提示旧 env 已弃用。
- 对外文档、默认 TOML、CLI help、UI 字段名只展示新名字；旧名字只出现在 migration/compatibility 说明中。

TOML shape 边界：

- root 只放 `schema_version` 这类文件级元数据；不放 `workspace`、`tmux_session_name` 等会话字段。
- `[session]` 放和当前对话执行上下文相关的配置：`workspace`、`tmux_session_name`、`tmux_capture_lines`、`tmux_auto_enter`、`tmux_echo_input`。
- `tmux_session_name` 只表示用户显式配置的 tmux 绑定目标；provider 自动生成的 tmux session id 仍是运行时身份，不进入配置 merge。
- `[bridge]` 放 Bridge 服务自身行为配置，例如默认工作区和 UI 访问控制。
- `[channels.config]` 放通道连接信息和通道行为配置，例如飞书 App 凭据、历史消息窗口和流式状态节奏；只允许在 defaults/home `channels` 中出现。
- `[runtime]` 放当前 runtime 选择；`[runtime.codex]`、`[runtime.claude]` 放 provider-specific 配置。
- `[[channels]]` 放通道实例配置；home `channels` 是通道清单，整组覆盖 defaults。home 中的 partial channel 会在读取时用 `defaults.toml` 中的 channel 模板补齐并写回；Channel/Session scope 文件不能包含 `[[channels]]`，只能保存执行偏好字段。

### 目标文件布局

```text
src/configuration/
  defaults.toml              # 产品默认配置，唯一默认值入口
  schema.ts                  # 当前 TOML shape 的 zod 校验、类型、coerce、默认值校验
  fields.ts                  # latest configFields；只服务当前运行时
  fields-types.ts            # ConfigFields / ConfigField 类型定义
  channel-types.ts           # Channel/Feishu 运行时配置类型和站点解析工具
  runtime-types.ts           # Codex/Claude runtime 配置类型和轻量 normalizer
  paths.ts                   # CODELARK_HOME、默认工作区和 home path 展开工具；不暴露 legacy 输入文件名
  static-loader.ts           # node-config 静态 baseline：defaults/home/local/env/cli
  sources.ts                 # 路径解析、Channel/Session TOML 读写和持久化写入
  merge.ts                   # node-config effective merge + provenance/write patch helpers
  service.ts                 # ConfigService 查询和写入 API
  source-values.ts           # 按 source 读取显式 override，避免业务代码手写 provenance fallback
  env-compat.ts              # 真实 process.env 的旧 env alias 兼容读取和 warning
  projections.ts             # runtime settings、UI payload、lark-cli projection
  legacy.ts                  # legacy Config adapter 和 runtime settings projection compatibility
  legacy-types.ts            # legacy Config 类型，仅供 migration/compatibility 测试
  migrations/
    index.ts                 # migration registry 和 runner
    types.ts                 # MigrationContext / ConfigMigration 定义
    v1.ts                    # v1 -> v2：内含 legacy field snapshot + 跨格式 adapter
    v2.ts                    # v2 -> v3：未来新增
    legacy/
      env-file.ts            # config.env parser，仅供 v1 migration 使用
      paths.ts               # config.env/config.json legacy 输入路径，仅供 migration/tests 使用
      session-json.ts        # BridgeSession JSON parser，仅供 v1 migration 使用
```

### 目标配置来源

| Source | Backend | 示例路径 | 持久化 | 适用范围 |
| --- | --- | --- | --- | --- |
| defaults | TOML | `src/configuration/defaults.toml` | 是，随包发布 | 产品默认值 |
| home | TOML | `${CODELARK_HOME:-~/.codelark}/config.toml` | 是 | 本机全局默认 |
| local | TOML | `.codelark/config.toml` 或 `.codelark.toml` | 是 | 当前项目/目录 |
| channel | TOML | `${CODELARK_HOME}/config/channels/<channel-id>.toml` | 是 | 某个飞书 Channel 的持久化执行偏好，不允许包含 `channels` |
| session | TOML | `${CODELARK_HOME}/config/sessions/<session-id>.toml` | 是 | 当前对话 Session 的持久化 override |
| env | env | `process.env.CODELARK_*` | 否 | 当前进程 |
| cli | argv | `codelark run --set ...` | 否 | 单次 CLI 命令 |
| request | in-memory patch | 单次消息或命令参数 | 否 | 单次执行 |

优先级：

```text
Global effective config:
  cli > env > local > home > defaults

Channel effective config:
  request > channel > cli > env > local > home > defaults

Session effective config:
  request > session > channel > cli > env > local > home > defaults
```

`channels` 是例外：只读取 defaults 和 home，且 home 整组覆盖 defaults。home partial channel 只允许通过 ConfigService 从 `defaults.toml` 模板 materialize 并写回，不通过 source-chain 做 `channels[]` 跨层按 id merge。local/env/cli/channel/session/request 不能定义 `channels`。

说明：

- `Global` 表达本机默认值，包含 defaults/home/env/cli。
- `Local` 表达当前项目/目录默认值，来自 `ConfigServiceOptions.cwd` 对应目录下的 `.codelark/config.toml` 或 `.codelark.toml`；未显式传 `cwd` 时使用服务创建时的 `process.cwd()`，覆盖 home，低于 env/cli。
- `Channel` 表达当前飞书 Channel 的执行偏好，默认作用于当前消息所在的 Channel；它不表达通道实例清单或飞书 App 凭据。
- `Session` 表达当前对话 Session 的偏好，切到新 Session 后不继承，除非显式复制。
- `/r high` 这类一参数命令默认写 Channel；`/r high session` 才写当前 Session；`/r high global` 写 Global。
- `/model` 如果只影响当前对话，命令应显式使用 Session scope；否则一参数默认写 Channel。
- `/cd` 需要按命令语义拆分：设置 Channel 默认工作区时写 Channel；设置当前 Session cwd identity 时写 Session。

### v2 完整 TOML shape

`defaults.toml` 必须完整展示下面这套 shape；home 可以保存完整 `channels` 清单并覆盖 defaults，local、Channel、Session TOML 使用同一套 shape 的非 `channels` partial，只写需要覆盖的执行偏好字段。所有已知配置项和 v1 需要迁移的配置字段都必须落到这个 shape 中，不能再出现另一套顶级 `workspace`、`tmux_session_name` 或 `runtime.general.*` TOML 结构。

```toml
schema_version = 2

[session]
workspace = "~"
tmux_session_name = ""
tmux_capture_lines = 80
tmux_auto_enter = true
tmux_echo_input = false

[runtime]
agent = "codex"

[bridge]
default_workspace = "~"
ui_allow_lan = false
ui_access_token = ""

[runtime.codex]
model = ""
yolo_mode = "off"
provider = ""
skip_git_repo_check = true
sandbox_mode = "workspace-write"
network_access = true
reasoning_effort = "medium"

[runtime.claude]
model = ""
yolo_mode = "off"
permission_mode = "default"
provider = "sdk"
executable = "claude"
reasoning_effort = "medium"
idle_timeout_minutes = 0

[[channels]]
id = "feishu-default"
alias = "飞书"
provider = "feishu"
enabled = false

[channels.config]
history_message_limit = 8
stream_status_idle_start_seconds = 180
stream_status_check_interval_seconds = 10
app_id = ""
app_secret = ""
site = "feishu"
allowed_users = []
streaming_enabled = true
feedback_markdown_enabled = true
require_mention = false
```

迁移落点以这套 shape 为准：

| v2 TOML path | 旧持久化字段 | 旧 env 输入 |
| --- | --- | --- |
| `session.workspace` | `runtime.general.workingDirectory` | - |
| `session.tmux_session_name` | `runtime.general.tmuxSessionName` | - |
| `session.tmux_capture_lines` | `runtime.general.captureLines` | - |
| `session.tmux_auto_enter` | `runtime.general.autoEnter` | - |
| `session.tmux_echo_input` | `runtime.general.echoInput` | - |
| `runtime.agent` | `runtime.provider`、`runtime.activeRuntime` | `CODELARK_RUNTIME` |
| `bridge.default_workspace` | `runtime.bridge.defaultWorkspaceRoot` | `CODELARK_DEFAULT_WORKSPACE_ROOT` |
| `bridge.ui_allow_lan` | `runtime.bridge.uiAllowLan` | `CODELARK_UI_ALLOW_LAN` |
| `bridge.ui_access_token` | `runtime.bridge.uiAccessToken` | `CODELARK_UI_ACCESS_TOKEN` |
| `runtime.codex.model` | `runtime.codex.defaultModel`、`runtime.codex.model` | `CODELARK_CODEX_MODEL`，兼容 `CODELARK_CODEX_DEFAULT_MODEL` |
| `runtime.codex.yolo_mode` | `runtime.codex.defaultMode`、`runtime.codex.mode` | `CODELARK_CODEX_YOLO_MODE`，兼容 `CODELARK_CODEX_DEFAULT_MODE` |
| `runtime.codex.provider` | `runtime.bridgeControl.defaultCodexProvider`、`runtime.codex.provider` | `CODELARK_CODEX_PROVIDER`，兼容 `CODELARK_DEFAULT_CODEX_PROVIDER` |
| `runtime.codex.skip_git_repo_check` | `runtime.codex.skipGitRepoCheck` | `CODELARK_CODEX_SKIP_GIT_REPO_CHECK` |
| `runtime.codex.sandbox_mode` | `runtime.codex.sandboxMode` | `CODELARK_CODEX_SANDBOX_MODE` |
| `runtime.codex.network_access` | `runtime.codex.networkAccess` | `CODELARK_CODEX_NETWORK_ACCESS` |
| `runtime.codex.reasoning_effort` | `runtime.codex.reasoningEffort` | `CODELARK_CODEX_REASONING_EFFORT` |
| `runtime.claude.model` | `runtime.claude.defaultModel`、`runtime.claude.model` | `CODELARK_CLAUDE_MODEL`，兼容 `CODELARK_CLAUDE_DEFAULT_MODEL` |
| `runtime.claude.yolo_mode` | 由 `runtime.claude.permissionMode` 派生的 yolo 兼容值 | `CODELARK_CLAUDE_YOLO_MODE` |
| `runtime.claude.permission_mode` | `runtime.claude.permissionMode` | `CODELARK_CLAUDE_PERMISSION_MODE` |
| `runtime.claude.provider` | `runtime.claude.provider` | `CODELARK_CLAUDE_PROVIDER` |
| `runtime.claude.executable` | `runtime.claude.executable` | `CODELARK_CLAUDE_EXECUTABLE` |
| `runtime.claude.reasoning_effort` | `runtime.claude.reasoningEffort` | `CODELARK_CLAUDE_REASONING_EFFORT` |
| `runtime.claude.idle_timeout_minutes` | `runtime.claude.idleTimeoutMinutes` | `CODELARK_CLAUDE_IDLE_TIMEOUT_MINUTES` |
| `channels[].enabled` | `channels[].enabled`、旧 `enabledChannels` 派生 | `CODELARK_ENABLED_CHANNELS` |
| `channels[].config.history_message_limit` | `runtime.bridge.historyMessageLimit` | `CODELARK_HISTORY_MESSAGE_LIMIT` |
| `channels[].config.stream_status_idle_start_seconds` | `runtime.bridge.streamStatusIdleStartSeconds` | `CODELARK_STREAM_STATUS_IDLE_START_SECONDS` |
| `channels[].config.stream_status_check_interval_seconds` | `runtime.bridge.streamStatusCheckIntervalSeconds` | `CODELARK_STREAM_STATUS_CHECK_INTERVAL_SECONDS` |
| `channels[].config.app_id` | `channels[].config.appId` | `CODELARK_FEISHU_APP_ID` |
| `channels[].config.app_secret` | `channels[].config.appSecret` | `CODELARK_FEISHU_APP_SECRET` |
| `channels[].config.site` | `channels[].config.site` | `CODELARK_FEISHU_SITE`，兼容 `CODELARK_FEISHU_DOMAIN` |
| `channels[].config.allowed_users` | `channels[].config.allowedUsers` | `CODELARK_FEISHU_ALLOWED_USERS` |
| `channels[].config.streaming_enabled` | `channels[].config.streamingEnabled` | `CODELARK_FEISHU_STREAMING_ENABLED` |
| `channels[].config.feedback_markdown_enabled` | `channels[].config.feedbackMarkdownEnabled` | `CODELARK_FEISHU_COMMAND_MARKDOWN_ENABLED` |
| `channels[].config.require_mention` | `channels[].config.requireMention` | `CODELARK_FEISHU_REQUIRE_MENTION` |

`[channels.config]` 是最近一个 `[[channels]]` array item 的子表；通道 `id` 应在同一个文件内唯一。不同 source 之间不再按 `id` 合并通道，home `channels` 直接替换 defaults `channels`；缺省字段由 ConfigService 读取 `defaults.toml` 的模板补齐并写回 home TOML。

命令行覆盖只接受 canonical path，最终也落到上面这套 TOML path；CLI 本身不定义另一套字段名。

### 合并规则

| 类型 | 规则 |
| --- | --- |
| scalar | 高优先级非空值覆盖低优先级值；允许清空的字段使用 TOML `null` 或 CLI `--unset path` |
| object | deep merge |
| arrays of channels | 只允许 defaults/home；home 整组覆盖 defaults，不参与 local/env/cli/channel/session/request 合并；home partial channel 由 defaults TOML 模板 materialize 后写回 |
| `enabledChannels` | 不再作为主字段；由 `channels[].enabled` 派生 |
| secret | 存储原值，诊断和 UI provenance 默认 mask |
| path | `~` 和相对路径按 source base 归一化：home 相对 CODELARK_HOME，Local 相对配置文件目录，Channel/Session 相对配置文件目录或工作区 |
| identity fields | Codex thread id、Claude session id、run status、health、mirror 等不进入配置 merge |

## configFields 与迁移字段快照

运行时代码只保留一份 latest `configFields`。它描述当前版本的配置字段，服务 `ConfigService`、setup wizard、UI、CLI、IM 命令、env overlay、projection 和 explain。

历史版本字段解释只存在于 migration 中。否则常规配置模块会背上所有历史格式包袱，也容易让业务代码误用旧字段定义。migration 如果需要解释旧版本字段，应该在对应脚本里定义 migration-local field snapshot / adapter。

对应到上面的目标文件布局：

- `fields.ts` 描述当前版本 TOML 字段、Global/Local/Channel/Session scopes、新 env 键和命令写入规则。
- `env-compat.ts` 只处理真实 `process.env` 中旧 env 键到新 env 键的运行时兼容和 warning，不读取 `config.env` 文件。
- `migrations/v1.ts` 自己描述 v1 legacy 字段如何解释，并定义 v1 JSON / `config.env` / BridgeSession JSON 到 v2 TOML 的跨格式映射。
- 后续 v2 -> v3 时新增 `migrations/v2.ts`。如果它需要解释 v2 旧字段，就在 `migrations/v2.ts` 内冻结 v2 field snapshot，不在常规 `fields.ts` 旁边新增 `fields/v2.ts`。

关键边界：

- latest `configFields` 是当前运行时配置字段定义，不是所有历史格式的全局兼容表。
- runtime env alias compatibility 是 `env-compat.ts` 的 adapter，不是 `configFields` 元数据；`configFields` 只声明新 env 键。
- migration-local field snapshot 和 legacy parser 是迁移脚本的私有输入解释器，不对业务代码导出。
- v1 -> v2 比较特殊：它跨越 `config.json`、`config.env`、BridgeSession JSON 和 v2 TOML，文件格式、命名规则、scope 语义都变了。这些跨格式知识必须写在 `migrations/v1.ts` 的 migration adapter 中，不能沉淀成 latest `configFields` 的 `legacyConfigPath`、`legacySessionPath` 等通用属性。
- v2 以后如果都是 TOML shape 演进，migration 可以在脚本内冻结 source/target 字段快照做 rename、scope 拆分和默认值变更；但这些快照仍只属于对应 migration 文件。

`scopes` 的意义不是“字段来源优先级”，而是字段允许出现和允许写入的位置：

- `home`：这个字段能否写入 Global TOML。
- `local`：这个字段能否写入 Local TOML。
- `channel`：这个字段能否写入 Channel TOML。
- `session`：这个字段能否写入 Session TOML。
- `env` / `cli`：这个字段能否被环境变量或命令行覆盖。

`scopes` 用于校验、写入路由、UI/命令展示和 explain。它防止把不该出现在某层的字段写进去，例如 `channels` 只能写 home，不能写入 Local/Channel/Session TOML 或 env/CLI/request；Session-only 的 tmux/cwd 状态不应写入 Global/Local TOML。优先级仍由 source chain 决定，例如 `request > session > channel > cli > env > local > home > defaults`，但 `channels` 只有 `home > defaults`。换句话说，`scopes` 回答“这个字段能在哪里出现”，source chain 回答“多个来源同时出现时谁赢”。

latest `configFields` 应描述全局默认、env/CLI、IM 命令、Channel/Session scope、secret 和 projection 元数据；迁移来源不放在通用字段定义里。它至少承载：

- canonical path。
- TOML path。
- 字段允许的 scopes：home、local、channel、session、env、cli。
- 新 env key 和 parse 函数；旧 env alias 由 `env-compat.ts` 处理。
- CLI option 和 parse 函数。
- IM command alias 和默认写入 scope。
- zod 校验规则。
- 默认值是否可见、是否 secret。
- 导出给 legacy `JsonFileStore` / 子进程 env 的 key。

这样新增当前字段只需要改 defaults、校验规则和 latest `configFields`，不需要同步改 env overlay、UI merge、`/set`、`/r`、runtime resolver、settings export 等多处逻辑；历史字段解释和跨格式映射只存在于对应 migration。

## 配置命令体系

IM 配置命令按 `Global / Local / Channel / Session` 四层组织：

| Scope | 含义 | 默认写入位置 | 示例 |
| --- | --- | --- | --- |
| Global | 本机默认配置 | home TOML，由 `/set` 或 CLI 管理 | `/set runtime.codex.model gpt-5.1` |
| Local | 当前项目/目录默认配置 | `.codelark/config.toml` 或 `.codelark.toml` | `/set --local runtime.codex.provider tmux` |
| Channel | 当前飞书 Channel 的默认偏好 | `config/channels/<channel-id>.toml` | `/r high` |
| Session | 当前对话 Session 的临时/持续偏好 | `config/sessions/<session-id>.toml` | `/r high session` |

命令参数规则：

- 不加参数：只展示当前有效值、来源和用法，不修改配置。
- 一个参数：默认写 Channel scope。例如 `/r high` 写当前飞书 Channel 的 `runtime.codex.reasoningEffort=high`。
- 两个参数：第二个参数指定作用范围，允许 `global`、`local`、`channel`、`session`。例如 `/r high session` 只写当前 Session，`/r high local` 写当前项目 Local TOML，`/r high global` 写 Global。
- `--local`：对 `/set` 这类全局配置命令显式选择 Local 写入目标；不带 `--local` 时 `/set` 写 home TOML。
- `default` / `reset`：按指定 scope 删除该层覆盖值，让配置回落到下一层 source。
- 命令返回必须包含最终值和来源，例如 `reasoning_effort=high source=channel file=...`。

`/r`、`/model`、`/mode`、`/sandbox`、`/network`、`/cd` 等命令都按上述规则解析目标 scope；命令实现不能各自定义一套字段名或 TOML shape。

## 查询与写入 API

业务代码只依赖 `ConfigService`，不直接拼默认值，也不直接改 BridgeSession runtime config 字段。

```ts
type ConfigScope =
  | { kind: 'global'; cwd?: string }
  | { kind: 'local'; cwd: string }
  | { kind: 'channel'; channelId: string; provider: 'feishu'; cwd?: string }
  | { kind: 'session'; sessionId: string; channelId?: string; provider?: 'feishu'; cwd?: string };

type ConfigWriteTarget =
  | { kind: 'home' }
  | { kind: 'local'; cwd: string }
  | { kind: 'channel'; channelId: string; provider: 'feishu' }
  | { kind: 'session'; sessionId: string };

interface ConfigService {
  snapshot(scope?: ConfigScope, request?: ConfigPatch): EffectiveConfig;
  get<TPath extends ConfigPath>(
    path: TPath,
    scope?: ConfigScope,
    request?: ConfigPatch,
  ): ConfigValue<TPath>;
  resolve<TPath extends ConfigPath>(path: TPath, scope?: ConfigScope, request?: ConfigPatch): {
    value: ConfigValue<TPath>;
    source: 'defaults' | 'home' | 'local' | 'env' | 'cli' | 'channel' | 'session' | 'request';
    file?: string;
    env?: string;
    cli?: string;
    scope?: ConfigScope;
  };
  explain(path?: ConfigPath, scope?: ConfigScope): ConfigExplain[];
  set(target: ConfigWriteTarget, patch: ConfigPatch): void;
  unset(target: ConfigWriteTarget, path: ConfigPath): void;
  exportRuntimeSettings(scope?: ConfigScope): Map<string, string>;
  exportProcessEnv(scope?: ConfigScope): NodeJS.ProcessEnv;
}
```

读操作使用 `ConfigScope`，写操作使用 `ConfigWriteTarget`。这两个类型故意分开：`global` 是读取本机默认 effective config 的 scope；`local` 是带 cwd 的项目 effective config；写 Global/Local 时必须选择 `home` 或 `local`，因此 `/set` 默认写 `{ kind: 'home' }`，`/set --local` 写 `{ kind: 'local', cwd }`。

`/r high` 的 explain 应能显示：

```text
runtime.codex.reasoningEffort = high
source = channel | session
file = ~/.codelark/config/channels/feishu-default.toml
fallback = runtime.codex.reasoningEffort from cli/env/local/home/defaults
```

## 第三方库选择

| 库 | 用途 | 原因 |
| --- | --- | --- |
| `config` / `node-config` | 纯静态全局配置读取和基础层次合并 | 适合承接 defaults、home、local/project、env、CLI baseline 这类“启动时静态配置”层，减少 CodeLark 自己维护通用 source chain 的范围 |
| `smol-toml` | TOML parse/stringify | 仍用于 Channel/Session/request 等 CodeLark 专用 TOML 读写，以及 migration 中需要精确控制的 TOML I/O |
| `zod` | 校验规则、默认值、coerce、类型推导 | 把运行时校验和 TS 类型放在同一处，替代手写 normalize 分支 |
| `commander` | CLI command/options 解析 | 当前 CLI 是手写解析；commander 适合给 `run/start/setup` 增加 typed options、help 和 negated boolean |

### 通用配置库调研结论

2026-06-07 重新评估 `node-config`、`wild-config`、`auto-config-loader` 后，结论不是“完全不用通用配置库”，而是做分层采用：

- 静态全局配置层采用 `node-config`：`defaults + home + local/project + env + CLI baseline` 交给成熟库做加载和基础 merge。实现上使用 `config/lib/util` 的 `Load`，按 CodeLark 已解析出的 `CODELARK_HOME` 和 `cwd` 动态路径装载/合并 TOML shape，避免依赖全局 singleton 或污染 `process.env`。其中 `CODELARK_FEISHU_*` / `CODELARK_ENABLED_CHANNELS` 等 channel env 是 projection-only：运行时配置输入忽略它们并给出 warning，真正的 channel 配置只来自 defaults/home TOML 或 v1 migration。
- Channel/Session/request 动态 overlay 也复用同一个 `Load.addConfig()` 合并入口：`ConfigService` 负责选择哪些 scoped TOML/request patch 参与本次 snapshot、执行 home materialize 写回，并保留字段级 provenance/explain。
- CodeLark 产品语义仍保留在 `ConfigService`：source 选择、scope 写入约束、迁移、secret mask、`channels` home-only 校验与 materialized 写入、runtime env/settings projection。
- 也就是说，`node-config` 替代的是通用的 TOML shape 解析和覆盖合并；`ConfigService` 保留的是 CodeLark 的产品边界、动态 source 选择、写回和 explain/projection 语义。

| 库 | 能覆盖的部分 | 不能满足的核心需求 |
| --- | --- | --- |
| `config` / `node-config` | defaults、home/local/project、env、CLI baseline 的静态分层加载和基础 merge；可通过 `Load` 对不同 CODELARK_HOME/cwd 动态创建独立 loader；也可对 ConfigService 选择出的 channel/session/request patch 做同一套 in-memory merge | 不直接承担 source 选择、scope 写入约束、migration state、secret mask、`channels` home-only policy 和 runtime projection；这些仍由 `ConfigService` 包装实现。字段级 provenance 由 ConfigService 基于 node-config source 输入保留。 |
| `wild-config` | TOML 默认文件、自定义 config 文件、命令行 dotted override | 更像进程启动时的静态配置合并；不能表达 Channel/Session scope 的动态读写、按字段 explain、home/channel/session TOML 的 replace/unset 写入。 |
| `auto-config-loader` | package.json/rc/多格式配置文件查找与加载 | 主要解决“从哪里找配置文件”和“支持哪些格式”；不负责 CodeLark 需要的字段 schema、source priority、provenance、scoped write policy、migration state 或 runtime settings/env projection。 |

因此实现方向调整为 hybrid：引入 `node-config`，让它负责通用 TOML shape 解析和 source patch 覆盖合并；再把输出交给 `zod` 校验并进入 `ConfigService`。`ConfigService` 的手写范围应缩小到 CodeLark 特有的 source 选择、provenance、写入约束、迁移和 projection。未来只有当产品需要 package.json/rc 搜索或多文件格式 local config 时，才考虑把 `auto-config-loader` 放到 local source 的文件发现层，而不是替代 `ConfigService`。

不建议首版引入 `cosmiconfig` 作为核心读取器。CodeLark 的优先级和 scope 是产品语义明确的 source chain，而不是通用 JS tooling 的 package.json/rc 搜索模型；local 查找自己实现更容易解释。若未来需要支持 `package.json#codelark` 或多文件格式，再评估 `cosmiconfig`。

## 迁移路径

迁移不是一次性脚本，而是长期版本化基础设施。之后每次配置结构升级都必须新增一条 migration，并在启动时按顺序执行，不能把迁移逻辑散落在 `loadConfig()` 或业务路径里。

### 迁移脚本布局

迁移脚本使用前文目标文件布局里的 `src/configuration/migrations/` 目录。迁移文件按“源配置版本”命名：`v1.ts` 表示把 v1 数据迁移到 v2；后续如果 v2 要升级到 v3，新增 `v2.ts`。同一个版本升级内的多个动作不要拆成多个 migration 文件，而是在一个版本文件里按步骤组织，避免一次升级散落成许多小脚本。

运行状态写在：

```text
${CODELARK_HOME}/runtime/config-migrations.json
```

示例：

```json
{
  "schemaVersion": 1,
  "applied": [
    {
      "id": "v1",
      "appliedAt": "2026-06-06T12:00:00.000Z",
      "fromVersion": 1,
      "toVersion": 2
    }
  ]
}
```

### Migration 接口

```ts
interface ConfigMigration {
  id: `v${number}`;
  description: string;
  fromVersion: number;
  toVersion: number;
  detect(context: MigrationContext): boolean;
  apply(context: MigrationContext): MigrationResult;
}

interface MigrationContext {
  codelarkHome: string;
  paths: {
    legacyConfigJson: string;
    legacyConfigEnv: string;
    homeToml: string;
    dataSessionsJson: string;
    channelConfigDir: string;
    sessionConfigDir: string;
    migrationState: string;
    backupDir: string;
  };
  readToml(path: string): unknown;
  writeTomlAtomic(path: string, value: unknown): void;
  readJson<T>(path: string): T | null;
  writeJsonAtomic(path: string, value: unknown): void;
}
```

约束：

- migration 必须幂等：重复执行不能改变已迁移结果。
- migration 必须先写备份，再写目标文件。备份目录为 `${CODELARK_HOME}/backups/config-migrations/<migration-id>/`。
- migration 不删除旧文件，默认重命名为 `.migrated` 或写入 backup；真正清理单独做 housekeeping。
- migration 只处理持久化文件，不读取动态 `process.env` 作为迁移输入。
- 迁移失败时启动应失败并提示用户查看 backup，而不是半迁移继续运行。
- 迁移成功后，运行时只读取新 TOML；旧 `config.env` 和 `config.json` 不再参与配置加载。

### v1 -> v2 迁移内容

`src/configuration/migrations/v1.ts` 负责把当前 v1 数据整体迁到 v2 TOML 配置体系。它内部按步骤执行：

1. 全局配置迁移：

- 输入：`~/.codelark/config.json`、`~/.codelark/config.env`。
- 输出：`~/.codelark/config.toml`。
- 行为：
  - `config.json` 是主要输入。
  - 如果只存在 `config.env`，按 legacy env parser 生成 home TOML。
  - 如果两者都存在，按当前兼容逻辑保留有效值，但最终只写一个 `config.toml`。
  - 字段改名时写入新 TOML 字段，例如 `runtime.codex.defaultModel -> runtime.codex.model`，`CODELARK_CODEX_DEFAULT_MODEL -> runtime.codex.model`。
  - 旧 env key 仅作为迁移输入；迁移后不再读取 `config.env`。

2. Session 配置迁移：

- 输入：`data/sessions.json`。
- 输出：`config/sessions/<session-id>.toml` 和精简后的 `data/sessions.json`。
- 行为：
  - 抽取 `runtime.codex.model/yoloMode/provider/sandboxMode/networkAccess/reasoningEffort`。
  - 抽取 `runtime.claude.model/yoloMode/provider/reasoningEffort/idleTimeoutMinutes`。
  - 抽取被判定为配置的 `runtime.general.workingDirectory/tmuxSessionName/captureLines/autoEnter/echoInput`，分别写入 `[session]` 下的 `workspace/tmux_session_name/tmux_capture_lines/tmux_auto_enter/tmux_echo_input`；`runtime.general.systemPrompt` 不再迁移到配置。
  - 保留身份字段：Codex thread id、Claude session id、created/updated、health、mirror、runtime status 等。
  - 默认迁移到 Session scope，保持现有 BridgeSession 语义。

3. Channel 配置迁移：

- 输入：现有 channel defaults、bindings 或未来的 channel policy 字段。
- 输出：`config/channels/<channel-id>.toml`。
- 行为：
  - 将 Feishu Channel 级配置写入 Channel TOML。
  - 如果产品决定 `/r` 一参数默认 Channel，则新写入从一开始进入 Channel TOML；旧 Session TOML 不自动合并到 Channel，避免扩大影响面。

4. Env alias 诊断：

- 输入：真实 `process.env`，只做诊断，不写配置。
- 输出：env compatibility overlay、启动 warning / doctor report。
- 行为：
  - 如果存在 `CODELARK_CODEX_DEFAULT_MODEL` 等旧 env，提示迁移到 `CODELARK_CODEX_MODEL`。
  - 如果新旧 env 同时存在，使用新 env 并 warning。
  - 不读取 `config.env`。

阶段 1：模型落地

- 新增 `defaults.toml`。
- 新增 `schema.ts` 和 latest `fields.ts`，覆盖现有全局字段和 session override 字段。
- 明确配置字段与身份/状态字段边界：配置字段迁到 TOML；BridgeSession JSON 保留 id/name、Codex thread id、Claude session id、created/updated、health、mirror、message/runtime status 等。
- setup wizard 改为从 latest `configFields` / defaults 生成全局配置项，用户留空时不写 home TOML，运行时回落到 `defaults.toml`。

阶段 2：读取链路替换

- 实现 `sources.ts`，读取 defaults/home/local/channel/session/env/cli/request。
- 删除旧 `loadConfig/saveConfig` facade；仍需要验证旧配置语义时，测试直接通过 `ConfigService.snapshot()` 与 `legacy.ts` adapter 组合覆盖。
- 启动时执行一次性迁移：读取旧 `config.json` 和 `config.env`，生成 `config.toml`；迁移成功后不再把 `config.env` 作为输入 source，也不再维护新的 `config.env` 快照。
- 新旧 env 键只来自真实 `process.env`，用于本次进程覆盖；旧 env 键通过 `env-compat.ts` 兼容读取并 warning，不再通过 `config.env` 文件读取。
- daemon、operator-ui、setup wizard 先切到 global scope 查询。
- 子进程 env 注入改为 `ConfigService.exportProcessEnv(scope)`，由 effective config 生成 `LARK_CHANNEL_CONFIG`、`bridge_*` 等环境变量；不得再通过读取 `config.env` 注入。

阶段 3：scoped 配置迁移

- 从现有 BridgeSession JSON 抽取配置字段，写入 `config/sessions/<id>.toml`，迁移后 effective config 必须不变。
- 默认保持现有语义：旧 BridgeSession runtime 字段先迁到 Session scope，不擅自变成 Channel scope。
- 如果产品确认某些字段应成为 Channel 默认值，再提供显式迁移：`Session TOML -> Channel TOML`。
- 迁移后 BridgeSession JSON 中删除这些配置字段，避免双写和来源歧义。

阶段 4：写入链路替换

- `/set` 默认写 home TOML；后续支持 `--local` 写 local TOML。
- `/r`、`/mode`、`/sandbox`、`/network`、`/model`、`/cd` 等命令改为 `ConfigService.set(target, patch)`，先由命令参数解析出 `ConfigWriteTarget`。
- 上述命令切到 TOML 后，`default`/`reset` 的语义是清除对应 TOML override 并回到上层 v2/global 配置；旧 BridgeSession JSON 中残留的同名配置字段不得重新作为 runtime fallback 生效。`/provider` 也遵循同一规则：Codex/Claude provider 选择写 Session TOML，BridgeSession JSON 只保留 thread id、tmux session name、Claude session id/cwd 等运行身份。
- UI 的全局配置页写 home；会话配置 modal 写 Session TOML；通道实例和通道连接/行为配置只写 home `channels`，Channel scope TOML 只保存执行偏好。
- 删除 UI `mergeConfig`、runtime command patch helper 中重复的字段校验。

阶段 5：调用方收口

- `resolveSessionRuntimeConfig()` 改为调用 `ConfigService.snapshot(sessionScope)`，不再手写 session -> store settings fallback。
- `configToSettings()` / `exportProcessEnv()` 变成 projection，不再承载默认值，也不读取 `config.env`。
- adapter runtime 通道实例读取从 `ConfigService.snapshot().config.channels` 获取；`bridge_channel_instances_json` 只作为 legacy projection 输出，不再作为 bridge 内部运行时配置输入。
- 删除 expanded `Config` facade；旧 `Config` 形状只保留在 `legacy.ts` / `legacy-types.ts` 中作为 migration 和 compatibility adapter。
- 测试从“字段函数测试”改为“configFields 驱动的多 source 覆盖矩阵”。

## 测试计划

必须覆盖：

- `defaults.toml` 可以 parse，并通过 zod 校验。
- home TOML 覆盖 defaults。
- local TOML 覆盖 home。
- env 覆盖 local。
- CLI 覆盖 env。
- Channel TOML 覆盖 CLI/env/local/home/defaults。
- Session TOML 覆盖 Channel TOML。
- request patch 覆盖 Session TOML。
- `unset` 或 TOML `null` 能清空允许清空的字段。
- home `channels` 整组覆盖 defaults，partial home channel 会从 defaults 模板补齐并写回；local/env/cli/channel/session/request 定义 `channels` 必须失败。
- secret 字段在 `explain()` 和 UI payload 中 mask。
- 启动迁移能把旧 `config.json` 和 `config.env` 转成 `config.toml`，迁移后归档或重命名旧输入文件，并且运行时不再读取 `config.env`。
- 子进程环境变量由 effective config projection 生成，不依赖 `config.env` 文件。
- 旧 env alias 仍可从真实 `process.env` 读取，例如 `CODELARK_CODEX_DEFAULT_MODEL`，但新 env `CODELARK_CODEX_MODEL` 优先。
- `config.env` 迁移保持现有用户可用，不破坏旧 `CODELARK_FEISHU_DOMAIN`。
- setup wizard、UI 全局配置页、`/set` 全局配置列表和 `defaults.toml` 使用同一份 latest `configFields` / defaults；留空字段回落到同一个默认值。
- BridgeSession JSON 中现有 `/r`、`/sandbox` 等持久化配置字段能迁移到 scoped TOML，且迁移前后 effective config 一致。
- BridgeSession JSON 迁移后不再包含配置字段，只保留身份、生命周期和观测状态。
- `exportRuntimeSettings()` 与现有 `configToSettings()` 的关键输出兼容。

## 结论

推荐把配置系统重构为“所有持久化配置使用同一套 TOML shape + zod 校验 + latest configFields + migration-local legacy adapters + Global/Local/Channel/Session source merge + ConfigService 查询/写入”的模型。`BridgeSession` 不应继续作为配置后端；它保留会话身份和运行状态，配置 override 迁移到 Channel/Session scoped TOML。这样默认值和当前对话 override 都有统一表达，覆盖关系可解释，业务代码查询配置不再手写 fallback，CLI/env/local/home/Channel/Session/request 的优先级也能被测试矩阵直接验证。
