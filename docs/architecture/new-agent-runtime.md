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
- Operator UI 本地会话、默认目标和 session config。
- 真实 Feishu E2E runtime/provider 矩阵。

只新增 provider stream 不够。它最多让用户发起一次 turn，但不能可靠列出、切换、恢复、归档、观察或诊断本地会话。

## 从 Kimi 接入历史反推的改动地图

本页的规则不是只来自抽象设计。`feature/kimi-tmux-provider` 的实现历史显示，新增一个 agent 会沿着多条既有系统边界扩散；如果未来接入第四个 agent，PR 审查应逐项检查这些边界，而不是只看 provider 是否能返回一段文本。

| Kimi 改动证据 | 稳定接入义务 |
| --- | --- |
| 新增 `src/runtime/kimi/session-index.ts`、`src/runtime/kimi/tmux-provider.ts` 和 local-process tests | 每个 agent 都需要自己的本地会话索引、resume identity、cwd 规则、驱动 provider 和真实 CLI 生命周期测试。 |
| 修改 config schema、legacy migration、runtime settings 和 setup wizard | `runtime.agent`、`runtime.<agent>`、发布 schema、旧配置迁移和 UI 配置写入必须同时支持新 agent；不能把新 agent 塞进 Codex 或 Claude 的 provider namespace。 |
| 修改 routing provider、`/runtime`、`/provider`、`/current-runtime` 和 command-state tests | 命令分发必须按 active runtime 写入对应 agent 配置；provider 设置只作用于当前 agent，不能串写其它 runtime。 |
| 修改 `/new`、channel chat binding、`runtimeBridgeSessionIds` 和 mock E2E | 会话生命周期命令必须保留每个 agent 的独立绑定；`/new` 还需要真实操作者身份，测试不能用缺失 operator 的假成功路径掩盖平台语义。 |
| 修改 `/t`、session registry、thread display、archive 和 Operator UI session/binding routes | 新 agent 必须能被列出、materialize、绑定到聊天、归档、设为默认目标，并在前端展示正确的 runtime identity。 |
| 新增 Kimi `MirrorJsonlSource`、mirror subscription state、transcript source 和 turn runtime 类型 | provider stream 只是入口；已有本地会话的外部更新、历史读取、健康追踪和 turn final/progress source 都要接入 mirror/transcript/turn 三条通道。 |
| 修改 Feishu adapter card、streaming metadata 和 status note tests | agent 特有状态可以展示在状态区，例如 Kimi 的“当前思考”，但必须与最终回答正文分离，并有长度截断和不泄露内部内容的断言。 |
| 修改 real Feishu harness、coverage matrix、isolated bridge env 和 docs/testing 页面 | 新 agent 应进入既有 Feishu E2E runtime/provider 矩阵；不要新增 agent 专用开关，也不要复用 live bridge 或宿主 agent home。 |

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

Kimi 的 `/new` 继承结果应直接是 `runtime.activeRuntime = "kimi"` 的新 `BridgeSession`，并写入 `runtime.kimi.provider = "tmux"` 与 `session.tmuxAutoEnter = true`；不能先创建 Codex session，再要求用户手动 `/runtime kimi`。

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
3. 如果屏幕很快出现 `Session:`，直接使用该 session id。
4. 否则发送两次 `Ctrl-C`，从 `To resume this session: kimi -r ...` 解析 session id。
5. 用 `kimi -r <session> -y` 重启。
6. 注入用户 prompt 后发送一次 `Ctrl-S` 触发 steer。
7. status/result identity 输出 Kimi session id 和 cwd。
8. 从 Kimi `wire.jsonl` mirror 输出 text、tool、usage、terminal 和 think 状态。

早期关于 `kimi -p`、无常驻 TUI、无需交互处理的结论已经废弃。

## 推荐落地顺序

1. 先补 `runtime.agent = "<agent>"` 的类型、配置 schema、`BridgeSession` state 和 routing provider。
2. 实现 session index：枚举、按 id/cwd 查找、解析本地历史文件。
3. 实现 provider，只负责启动和驱动对应 agent。
4. 接 `/t`：列表、选择、绑定、archive 都支持该 agent。
5. 接 Operator UI：session source、display summary、registry materialize/archive、binding/default target 和 session config。
6. 接通用 mirror runtime 和 transcript source。
7. 更新命令文案、产品文档和 focused tests。
8. 把该 agent 放入真实 Feishu E2E 的现有 runtime/provider 矩阵，而不是新增 agent 专用开关。
