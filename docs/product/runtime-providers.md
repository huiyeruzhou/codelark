# 运行时与提供方

CodeLark 把“使用哪个 AI 工具”和“如何驱动它”拆成两层。

- 运行时：当前会话使用 Codex、Claude Code 还是 Kimi Code。
- 提供方：当前运行时通过 SDK、pty 或 tmux 运行。

日常 IM 操作流程见 [会话、Provider 与配置工作流](../guide/session-workflows.md)。本文主要说明 provider 能力边界和实现模块。

## 能力矩阵

| 运行时 | 提供方 | 适用场景 | 输出路径 |
| --- | --- | --- | --- |
| Codex | `sdk` | 结构化事件、工具调用、直接 IM turn | 原生 SDK stream |
| Codex | `pty` | 复用 Codex TUI 行为，观察真实终端 | JSONL mirror + pty screen |
| Codex | `tmux` | 需要可 attach 的长会话 | tmux screen + JSONL mirror |
| Claude Code | `tmux` | 默认路径；需要可 attach 的 Claude Code TUI 长会话 | tmux screen + Claude JSONL mirror |
| Claude Code | `pty` | 使用本机 `claude` 或 `ccr code` TUI | Claude JSONL mirror + pty screen |
| Claude Code | `sdk` | 使用 Claude Agent SDK | SDK message stream |
| Kimi Code | `tmux` | 使用本机 Kimi Code TUI 长会话；发送后自动补 `Ctrl-S` steer | tmux screen + Kimi `wire.jsonl` mirror |

补充说明：

- Claude Code 运行时默认使用 `tmux` 提供方，便于从 IM 和本机终端同时观察/接管 Claude Code TUI；可通过 `/provider pty` 或 `/provider sdk` 为当前会话切换。
- Codex 运行时的默认提供方由全局配置和平台探测共同决定；需要可 attach 的长期终端会话时，优先选择 `tmux`。
- Kimi Code 当前只支持 `tmux` 提供方。fresh session 会先启动 Kimi，短暂检查屏幕上是否已有 `Session:`；如果没有，就发送两次 `Ctrl-C`，从 `To resume this session: kimi -r ...` 提示解析 session id，再用 `kimi -r <session>` 重启并注入用户输入。输出由 Kimi `wire.jsonl` mirror 同步；状态区会展示截断后的「当前思考」。

## 用户配置入口

- `/runtime codex|claude|kimi`：切换当前会话使用的运行时。
- `/provider` 或 `/p`：查看或切换当前运行时的提供方。
- `/model`：查看或切换当前会话模型。
- `/cd <path>`：修改当前会话工作目录。
- `/set`：查看或修改全局默认值。
- Web 工作台配置页：编辑全局默认值。
- Web 工作台会话配置弹窗：编辑单个会话的覆盖值。

Claude 的 `executable` 影响 `tmux` 和 `pty` 提供方；Claude SDK 提供方不走本机 `claude` / `ccr code` TUI。

## 设计模块

| 主题 | 模块 |
| --- | --- |
| 提供方路由 | [src/runtime/codex/routing-provider.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/runtime/codex/routing-provider.ts) |
| Codex SDK | [src/runtime/codex/provider.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/runtime/codex/provider.ts) |
| Codex pty | [src/runtime/codex/pty-provider.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/runtime/codex/pty-provider.ts) |
| Codex tmux | [src/runtime/codex/tmux-provider.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/runtime/codex/tmux-provider.ts) |
| Claude tmux | [src/runtime/claude/tmux-provider.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/runtime/claude/tmux-provider.ts) |
| Kimi tmux | [src/runtime/kimi/tmux-provider.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/runtime/kimi/tmux-provider.ts) |
| tmux session 生命周期 | [src/bridge/tmux/runtime.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/tmux/runtime.ts) |
| Claude pty | [src/runtime/claude/pty-provider.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/runtime/claude/pty-provider.ts) |
| Claude SDK | [src/runtime/claude/sdk-provider.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/runtime/claude/sdk-provider.ts) |
| Claude Code Router | [src/runtime/claude/code-router.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/runtime/claude/code-router.ts) |
| 会话运行时设置 | [src/domain/session-runtime.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/domain/session-runtime.ts) |
| 交互 turn | [src/bridge/turn/interactive/runner.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/turn/interactive/runner.ts) |

## 镜像与 SDK 输出差异

SDK 提供方通常直接把结构化事件交给 IM turn。pty / tmux 提供方更接近真实终端使用，会依赖本地 JSONL mirror 把最终输出同步到 IM。

tmux Provider 的普通文本会先转发到 tmux 中的当前 runtime TUI。Codex tmux 如需自动预创建 `codex_thread_id` 或恢复缺失的 tmux session，启动进度会更新到同一张 Provider 卡片；Claude tmux 会启动或复用 Claude Code TUI，并通过 Claude JSONL mirror 同步输出；Kimi tmux 会启动或复用 Kimi Code TUI，通过 Kimi `wire.jsonl` mirror 同步输出，并在普通文本发送后自动补 `Ctrl-S` 触发 steer。显式发送 `/p tmux` 时，Codex 和 Claude 通过 shared tmux runtime 生命周期入口创建或重建 provider-owned session；Kimi 由 Kimi provider 负责启动、解析 session id 和注入输入。shared runtime 会在 ready 检测和屏幕查看时报告 Codex/Claude selection prompt；`/clear` 和 `/t archive` 会 best-effort 清理记录在 runtime state 中的 tmux provider session。输入成功转发后，原用户消息会短暂添加 `Typing` reaction，直到 mirror stream 启动并开始同步本地 JSONL 输出。

相关模块：

- mirror 订阅：[src/bridge/mirror/subscription-registry.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/mirror/subscription-registry.ts)
- mirror 运行时：[src/bridge/mirror/runtime.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/mirror/runtime.ts)
- mirror turn 合并：[src/bridge/mirror/turns.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/mirror/turns.ts)
- mirror 反馈：[src/bridge/mirror/feedback-controller.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/mirror/feedback-controller.ts)
