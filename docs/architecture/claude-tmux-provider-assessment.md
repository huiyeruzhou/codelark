# Claude 支持 tmux provider 改动评估

## 结论

给 Claude 支持 tmux provider 属于中等偏大的功能改造，不是只把 `claudeProvider` 的枚举加上 `tmux`。好消息是 Claude JSONL mirror 已经存在，交互 runner 也已经把 Claude 非 SDK provider 当作 mirror turn，因此核心不用重写消息同步链路。主要工作集中在 provider 类型/配置入口、Claude tmux 启动与 prompt 注入、tmux 屏幕/按键控制、以及把 tmux 启动后的 Claude `session_id`/`cwd` 写回会话状态。

当前实现已把 Claude 默认 provider 收敛为 `tmux`。未显式设置 `runtime.claude.provider` 或全局 `CODELARK_CLAUDE_PROVIDER` 时，Claude Code 会优先启动可 attach 的 tmux TUI；仍可通过 `/provider pty` 或 `/provider sdk` 对当前 Claude 会话切换。

建议按两阶段实现：

1. 先做最小可用 Claude tmux provider：`/provider tmux` 可切换，启动 Claude Code TUI 到 tmux，普通消息自动注入，JSONL mirror 负责同步回复，`/tmux-screen` 可查看屏幕。
2. 再补齐体验增强：Claude TUI onboarding/trust prompt 的 IM 确认、选择界面恢复、interrupt/stop 语义、设置 UI 和真实 e2e。

## 当前相关结构

### Codex tmux 已有能力

- `src/runtime/codex/tmux-provider.ts`：Codex tmux provider 主实现，包括 tmux session 创建、prompt 注入、Codex TUI trust/update/selection prompt 处理、session JSONL 发现和 SSE 输出。
- `src/bridge/tmux/runtime.ts`：Codex resume tmux 的命令构建和 ready 检测，服务 `/provider tmux` 这种“已有 thread -> 启动可 attach tmux”的路径。
- `src/bridge/command/provider-settings.ts`：Codex `/provider tmux` 会先 bootstrap Codex thread，然后启动 tmux session，最后写入 `runtime.codex.provider='tmux'` 和 `runtime.general.tmuxSessionName`。
- `src/bridge/host/manager.ts`：当当前会话是 Codex tmux 时，普通消息会被转成 `/tmux ...` 注入，mirror 再从 Codex JSONL 同步回复。

### Claude 已有能力

- `src/runtime/claude/sdk-provider.ts`：Claude Agent SDK 路径。
- `src/runtime/claude/pty-provider.ts`：Claude Code TUI pty 路径，已有命令构建、ccr 环境准备、onboarding/trust prompt 自动确认、prompt 注入、JSONL session 发现、`captureClaudePtyScreen()`。
- `src/runtime/claude/session-jsonl.ts`：Claude JSONL 解析、session 列表、按 sessionId/cwd 查找、mirror delta 读取，已经能输出 `task_started/message/tool_started/tool_finished/task_complete/task_aborted`。
- `src/bridge/turn/interactive/runner.ts`：`activeRuntime === 'claude' && provider !== 'sdk'` 已经视为 mirror turn，progress source 是 `claude_jsonl`，final source 是 `claude_task_complete`。
- `src/bridge/turn/interactive/sdk-conversation-engine.ts`：已经会根据 provider 返回的 SSE `status/result.session_id` 更新 `runtime.claude.sessionId/cwd`。

## 必改模块清单

### 1. Provider 类型、配置和持久化

已把 Claude provider 从 `pty|sdk` 扩成 `pty|sdk|tmux`：

- `src/domain/session.ts`
  - `ClaudeProviderChoice = 'pty' | 'sdk' | 'tmux'`。
- `src/configuration/index.ts`
  - `ClaudeProviderChoice` 类型。
  - `normalizeClaudeProviderChoice()` 接受 `tmux`。
  - `serializeConfig()` 当前没有输出 `CODELARK_CLAUDE_PROVIDER`，这里应补上，否则 UI/配置保存后 tmux 默认 provider 无法落到 env。
  - `CONFIG_KEYS` 已包含 `CODELARK_CLAUDE_PROVIDER`，读取路径也已有，只是 normalize 不接收 tmux。
- `src/domain/session-runtime.ts`
  - `getSessionClaudeProvider()` 接受 `tmux`。
  - `setSessionClaudeProviderUpdate()` 类型自然跟随。
- `src/bridge/session/support.ts`
  - `resolveEffectiveClaudeProvider()` 接受全局或会话级 `tmux`。
- `src/runtime/contracts.ts`
  - `StreamChatParams.claudeProvider` 跟随扩展。
- `src/operator-ui/application/config.ts`
  - `mergeConfig()` 允许 `claudeProvider='tmux'`。
  - payload/default 展示接受 tmux。
- `src/operator-ui/shell.ts`
  - 全局配置下拉框和帮助文案增加 Claude tmux。
