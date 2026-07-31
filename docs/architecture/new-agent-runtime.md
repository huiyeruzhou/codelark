# 新增 Agent 在 CodeLark 框架里的含义

## 结论

`agent` / `runtime` 表示一类底层对话系统的身份、会话索引、历史来源和 mirror 归属；`provider` 只表示 CodeLark 如何驱动这个 agent，例如 SDK、pty 或 tmux。

因此 Kimi Code 不应建模成 `runtime.codex.provider = "kimi"`。Kimi 是第三个 agent：

```toml
[runtime]
agent = "kimi"

[runtime.kimi]
provider = "tmux"
model = ""
```

这里的 `runtime.agent` 是全局、通道或会话 TOML 配置字段；`BridgeSession` 持久化运行态使用 `runtime.activeRuntime`。两者语义一致但处在不同层级：配置决定默认 agent，`BridgeSession.runtime.activeRuntime` 记录当前本地会话实际归属的 agent。

Kimi 当前只有 tmux 执行形态，所以 provider 集合保持单值 `tmux`。这比塞进 Codex provider 更清楚：Codex thread、Claude session 和 Kimi session 的本地历史、resume 规则、mirror 文件格式都不同。

## Agent 接入面

新增 agent 至少要接入这些系统面：

- 配置与会话状态。
- `/new`、`/clear`、`/runtime`、`/provider` 等会话生命周期命令。
- `/t` 本地会话列表、接管、绑定和归档。
- Mirror source 与 subscription registry。
- Transcript 与历史读取。
- Turn 归属、最终回复和健康状态。
- `/check` 健康诊断的 runtime identity。
- Operator UI 本地会话、具体聊天绑定和 session config。
- 真实 Feishu E2E runtime/provider 矩阵。

只新增 provider stream 不够。它最多让用户发起一次 turn，但不能可靠列出、切换、恢复、归档、观察或诊断本地会话。

## 从 Kimi 接入历史反推的改动地图

本页的规则不是只来自抽象设计。`feature/kimi-tmux-provider` 和后续 Cursor Agent 接入历史显示，新增一个 agent 会沿着多条既有系统边界扩散；PR 审查应逐项检查这些边界，而不是只看 provider 是否能返回一段文本。

| Kimi 改动证据 | 稳定接入义务 |
| --- | --- |
| 新增 `src/runtime/kimi/session-index.ts`、`src/runtime/kimi/tmux-provider.ts` 和 local-process tests | 每个 agent 都需要自己的本地会话索引、resume identity、cwd 规则、驱动 provider 和真实 CLI 生命周期测试。 |
| 修改 config schema、legacy migration、runtime settings 和 setup wizard | `runtime.agent`、`runtime.<agent>`、发布 schema、旧配置迁移和 UI 配置写入必须同时支持新 agent；不能把新 agent 塞进 Codex 或 Claude 的 provider namespace。 |
| 修改 routing provider、`/runtime`、`/provider`、`/current-runtime` 和 command-state tests | 命令分发必须按 active runtime 写入对应 agent 配置；provider 设置只作用于当前 agent，不能串写其它 runtime。 |
| 修改 `/new`、channel chat binding、`runtimeBridgeSessionIds` 和 mock E2E | 会话生命周期命令必须保留每个 agent 的独立绑定；`/new` 还需要真实操作者身份，测试不能用缺失 operator 的假成功路径掩盖平台语义。 |
| 修改 `/t`、session registry、thread display、archive 和 Operator UI session/binding routes | 新 agent 必须能被列出、materialize、绑定到一个身份明确的聊天、归档，并在前端展示正确的 runtime identity。 |
| 新增 Kimi `MirrorJsonlSource`、mirror subscription state、transcript source 和 turn runtime 类型 | provider stream 只是入口；已有本地会话的外部更新、历史读取、健康追踪和 turn final/progress source 都要接入 mirror/transcript/turn 三条通道。 |
| 修改 Feishu adapter card、streaming metadata 和 status note tests | agent 特有状态可以展示在状态区，例如 Kimi 的“当前思考”，但必须与最终回答正文分离，并有长度截断和不泄露内部内容的断言。 |
| 修改 real Feishu harness、coverage matrix、isolated bridge env 和 docs/testing 页面 | 新 agent 应进入既有 Feishu E2E runtime/provider 矩阵；不要新增 agent 专用开关，也不要复用 live bridge 或宿主会话数据目录。必须读取宿主安全登录存储时，凭据边界要显式、只读，测试 config/data/session 仍落在 runRoot。 |
| Cursor bridge harness 误用 noop provider，一度被误判为 transcript 空 completed | 真实 E2E 必须证明实际 routing provider/executable 被调用；日志没有 provider 启动证据时不能把 fake/noop 终态归因给 runtime。JSONL/wire/transcript 可以由 direct provider 或 mirror 驱动，但必须只有一个 terminal owner。 |
| Cursor rebase 到 provider-start/attachment/stop 新生命周期 | 新 agent 必须接入集中式 stale-start、stop、cleanup、attach confirmation 和进程丢失恢复；不能保留接入时复制的旧私有命令路径。 |

