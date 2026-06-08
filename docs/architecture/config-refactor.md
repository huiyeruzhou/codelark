# 配置系统说明

本文说明 CodeLark 当前配置系统的结构、来源优先级、模块职责和调用方式。配置系统已经从旧的 `config.json` / `config.env` 输入迁移为统一 TOML 配置；旧文件只作为 v1 迁移输入，不再作为运行时配置来源。

## 总览

CodeLark 使用同一套 v2 TOML shape 表达默认值、全局配置、项目配置、Channel/Session 执行偏好、环境变量覆盖和 CLI 覆盖。运行时代码通过 `ConfigService` 读取统一 effective config，再在各自业务模块内解释 runtime、channel、session 等语义。

核心原则：

- 所有持久化配置都使用 TOML。
- `BridgeSession` JSON 只保存会话身份、生命周期和运行状态，不作为用户配置后端。
- 非通道实例字段的全局基础优先级为 `cli > env > local > home > defaults`。
- Channel/Session/request 动态覆盖复用同一套 TOML shape 和合并链路。
- `channels` 是特殊字段，只允许出现在 defaults 和 home `config.toml`。
- 配置层保持薄边界，只负责 source 选择、schema 校验、合并、来源解释、迁移和写回约束。
- runtime settings、子进程 env、通道选择、provider 回退等业务语义留在调用方模块。

## 配置来源

当前默认配置目录来自 `CODELARK_HOME`，未设置时为 `~/.codelark`。

| Source | Backend | 示例路径 | 持久化 | 说明 |
| --- | --- | --- | --- | --- |
| defaults | TOML | `src/configuration/defaults.toml` | 是，随包发布 | 产品默认值和默认 channel 模板 |
| home | TOML | `${CODELARK_HOME}/config.toml` | 是 | 本机全局配置 |
| local | TOML | `.codelark/config.toml` 或 `.codelark.toml` | 是 | 当前项目/目录配置 |
| channel | TOML | `${CODELARK_HOME}/config/channels/<channel-id>.toml` | 是 | 某个 Channel 的执行偏好 |
| session | TOML | `${CODELARK_HOME}/config/sessions/<session-id>.toml` | 是 | 当前会话的执行偏好 |
| env | env | `process.env.CODELARK_*` | 否 | 当前进程覆盖 |
| cli | argv | `codelark run --set path=value` | 否 | 单次 CLI 覆盖 |
| request | in-memory patch | 单次消息或命令参数 | 否 | 单次请求覆盖 |

优先级：

```text
Global effective config:
  cli > env > local > home > defaults

Channel effective config:
  request > channel > cli > env > local > home > defaults

Session effective config:
  request > session > channel > cli > env > local > home > defaults
```

`channels` 不参与上面的逐层合并。它只读取 defaults 和 home：home `channels` 整组覆盖 defaults；home 中的 partial channel 会通过 defaults channel 模板补齐并写回 home TOML。local 定义 `channels` 时只产生 warning 并忽略该字段，避免项目级配置误伤启动；env/cli/channel/session/request 定义 `channels` 仍会被拒绝。

## TOML Shape

`defaults.toml` 展示完整 v2 shape。home 可以保存完整 `channels` 清单并覆盖 defaults。local、Channel、Session TOML 使用同一套 shape 的非 `channels` partial，只写需要覆盖的执行偏好字段；local TOML 中误写的 `channels` 会被忽略并在 `snapshot().warnings` 中提示不会生效。

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
provider = "tmux"
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

命名规则：

- TypeScript API、`configFields`、`ConfigService.get()` 和 explain 使用 canonical path，例如 `runtime.codex.yoloMode`。
- TOML 落盘使用 section + snake_case，例如 `runtime.codex.yolo_mode`、`session.tmux_capture_lines`。
- `channels[]` 是字段模板路径，只用于字段注册和写入校验；读取具体通道时，调用方先取 `snapshot().config.channels`，再自行选择 channel。
- 旧 JSON path 和旧 env key 只出现在 migration/compatibility 说明与测试中。

## 模块职责

配置模块按功能组组织，避免把一组功能拆成过细文件：

```text
src/configuration/
  defaults.toml              # 产品默认配置，唯一默认值入口
  schema.ts                  # v2 TOML shape 的 zod schema、类型和 camel/snake 转换
  fields.ts                  # 当前字段注册表：path、scope、env/CLI 映射、secret、projection metadata
  paths.ts                   # CODELARK_HOME、默认工作区和 home path 展开；不暴露 legacy 输入路径
  sources.ts                 # defaults/home/local/channel/session TOML 路径、I/O、静态 baseline、home channel materialize
  merge.ts                   # patch/node-config 合并和 provenance 计算
  service.ts                 # ConfigService 查询、写入、replace、unset、explain 和迁移入口
  env-compat.ts              # 真实 process.env 旧 env alias 兼容和 warning
  cli-overrides.ts           # CLI --set/--unset 解析和 scope 校验
  path-access.ts             # canonical dot path 读写工具
  legacy.ts                  # legacy Config adapter 和 compatibility projection
  legacy-types.ts            # legacy Config 类型快照
  migrations/
    index.ts                 # migration registry 和 runner
    types.ts                 # migration 公共类型
    v1.ts                    # v1 -> v2 跨格式迁移
    legacy/
      env-file.ts            # config.env parser，仅供 v1 migration
      paths.ts               # config.env/config.json legacy 输入路径，仅供 migration/tests
      session-json.ts        # BridgeSession JSON 配置字段迁移

src/runtime/
  config-projections.ts      # 从 ConfigV2 派生 runtime settings 和子进程 env
```