- `src/entrypoints/setup-wizard.ts`
  - Claude runtime 选择现在默认写入 `claudeProvider='tmux'`，后续可在 IM 或 UI 中切到 `pty` / `sdk`。

### 2. Claude tmux provider 实现

建议新增 `src/runtime/claude/tmux-provider.ts`，不要直接复制整份 Codex tmux provider。可复用/抽取：

- 从 `src/runtime/claude/pty-provider.ts` 复用或导出：
  - `buildClaudePtyCommand()` 的等价命令构建逻辑，最好改名为通用 `buildClaudeTuiCommand()`。
  - `buildClaudePtyEnv()` 的环境构建。
  - `hasClaudePtyTrustPrompt()`、`hasClaudePtyOnboardingPrompt()`、`hasClaudePtyInputPrompt()` 可改成通用 Claude TUI 检测函数。
  - `writePrompt()` 的多行输入逻辑要改成基于 tmux send-keys 的注入。
  - `findLatestClaudeSessionJsonlUpdatedAfter()` / `waitForClaudeSessionJsonlUpdatedAfter()` 可导出复用。
- 从 `src/runtime/codex/tmux-provider.ts` 复用或抽取：
  - `injectPromptIntoTmuxPane()` 或 `tmuxCore.injectPromptIntoPane()`。
  - 轮询 JSONL delta 并转换 SSE 的模式，但读取源要换成 `readClaudeSessionMirrorRecordDeltaByFilePath()`。
  - tmux session 生命周期、`CODELARK_DEBUG` 保留 tmux session 的调试行为。

最小实现的数据流：

1. 构建 Claude TUI 命令：`claude` 或 `ccr code`，携带 `--model`、`--permission-mode`、`--effort`。
2. 用 `tmuxCore.ensureDetachedSession()` 启动 detached tmux。
3. 捕获屏幕，处理 Claude onboarding/trust prompt，直到输入框 ready。
4. 注入用户 prompt。
5. 通过 `waitForClaudeSessionJsonlUpdatedAfter(cwd, promptStartedAtMs)` 找到本轮或当前 Claude JSONL，发出 `status.session_id/cwd/transcript_path`。
6. 轮询 `readClaudeSessionMirrorRecordDeltaByFilePath()`，把 records 转成现有 SSE：`text/tool_use/tool_result/status/result/error`。
7. task complete 后关闭 stream；`CODELARK_DEBUG` 未开启时按策略决定是否 kill tmux。若目标是可 attach provider，建议不要每轮 kill，而是保留 session 并复用，类似用户期望的 tmux provider。

### 3. 路由器接入

- `src/runtime/codex/routing-provider.ts`
  - 新增 `ClaudeTmuxProvider` 成员。
  - `params.runtime === 'claude'` 时把 `claudeProvider === 'tmux'` 路由到 Claude tmux provider。
  - 日志里 provider 输出 `tmux`。

### 4. `/provider tmux` 和普通消息转发

`/provider` 在 Claude runtime 下现在接受 `tmux|pty|sdk`：

- `src/bridge/command/provider-settings.ts`
  - `CLAUDE_PROVIDER_OPTIONS_TEXT` 增加 `tmux`。
  - `parseClaudeProviderArg()` 接受 `tmux`。
  - Claude `/provider tmux` 应启动或绑定一个 Claude tmux session，并写入：
    - `runtime.claude.provider='tmux'`
    - `runtime.general.tmuxSessionName=<session>`
    - 如已发现 Claude JSONL，再写入 `runtime.claude.sessionId/cwd`
  - 这里缺少 Claude 的“先 bootstrap thread 再 resume”的等价机制。Claude Code 可以用 `--resume <session>` 或类似能力时再补 resume；否则第一版可以启动空 Claude TUI，普通消息注入后发现 JSONL session。
- `src/bridge/host/manager.ts`
  - 当前普通消息自动转发到 tmux provider 的分支显式排除了 Claude：`activeRuntime !== 'claude' && provider === 'tmux'`。
  - 需要增加 Claude tmux 分支：当 `activeRuntime === 'claude' && claudeProvider === 'tmux'` 时，把普通消息注入到 `runtime.general.tmuxSessionName`。
  - 当前自动转发文案写死 Codex tmux，需要按 runtime 区分。
  - TUI selection prompt 恢复逻辑目前只处理 Codex TUI，Claude 需要单独处理或第一版明确不启用。

### 5. tmux runtime 抽象

`src/bridge/tmux/runtime.ts` 现在是 Codex 专用的 resume 命令构建。建议拆出更通用的能力：

- 保留 `codexTmuxSessionName()` / `startCodexResumeTmuxSession()`。
- 新增：
  - `claudeTmuxSessionName(bridgeSessionId or claudeSessionId)`
  - `buildClaudeTmuxCommand()`
  - `startClaudeTmuxSession()`
  - `hasClaudeTmuxReadyPrompt()` / `waitForClaudeTmuxReady()`
- 或者新增 `src/bridge/tmux/claude-runtime.ts`，避免把 Codex 参数和 Claude 参数混在同一个接口里。

### 6. 屏幕、按键和 stop/interrupt