因此，一个新增 agent 的完成标准至少包括：配置能表达它，命令能切到它，本地历史能找到它，`/t` 能接管它，mirror 能观察它，Feishu 卡片能正确呈现它，真实 E2E 能把它纳入同一套矩阵。任一项缺失，都会让“能发一轮消息”的演示和“CodeLark 完整支持一个 agent”之间出现断层。

## 文档归属

新增 agent 的接入规则属于长期架构契约，必须写入 tracked `docs/` 页面，并在文档导航中可发现。`STATUS.md` 和 `work/` 下的 Markdown 只能记录当前 worktree 的过程状态、实验记录和临时草稿；它们被 `.gitignore` 排除，不应作为后续实现或测试的唯一依据。

如果一个结论会影响后续新增 runtime、`/t`、mirror、history、健康诊断或真实 Feishu E2E 的实现规则，就应沉淀到本页或相邻的 `docs/architecture`、`docs/testing` 页面。过程日志可以引用这些页面，但不能替代它们。

## 配置与状态

新增 agent 至少需要这些状态：

- 全局、通道或会话 TOML 配置：`runtime.agent = "kimi"`、`runtime.kimi.provider = "tmux"`、`runtime.kimi.model`。
- `BridgeSession` runtime state：`runtime.activeRuntime = "kimi"`、`runtime.kimi.sessionId`、`runtime.kimi.cwd`。
- binding 记忆：`runtimeBridgeSessionIds.kimi`。

`runtimeBridgeSessionIds.<agent>` 很关键。同一聊天在 Codex、Claude、Kimi 之间切换时，CodeLark 应记住每个 agent 对应的 `BridgeSession`，不能让新 agent 覆盖另一个 agent 的本地会话。

Kimi 的 `sessionId` 是 Kimi 本地 session id，不是 Codex thread id，也不是 Claude session id。`cwd` 必须一起保存，因为 Kimi resume 与工作目录强绑定。

## 会话生命周期命令

新增 agent 不能只支持普通文本 turn，还必须参与会话生命周期命令：

- `/runtime <agent>`：切换当前聊天的 active runtime，并在 `runtimeBridgeSessionIds.<agent>` 中恢复或创建对应 `BridgeSession`。
- `/provider` / `/p`：只修改当前 active runtime 的 provider 配置，不能写入其他 runtime namespace。
- `/new`：从当前聊天创建新群聊时，应继承当前 active runtime 和该 runtime 的 provider 选择；新群只写自己的 `runtimeBridgeSessionIds[activeRuntime]`，不能复制旧聊天的其它 runtime 映射，否则会把另一个群的 Codex/Claude/Kimi 上下文串过去。
- `/clear`：清空当前 active runtime 的上下文时，应替换该 runtime 的 `BridgeSession`，同时保留同一聊天里其它 runtime 的 `runtimeBridgeSessionIds`，让用户之后切回 Codex/Claude/Kimi 时还能回到原本的本地会话。

Kimi 的 `/new` 继承结果应直接是 `runtime.activeRuntime = "kimi"` 的新 `BridgeSession`，并写入 `runtime.kimi.provider = "tmux"`；普通 tmux 文本固定补 Enter，不再通过 session 配置开关表达。不能先创建 Codex session，再要求用户手动 `/runtime kimi`。

## `/t` 本地会话

`/t` 不是简单展示 `BridgeSession`；它展示的是本地 agent 历史和当前聊天绑定关系。