文件级职责边界：

- `schema.ts` 只维护当前 TOML shape，不读写文件，不解释业务回退。
- `fields.ts` 是当前配置字段的事实来源，不承载旧字段迁移规则。
- `sources.ts` 处理配置文件发现、读写、静态 baseline 和 source 合法性，不解释 runtime/channel/session 业务语义。
- `merge.ts` 只负责合并和 provenance，不读取具体文件，不导出 projection helper。
- `service.ts` 是配置模块统一入口，负责构造 effective config、解释来源、执行迁移和写回。
- `legacy.ts` / `legacy-types.ts` 只服务 migration、compatibility adapter 和旧路径测试，生产代码不应从这里读取配置。
- `runtime/config-projections.ts` 是应用侧投影层，把 `ConfigV2` 转成 legacy runtime settings Map 或子进程 env。

## ConfigService API

业务代码通过 `ConfigService` 获取统一 effective value/source，并在自己的模块内聚合业务语义。业务代码不应绕过 `ConfigService` 读取 TOML/JSON，也不应把用户配置 override 写回 BridgeSession runtime config 字段。

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
  get<T = unknown>(path: ConfigPath, scope?: ConfigScope, request?: ConfigPatch): T;
  resolve(path: ConfigPath, scope?: ConfigScope, request?: ConfigPatch): ConfigResolveResult;
  explain(path?: ConfigPath, scope?: ConfigScope): ConfigExplainEntry[];
  set(target: ConfigWriteTarget, patch: ConfigPatch): void;
  replace(target: ConfigWriteTarget, patch: ConfigPatch): void;
  unset(target: ConfigWriteTarget, path: ConfigPath): void;
}
```

读写类型故意分开：

- `ConfigScope` 描述读取时参与合并的来源。
- `ConfigWriteTarget` 描述写入落点。
- `global` 是读取本机默认 effective config 的 scope；写全局配置时必须选择 `{ kind: 'home' }`。
- `local` 读取和写入都需要明确 cwd。

示例：

```ts
const service = createConfigService({ migrate: false });

const effective = service.snapshot({
  kind: 'session',
  sessionId,
  channelId: 'feishu-default',
  provider: 'feishu',
});

const model = service.get<string>('runtime.codex.model', {
  kind: 'channel',
  channelId: 'feishu-default',
  provider: 'feishu',
});