- `/tmux-screen` 本身基于 `runtime.general.tmuxSessionName`，理论上可复用。
- `/tmux`、`/tmux-key` 也可复用，但文案要避免只说 Codex。
- `/pty-screen` 不适用于 Claude tmux，不需要改成 tmux。
- `/stop` 或 abort 行为需要确认：
  - pty Claude 用 Ctrl-C 写到 pty。
  - tmux Claude 应通过 `tmuxCore.sendInterrupt(targetPane)`。
  - 如果当前任务是 mirror turn，还要确保 session executor/turn state 能结束或等待 JSONL 出现 interrupted 记录。

### 7. Mirror 与状态同步

Claude mirror source 已经有 `createClaudeMirrorJsonlSource()`，但需要确认 host manager 是否创建了 Claude mirror runtime，以及订阅发现是否依赖 `runtime.claude.sessionId/cwd`。如果 Claude tmux 首轮没有及时写入 `sessionId/cwd`，mirror subscription 找不到源。

关键要求：

- Claude tmux provider 必须尽早发出 `status` 或 `result`：
  - `session_id`
  - `cwd`
  - `transcript_path`
- `sdk-conversation-engine.ts` 已会根据这些字段写回 `setSessionClaudeIdentityUpdate()`，可复用。
- 如果 `/provider tmux` 启动时没有 sessionId，首轮消息后才能订阅 mirror；要验证首轮是否还能被 interactive runner 的本次 provider stream 正常消费。保险做法是 provider 内部自己轮询 JSONL 并输出 SSE，而不是完全依赖后台 mirror runtime。

## 风险点

- Claude Code TUI 的输入 ready/onboarding/trust 文案可能随版本变化；pty 现有检测逻辑是经验规则，tmux 复用时要通过真实 CLI 验证。
- Claude JSONL 文件发现依赖 cwd 到 `~/.claude/projects/<project>` 的映射；worktree/symlink cwd 已有兼容逻辑，但 tmux 的 `-c` cwd 必须和写入 JSONL 的 cwd 保持一致。
- Claude 没有 Codex 那种已稳定使用的 `threadId -> resume tmux session` 启动路径。是否支持 `--resume`、如何选择最近 session，需要单独验证 CLI 行为。
- Codex tmux provider 里有大量 Codex 专属选择提示处理，不能直接套给 Claude；否则权限/更新/goal prompt 误判风险高。
- 当前全局配置序列化似乎没有写出 `CODELARK_CLAUDE_PROVIDER`，这会影响所有 Claude provider 默认配置持久化，需顺手修。
- Windows/psmux 支持要单独确认；当前 tmux 文案兼容 psmux，但 Claude TUI 行为可能不同。

## 测试建议

单元测试：

- `src/__tests__/unit/configuration/config.test.ts`
  - `CODELARK_CLAUDE_PROVIDER=tmux` 读取、保存、序列化。
- `src/__tests__/unit/bridge/command/help-command.test.ts` 或 provider command 相关测试
  - Claude runtime 下 `/provider` 展示 `tmux`。
  - `/provider tmux` 写入 Claude provider 和 tmux session。
- `src/__tests__/unit/runtime/claude/*`
  - Claude tmux command 构建：`claude`、`ccr code`、model、permission mode、effort。
  - ready prompt/onboarding/trust prompt 检测。
  - JSONL delta records -> SSE 映射。

Workflow 测试：

- `src/__tests__/workflow/runtime/claude/claude-tmux-provider.test.ts`
  - mock tmuxCore：启动、capture、sendActions、kill/interrupt。
  - mock Claude JSONL：首轮发现 session_id/cwd，流式输出 assistant/tool/result。
- `src/__tests__/workflow/bridge/command/command-dispatch.test.ts`
  - Claude runtime 下 `/p tmux`、普通消息自动转发到 tmux。

真实 e2e：

- 新增 `src/__tests__/e2e/local-process/claude/real-claude-tmux-provider.e2e.test.ts`
  - 需要本机安装 tmux/psmux 和 Claude Code。
  - 验证首轮消息、继续同一 session、`/tmux-screen`、abort/interrupt。

## 粗略工作量

- 最小可用：约 1.5-2.5 天。
  - 类型/配置/UI/命令：0.5 天。
  - Claude tmux provider：0.5-1 天。
  - mock workflow 测试和修边：0.5-1 天。
- 完整体验：约 3-5 天。
  - onboarding/trust/selection 的 IM 确认、真实 e2e、stop/interrupt、跨平台验证都需要额外时间。

## 推荐实现顺序

1. 扩展 `ClaudeProviderChoice` 和配置链路，先让 `tmux` 能被保存、展示、路由。
2. 抽出 Claude TUI 命令/检测/JSONL 发现工具，避免 pty/tmux 复制两套。
3. 新增 Claude tmux provider，先 provider 内部轮询 JSONL 并输出 SSE，确保首轮可用。
4. 接入 `/provider tmux` 和普通消息 auto-forward。
5. 补测试和文档，最后再做真实 Claude/tmux e2e。