新增 agent 需要提供：

- `LocalRuntimeFilter` 枚举值。
- `LocalRuntimeSessionSummary.runtime` 枚举值。
- 本地 session index source。
- materialize 规则。
- archive 规则。
- 与当前聊天绑定关系的展示和回写规则。

Kimi 的 session source 是：

```text
~/.kimi-code/sessions/wd_*/session_*/agents/main/wire.jsonl
```

用户通过 `/t 1` 绑定 Kimi 会话时，CodeLark 应 materialize 一个 `BridgeSession`，写入 `activeRuntime = "kimi"`、`runtime.kimi.sessionId` 和 `runtime.kimi.cwd`。`/t archive` 对 Kimi 应归档 Kimi session，不能调用 Codex archive 或 Claude archive。

## Mirror 机制

CodeLark 的 mirror 不是“读任意 JSONL”的通用后台，而是按 agent 分开的 runtime source：

- Codex mirror source 读取 Codex JSONL，并用 Codex thread id 定位。
- Claude mirror source 读取 Claude JSONL，并用 Claude session id + cwd 定位。
- Kimi mirror source 读取 Kimi `wire.jsonl`，并用 Kimi session id + cwd 定位。

Kimi 需要自己的 `MirrorJsonlSource`。这样 `/t` 切换到已有 Kimi session 后，外部文件更新、mirror subscription、stream card、health tracking 才能走与 Codex/Claude 相同的通用机制。

Kimi parser 要特别处理 `content.part` / `think`。这类内容是 Kimi 的特色状态信号，不应混入最终回答正文。它应映射到状态区的“当前思考”，并做长度截断；可见 `text`、工具调用、工具结果、token usage 和任务完成事件仍走原有流式正文、工具和 usage 通道。

工具事件也必须在 agent adapter 边界归一化。Codex JSONL、Claude content block、Kimi `tool.call` / `tool.result` 分别解析自己的协议，但统一产出 `src/shared/progress/tool-events.ts` 的 `ToolCallEvent`，并尽量附带 `ToolCallDetail`。公共 detail 至少覆盖 command、terminal wait/input、file read/search/change/write、URL fetch、sub-agent、todo、orchestration 和 generic fallback。原始工具名、输入与输出仍应保留用于审计；不能识别时退回 generic，而不是在 Feishu renderer 中加入 agent-specific 分支。

Kimi 当前应把 `Bash`、`Read`、`Grep`、`Edit`、`Write`、`FetchURL`、`Agent` 和 `TodoList` 解析为上述公共 detail。这样相同语义在 Codex、Claude、Kimi 下共享标题、详情、截断和折叠规则；新增 agent 只扩展底层 parser，不复制顶层卡片逻辑。

Parser 还必须区分“中间循环事件”和“turn 终态事件”。Kimi 的 agentic loop 每个 step 都会写 `step.begin` / `step.end`，其中 `step.end` 的 `finishReason` 为 `tool_use` 时只表示该 step 为调用工具而结束，turn 仍在继续；只有 `end_turn`（或无 `finishReason` 的旧数据）才能映射为 `task_complete`，其他非空终态值和顶层 `turn.cancel` 应映射为 `task_aborted`。如果把中间 step 结束误映射成 `task_complete`，mirror 会在第一次工具调用后就提前终结 turn、把部分输出当成最终回复发出。任何 agent 的 parser 都要先回答“这个事件是不是 turn 终态”，再映射到通用 mirror contract。

wire 格式会随 CLI 版本演进（例如 Kimi 后来新增了 `metadata`、`config.update`、`llm.request`、`turn.prompt`、`turn.steer`、`permission.*`、`plan_mode.*`、`tools.*` 等顶层记录类型）。新增 agent 后要定期用真实 session 文件审计未知记录类型和 `metadata.protocol_version`：未知类型默认被忽略是安全的，但新出现的终态/取消/用户输入类事件必须评估是否需要接入 parser，fixture 也要与真实格式保持同步。

TUI selection prompt 探测也是 agent 专属能力，不是 tmux provider 的通用能力。Codex TUI selection prompt、Claude Code permission selection 和 Kimi steer/think 都有不同屏幕语义。新增 agent 不能因为 `runtime.codex.provider = "tmux"` 或 `runtime.claude.provider = "tmux"` 就自动进入既有探测路径；必须先明确该 agent 的屏幕形态、解析规则和 IM 回调动作。Kimi 当前不复用 Codex/Claude 的 selection prompt probe。