service.set(
  { kind: 'session', sessionId },
  { runtime: { codex: { reasoningEffort: 'high' } } },
);
```

## 字段和 Scope

`configFields` 集中描述当前字段：

- canonical path
- TOML path
- 可写 scope
- env key / CLI option
- command alias
- secret 标记
- runtime settings / process env projection metadata
- env parse/format 函数

常见字段组：

| 领域 | 示例 canonical path | TOML path | 主要 scope |
| --- | --- | --- | --- |
| runtime | `runtime.agent` | `runtime.agent` | home/local/env/cli/channel/session/request |
| bridge | `bridge.defaultWorkspace` | `bridge.default_workspace` | home/local/env/cli |
| session | `session.workspace` | `session.workspace` | local/channel/session/request |
| codex | `runtime.codex.provider` | `runtime.codex.provider` | home/local/env/cli/channel/session/request |
| claude | `runtime.claude.provider` | `runtime.claude.provider` | home/local/env/cli/channel/session/request |
| channel | `channels[].config.appId` | `channels[].config.app_id` | home |

`scopes` 回答“这个字段能出现在哪里”，source chain 回答“多个来源同时出现时谁赢”。例如：

- `channels` 只能写 home；local 里误写的 `channels` 会 warning 后忽略，channel/session/env/cli/request 中的 `channels` 会被拒绝。
- `session.tmuxSessionName` 这类执行上下文字段不应写成全局默认。
- `/r`、`/mode`、`/sandbox`、`/network`、`/model` 默认写当前会话或当前 channel 的 scoped TOML，不写 BridgeSession JSON。

## Channel 配置边界

Channel 有两类概念，不能混用：

- 通道实例清单和通道连接/行为配置：保存在 defaults/home `channels`，例如 Feishu app id、secret、site、allowed users、streaming 行为。
- 某个 Channel 的执行偏好：保存在 `${CODELARK_HOME}/config/channels/<channel-id>.toml`，例如 runtime、model、workspace。

业务代码读取通道实例时应先调用 `ConfigService.snapshot().config.channels`，再在业务模块内按 channel id、provider 回退、UI 默认项或 default target 选择具体实例。配置层不把 `channels[]` 隐式解析成 `feishu-default`。

`CODELARK_FEISHU_*` 和 `CODELARK_ENABLED_CHANNELS` 这类 channel env key 只用于：

- v1 migration 输入。
- 向子进程导出的 projection。

v2 运行时不会把这些真实 env key 合成为默认 channel patch；出现时只产生“仅导出给子进程”的 warning。

## Runtime Projection

运行时投影不在 `ConfigService` 中实现，而在 `src/runtime/config-projections.ts` 中实现：

- `exportRuntimeSettings(config)`：把 `ConfigV2` 转成 legacy runtime settings Map。
- `exportProcessEnv(config)`：把 `ConfigV2` 转成子进程 env。

调用方负责先拿到同一个 snapshot，再派生投影，避免一次启动内多次动态读取 TOML 造成不一致：

```ts
const service = createConfigService({ migrate: true });
const { config } = service.snapshot();
const settings = exportRuntimeSettings(config);
const env = exportProcessEnv(config);
```

## 迁移和兼容

启动时 `ConfigService` 默认执行配置迁移。迁移状态和备份由 `src/configuration/migrations/` 维护。

v1 迁移输入：

- `${CODELARK_HOME}/config.json`
- `${CODELARK_HOME}/config.env`
- `${CODELARK_HOME}/data/sessions.json`

迁移输出：

- `${CODELARK_HOME}/config.toml`
- `${CODELARK_HOME}/config/sessions/<session-id>.toml`
- 必要时写入 `${CODELARK_HOME}/config/channels/<channel-id>.toml`

迁移完成后：

- 旧 `config.json` / `config.env` 会归档，不再作为运行时输入。
- 旧 BridgeSession JSON 中的配置字段会迁到 Session TOML。
- BridgeSession JSON 只保留 thread id、tmux runtime identity、Claude session id/cwd、health、mirror 等身份和状态字段。
- 真实 `process.env` 中的旧 env alias 仍由 `env-compat.ts` 兼容读取并 warning；新 env key 优先。

仍然保留的 legacy holdout：

- `bridge_default_provider_id`
- `bridge_feishu_group_policy`
- `bridge_feishu_group_allow_from`
- `bridge_auto_start`

这些旧 settings 尚无明确 v2 字段或产品归属，当前通过边界测试显式 allowlist，避免继续新增旧配置输入。

## 业务调用约定

入口和业务模块按以下方式使用配置：

- CLI `run`：创建一个 `ConfigService`，用同一个 effective config snapshot 派生 UI env、Bridge preflight config 和 Bridge env projection。
- setup wizard：读取 defaults/latest fields 展示默认项，写入 home TOML，不生成 legacy env/json。
- operator UI：route 层不直接导入 `ConfigService` 写配置；application 层把 payload 转成 `ConfigPatch` 并写 TOML。
- `/set`：写 home TOML。
- `/r`、`/mode`、`/sandbox`、`/network`、`/model`、`/cd`：写 Channel/Session TOML。
- runtime 执行：通过 `ConfigService.snapshot(channel/session scope)` 读取 effective runtime config。
- channel adapter runtime：从 `snapshot().config.channels` 读取通道实例清单，业务层决定 provider/id 回退。
- storage：`JsonFileStore` 保存会话身份和运行状态；legacy runtime settings 是 projection 输出，不作为配置输入。

## 测试边界

配置系统需要持续覆盖以下边界：

- `defaults.toml` 可 parse，并通过 zod 校验。
- home/local/env/cli/channel/session/request 的覆盖顺序正确。
- `channels` 只能来自 defaults/home；其他 source 定义 `channels` 会失败。
- partial home channel 会从 defaults 模板 materialize 并写回。
- secret 字段在 explain 和 UI payload 中 mask。
- 旧 `config.json` / `config.env` 能迁移到 `config.toml`，迁移后运行时不读取 `config.env`。
- BridgeSession JSON 中的旧配置字段能迁移到 scoped TOML。
- `ConfigService` 不承载 runtime env/settings projection。
- `src/configuration` 外的生产代码不直接导入 `node-config` 或 `smol-toml`。
- 旧 facade、旧 projection、旧 runtime-options/channel-types 文件不被恢复。

当前边界测试主要在：

- `src/__tests__/unit/configuration/config-boundary.test.ts`
- `src/__tests__/unit/configuration/config-service.test.ts`
- `src/__tests__/unit/configuration/runtime-settings-service.test.ts`
- `src/__tests__/e2e/mock-app/configuration/config-v1-migration.test.ts`