## Transcript 与历史

`/his`、诊断和会话详情不直接消费 provider stream，而是通过 transcript source 查本地历史文件。

Kimi 需要：

- `KimiSessionTranscriptSource`。
- 从 Kimi `wire.jsonl` 还原 assistant 可见消息。
- 过滤 user 注入、系统消息和内部 think。
- 标题回退：优先 `BridgeSession.name`，其次 Kimi session id 短号。

否则 Kimi turn 当下能返回，但后续历史查询会缺失或落回错误 runtime。

## Turn 归属

Turn tracking 需要区分 runtime 和来源：

- `BridgeTurnRuntime = "kimi"`。
- `BridgeTurnProgressSource = "kimi_jsonl"`。
- `BridgeTurnFinalSource = "kimi_task_complete"`。
- runtime identity callback 写入 `runtime.kimi.sessionId/cwd`。

Provider 发现本地 runtime identity 后，status/result 事件必须同时带上 agent session id 和 cwd。只写 session id 会让当前 turn 能完成，但后续 mirror source、`/t` 绑定展示、健康状态和诊断无法稳定定位本地文件。

如果 Kimi 复用 Codex 的 `codex_task_complete` 或 Claude 的 JSONL 身份，会导致健康状态、mirror 终止判定、卡片标签和调试日志语义错乱。

## 健康诊断

`/check` 展示的是当前 BridgeSession 的健康状态，但用户排障时需要看到底层 agent 的本地身份。新增 agent 时，健康诊断必须输出：

- runtime label，例如 `Kimi Code`。
- runtime-local identity，例如 `kimi_session_id`、`claude_session_id` 或 `codex_thread_id`。
- resume/mirror 必需的工作目录；Kimi 和 Claude 至少需要 cwd，Codex thread process probe 仍只对 Codex thread 生效。

否则状态机可能已经能判断 running/completed/stalled，但用户仍无法确认诊断对应哪个本地 Kimi session，也无法定位 mirror 文件。

## Kimi 当前特殊行为

Kimi tmux provider 的当前行为来自实测：

1. 已有 session：启动 `kimi -r <session> -y`。
2. fresh session：先启动 `kimi -y`。
3. 等待同一 TUI 出现 `Session:`、输入框和 context footer，直接保存 CLI 生成的 session id；fresh 不预造 id、不自杀重启。
4. 注入用户 prompt 后发送一次 `Ctrl-S` 触发 steer。
5. `wire.jsonl` 已存在时从当前尾部续读；如果 CLI 延迟到首条 prompt 后才创建 wire，则提交后等待并从 offset 0 读取。
6. status/result identity 输出 Kimi session id 和 cwd。
7. 从 Kimi `wire.jsonl` mirror 输出 text、tool、usage、terminal 和 think 状态。

早期关于 `kimi -p`、无常驻 TUI、无需交互处理的结论已经废弃。

## 推荐落地顺序

1. 先补 `runtime.agent = "<agent>"` 的类型、配置 schema、`BridgeSession` state 和 routing provider。
2. 实现 session index：枚举、按 id/cwd 查找、解析本地历史文件。
3. 实现 provider，只负责启动和驱动对应 agent。
4. 接 `/t`：列表、选择、绑定、archive 都支持该 agent。
5. 接 Operator UI：session source、display summary、registry materialize/archive、具体 chat binding 和 session config。
6. 接通用 mirror runtime 和 transcript source。
7. 更新命令文案、产品文档和 focused tests。
8. 把该 agent 放入真实 Feishu E2E 的现有 runtime/provider 矩阵，而不是新增 agent 专用开关。

## 新增 agent 改动 Checklist

以 Kimi 接入和后续审计为准，新增一个 agent 的完整改动范围如下。PR 审查时逐项核对；任何一项缺失都会在“能发一轮消息”和“完整支持一个 agent”之间留下断层。

### 类型、配置与存储

- [ ] `RuntimeAgent` 联合类型、`BridgeSession` runtime state（`<agent>.sessionId` / `cwd`）、`runtimeBridgeSessionIds.<agent>`（`src/domain/`）。
- [ ] 配置 schema：`runtime.agent` 枚举、`runtime.<agent>.provider` schema、`runtime.<agent>` 配置块，TOML↔camelCase 双向映射（`src/configuration/schema.ts`）。
- [ ] 字段注册：env key、`runtimeSettingsKey`、scopes（`src/configuration/fields.ts`）、`defaults.toml`、`merge.ts`。
- [ ] **写入校验穷举**：`ConfigService.patchPaths()` 必须列出 `runtime.<agent>.*`，否则 scope 校验被静默跳过（Kimi 接入时漏过，后补）。
- [ ] env 兼容层旧 key 别名（`src/configuration/env-compat.ts`）和文件迁移（`migrations/v1.ts`、`migrations/legacy/session-json.ts`）。
- [ ] 发布 JSON schema：`schemas/config.v2.schema.json`、`schemas/data/sessions.v1.schema.json`、`schemas/data/channel-chats.v1.schema.json`。
- [ ] 存储归一化与启动迁移（`src/storage/json-store.ts`、`src/storage/migrations.ts`）。

### 运行时与本地会话索引

- [ ] `src/runtime/<agent>/session-index.ts`：枚举、按 id/cwd 查找、解析本地历史文件。
- [ ] 驱动 provider（tmux/pty/sdk），含真实 CLI 生命周期测试（启动、resume、prompt 注入、退出）。
- [ ] **共享输入生命周期**：不得在 host manager 按 agent 名称开路由特例。首条消息可创建 identity/tmux，成功后 provider-owned process 必须跨 turn 保留；第二条消息只做存活检查并复用，不能重复 resume discovery、pane 光标探测或启动 CLI。进程丢失和失败恢复另测。
- [ ] **Bridge 冷接管**：清空内存输入状态但保留 tmux 和持久 identity 后，下一条普通消息必须确认 editor ready 并复用同一进程/session；不能要求已滚出屏幕的 session header，也不能重启 tmux。
- [ ] **provider-start 所有权**：显式 `/p tmux` 走共享 provider-start job；启动成功或失败后都重新校验聊天仍绑定原 session。过期启动只清理自己创建的 tmux，不写回旧 session。
- [ ] **终态事件语义**：parser 先判断“事件是不是 turn 终态”，区分中间 loop 事件（如 `finishReason: tool_use`）与真正完成/中止（`end_turn` → `task_complete`，取消类事件 → `task_aborted`）。fixture 必须取自真实 session 文件。
- [ ] **终态所有权**：明确 direct stream 与 mirror 谁拥有文本、工具、artifact 和 terminal。JSONL/wire/transcript 型 provider可以由 direct provider 读取本轮增量，也可以由 mirror 交付，但 suppression/claim 必须保证同一 turn 只有一个 completed。
- [ ] 特色状态信号（如 Kimi `think`）映射到状态区并截断，不混入最终回复正文。
- [ ] `MirrorJsonlSource` 注册到 mirror runtime，subscription registry 含该 agent 的 identity。
- [ ] TUI selection prompt 探测是 agent 专属能力；新 agent 不得因为 provider 恰好是 tmux 就落入 Codex/Claude 探测路径。

### IM 命令层

- [ ] `/runtime`、`/current-runtime`：接受新 agent，切换并恢复 `runtimeBridgeSessionIds.<agent>`。
- [ ] `/provider`：只写当前 agent 的 provider namespace；非法值给用法。
- [ ] `/model`、`/mode`、`/sandbox`、`/network`、`/reasoning`：支持或给出该 agent 的明确“不支持”提示，绝不串写其它 runtime 配置。
- [ ] `/set`：设置组、`CURRENT_RUNTIME_SETTING_KEYS`、`SETTING_GROUP_ORDERS`、form 名和展示 label（`global-settings.ts`）。
- [ ] `/current` 文本与卡片：identity 字段（如 `<agent>_session_id`）、runtime 下拉、配置表单项。
- [ ] `/t` 全家：本地会话列表 filter/summary、materialize、绑定、接管冲突、archive（调用该 agent 的归档，不能落到 Codex/Claude 归档）、展示 label。
- [ ] `/his`：transcript source，过滤 user 注入、系统消息和内部 think，标题回退规则。
- [ ] `/check`：runtime label、runtime-local identity、resume/mirror 必需 cwd。
- [ ] `/new`、`/clear`：继承 active runtime 与 provider，只写自己的 `runtimeBridgeSessionIds[activeRuntime]`；清理时杀掉该 agent 的 tmux session。
- [ ] `/stop`、`/tmux*`、`/pty-screen` 重定向、`/every`、`/then` 任务表 runtime 分支、`/help` 与别名；`stopRunningSession`、`cleanupRuntimeTmuxSession`、post-forward exit probe 必须认识新 agent，不能在命令文件恢复私有中断逻辑。
- [ ] 文案审计：通用路径上不得硬编码 “Codex” 字样的 reason/告警（健康 reason、goal 告警等在 Kimi 接入时都踩过）。

### Turn、健康与 Feishu 卡片

- [ ] `BridgeTurnRuntime`、`BridgeTurnProgressSource`、`BridgeTurnFinalSource` 三个枚举各加该 agent 的值。
- [ ] turn classifier、coordinator 终止归属、runner 的 identity 回调（session id + cwd 一起写）。
- [ ] 健康 reducer 的 identity/cwd；process probe 是否适用该 agent（Kimi/Claude 不走 Codex thread probe）。
- [ ] 流式 metadata tag、markdown assistant label、卡片 finalize 失败 fallback。
- [ ] 原生工具事件转换为公共 `ToolCallEvent` / `ToolCallDetail`；保留 raw name/input/output，未知工具走 generic fallback。
- [ ] 不在 channel renderer 添加 agent-specific 工具分支；公共 `ToolPresentation` 决定动作标题和状态去重；channel 统一使用“工具调用组 → 单工具”折叠，普通工具隐藏 output，`apply_patch` 显示受双上限约束的 diff。

### Operator UI、CLI 与脚本

- [ ] Operator UI：session source、session config 读写、具体 chat binding routes、runtime 下拉、identity 展示。
- [ ] CLI help、`setup-wizard` 检测目录、推荐规则和选项。
- [ ] `scripts/doctor.sh` 环境检查、`run-tests.js` 测试环境变量。

### 测试与真实 E2E

- [ ] 单元：parser 终态/取消/中间事件、identity 解析、transcript 过滤。
- [ ] 工具协议：用 scripted Mock 覆盖任意 start/result/error 顺序、长输出、Unicode、超长单行和多行 patch；用真实 agent fixture 覆盖原生工具参数 shape。
- [ ] Workflow：provider 真实 CLI 生命周期。
- [ ] P0 用户故事：同一聊天首轮冷启动、清空 bridge 输入状态后的存活 tmux 冷接管、tmux 丢失后的 resume；CLI/tmux launch 次数、runtime session id、pane pid、mirror source 和旧文本不重放都要断言。Codex、Claude、Kimi、Cursor 使用同一故事模板。
- [ ] Mock bridge E2E：命令矩阵按 agent 全覆盖。
- [ ] 真实 executable E2E：运行官方版本化 CLI 和真 tmux；必须明确哪些后端被 mock。只能使用真实账号后端时应 opt-in，并把会话 config/data 隔离到临时目录，不能污染宿主会话。
- [ ] 真实 Feishu E2E：纳入既有 runtime/provider 矩阵；不新增 agent 专用场景开关，不复用 live bridge 或宿主会话数据目录。若官方 CLI 的安全凭据只能从宿主 HOME/keyring 读取，应保持该凭据边界只读，并用 agent 专属 config/data env 把测试会话隔离到 runRoot。测试必须创建/复用隔离群、邀请当前用户、由用户身份发送并回读最终消息；需要人工评价时保留群直到确认。

### 文档

- [ ] 本页（接入契约与 checklist）、`current.md`、`runtime-providers.md`、`install-and-usage.md`（接管声明、前置条件、向导推荐规则、数据文件清单）、`session-workflows.md`、`data-observability.md`、`docs/testing/` 相关页。
- [ ] 过程状态只写 `STATUS.md` / `work/`；长期规则必须落在 tracked `docs/`。

### 格式演进维护（接入后持续）

- [ ] 定期用真实 session 文件审计 wire 记录类型：未知类型被忽略是安全的，但新的终态/取消/用户输入类事件必须评估接入。
- [ ] 关注 `metadata.protocol_version` 变化；fixture 与真实格式保持同步。
