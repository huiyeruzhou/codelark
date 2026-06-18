# Codex TUI 工具状态渲染分析

本文分析的是本地拉取的 `openai/codex` 源码快照：

- 克隆目录：`work/codex-source-analysis/codex`
- HEAD：`dce673905a191744138dbba19a7d3f8d85b10d6c`
- 提交时间：`2026-06-18 15:06:23 -0700`
- 提交标题：`core: load AGENTS.md from foreign environments (#28958)`

## 结论

Codex TUI 不是直接把工具调用的原始 JSON 输出到界面。它把 app-server/protocol 的 item lifecycle 事件转换成几类 `HistoryCell`，再由 `ChatWidget` 维护一个可变的 `active_cell` 和已提交 history。当前正在执行的工具通常显示在 active cell；结束后 flush 成历史块。

底部的 `Working (Ns • esc to interrupt)` 是独立状态行，由 turn lifecycle 派生，不等同于某一个 tool call。命令工具的 stdout/stderr 则进入 `ExecCell` 的 `CommandOutput.aggregated_output`，完成后渲染时只展示有限行数，并在长输出时提示 `ctrl + t to view transcript`。

主聊天界面里，正在运行的可见状态主要是 active tool cell 加 bottom status：`Exploring` / `Running` 表示当前工具，`Working` / `Analyzing` / `Investigating...` 表示整个 turn。协作模式切换是 `Shift+Tab`，并且只在空闲、没有弹窗时生效；TUI 可见模式只有 `Default` 和 `Plan`。

## 事件到 UI 的路径

app-server 协议中的 `ThreadItem::CommandExecution` 包含 `command`、`cwd`、`status`、`aggregated_output`、`exit_code` 和 `duration_ms`；`FileChange` 与 `McpToolCall` 也是同一个 thread item 枚举中的工具类 item。`ItemStartedNotification` 和 `ItemCompletedNotification` 承载 item 生命周期，`CommandExecutionOutputDeltaNotification` 单独承载命令输出增量。参考：`codex-rs/app-server-protocol/src/protocol/v2/item.rs:215`、`:255`、`:1127`、`:1201`、`:1292`。

`ChatWidget::handle_server_notification()` 是 TUI 侧入口。它把 `ItemStarted` 分派给 `handle_item_started_notification()`，把 `ItemCompleted` 分派给 `handle_item_completed_notification()`，把 `CommandExecutionOutputDelta` 分派给 `on_exec_command_output_delta()`。参考：`codex-rs/tui/src/chatwidget/protocol.rs:31`、`:70`、`:92`、`:279`。

主渲染面由 `ChatWidget::as_renderable()` 组合：上方优先渲染 `transcript.active_cell`，再渲染 hook/token/rate-limit 临时 cell，底部始终挂 `BottomPane`。active cell 会随着工具运行实时变更；提交历史时通过 `InsertHistoryCell` 交给外层 app 写入 scrollback。参考：`codex-rs/tui/src/chatwidget/rendering.rs:6`、`codex-rs/tui/src/chatwidget.rs:1193`。

## 命令工具

命令开始时，`on_command_execution_started()` 会处理 unified exec 特例，然后延迟或立即进入 `handle_command_execution_started_now()`。后者确保底部 status indicator 存在，把命令记录到 `running_commands`，并创建或合并 `ExecCell`；连续的 read/list/search 会被合并成 Exploring cell。参考：`codex-rs/tui/src/chatwidget/command_lifecycle.rs:20`、`:242`、`codex-rs/tui/src/exec_cell/model.rs:49`、`:154`。

命令输出增量走 `on_exec_command_output_delta()`，它先记录 unified exec 最近输出，再找到当前 active `ExecCell`，用 `ExecCell::append_output()` 追加到 `CommandOutput.aggregated_output`。完成事件则从 item 的 `aggregated_output` 构造 `CommandOutput`，调用 `complete_call()`，必要时 flush active cell。参考：`codex-rs/tui/src/chatwidget/command_lifecycle.rs:54`、`:323`、`codex-rs/tui/src/exec_cell/model.rs:142`。

`ExecCell` 的展示逻辑在 `exec_cell/render.rs`。运行中显示活动符号和 `Running`，成功/失败用绿色/红色 bullet；普通命令标题是 `Ran`，用户手动 shell 是 `You ran`。输出使用 `output_lines()` 从 `aggregated_output` 取头尾，普通工具默认最多 5 行，用户 shell 最多 50 行；长输出会插入 `... +N lines (ctrl + t to view transcript)`。参考：`codex-rs/tui/src/exec_cell/render.rs:32`、`:103`、`:365`、`:442`。

## patch、MCP 和其他工具

patch 开始事件通过 `on_patch_apply_begin()` 直接创建 `PatchHistoryCell`，展示的是文件级 diff summary，并相对当前 `cwd` 格式化路径。patch 失败时可以追加 `Failed to apply patch` cell；协议里 `FileChangeOutputDeltaNotification` 已标注为 deprecated。参考：`codex-rs/tui/src/chatwidget/tool_lifecycle.rs:9`、`:156`、`codex-rs/tui/src/history_cell/patches.rs:5`、`codex-rs/app-server-protocol/src/protocol/v2/item.rs:1298`。

MCP 工具开始时创建 active `McpToolCallCell`，结束时按 call id 完成它。运行中标题是 `Calling`，完成后是 `Called`；结果内容会按块渲染并截断，错误会显示 `Error: ...`。参考：`codex-rs/tui/src/chatwidget/tool_lifecycle.rs:169`、`:196`、`codex-rs/tui/src/history_cell/mcp.rs:119`。

Web search、image generation 和 collaborator tool 有独立 cell 构造路径，但原则相同：开始事件创建 active 或即时 history cell，结束事件补齐状态/内容后 flush。参考：`codex-rs/tui/src/chatwidget/tool_lifecycle.rs:70`、`:117`。

## 当前运行状态

`TurnStarted` 调 `on_task_started()`，它把 `turn_lifecycle.agent_turn_running` 置为 true，然后 `update_task_running_state()` 把底部 pane 设为 running。`TurnCompleted`/失败/中断最终走 `finalize_turn()`，清 active cell、停止 running、隐藏 status。参考：`codex-rs/tui/src/chatwidget/turn_runtime.rs:13`、`:49`、`:299`。

底部 `StatusIndicatorWidget` 负责 `Working` 行、耗时、interrupt 提示和可选 details/inline message。它默认显示 `Working (0s • esc to interrupt)`，interrupt key 来自 keymap，可被重映射。参考：`codex-rs/tui/src/status_indicator_widget.rs:44`、`:80`、`:235`。

Unified exec 的后台进程摘要不作为普通工具块重复展示：`UnifiedExecFooter` 生成 `N background terminals running · /ps to view · /stop to close`，有 status 行时嵌入 status 行，没有 status 行时单独作为 footer row。参考：`codex-rs/tui/src/bottom_pane/unified_exec_footer.rs:16`、`codex-rs/tui/src/bottom_pane/mod.rs:1260`、`:1676`。

## 主聊天快捷键与模式

默认 keymap 里，`Ctrl+T` 打开 transcript overlay，`Ctrl+G` 打开外部编辑器，`Ctrl+O` 复制最后一条 agent 回复，`Alt+R` 切换 raw scrollback 模式，`Esc` 中断当前 turn。参考：`codex-rs/tui/src/keymap.rs:904`。

`Ctrl+O` 的处理在 `ChatWidget::handle_key_event()` 前段：命中 `copy_last_response_binding` 后调用 `copy_last_agent_markdown()`，成功时追加 `Copied last message to clipboard` 历史事件，失败时追加错误事件。剪贴板实现优先 SSH/tmux/OSC52 或本机 clipboard 后端。参考：`codex-rs/tui/src/chatwidget/interaction.rs:40`、`:253`、`codex-rs/tui/src/clipboard_copy.rs:1`。

协作模式切换不是 `Ctrl+O`，而是 `Shift+Tab`。`handle_key_event()` 只在 collaboration modes 启用、当前没有 running task、没有 modal/popup 时调用 `cycle_collaboration_mode()`。可见模式由 `TUI_VISIBLE_COLLABORATION_MODES` 限定为 `Default` 和 `Plan`，`Plan` 模式会在 footer 显示 `Plan mode (shift+tab to cycle)`。参考：`codex-rs/tui/src/chatwidget/interaction.rs:162`、`codex-rs/protocol/src/config_types.rs:576`、`codex-rs/tui/src/chatwidget/settings.rs:650`、`codex-rs/tui/src/bottom_pane/footer.rs:141`。

Vim mode 是另一层 composer 编辑状态，不等同于 collaboration mode。启用后 footer 会显示 `Vim: Normal` 或 `Vim: Insert`，并可与 Plan mode indicator 共同出现。参考：`codex-rs/tui/src/bottom_pane/chat_composer.rs:1066`。

## 正在运行的主界面

主聊天 running 画面不是单个“历史列表”。它由上方 transcript active cell 和底部 BottomPane 组合而成：`ChatWidget::as_renderable()` 先渲染 `transcript.active_cell`，再渲染 active hook、临时提示，最后渲染 bottom pane。也就是说，正在运行时你会同时看到“当前工具块”和“全局 Working 状态行”。参考：`codex-rs/tui/src/chatwidget/rendering.rs:6`。

普通命令刚开始时，active cell 是 `Running <command>`：

```text
• Running echo done
```

read/find/list 这类命令刚开始时，不展示原始 `rg`/`cat`/`ls` 命令，而是进入 `Exploring` 工具块。源码里对应 `ParsedCommand::Read`、`ListFiles`、`Search`；这里用户口语里的 find 对应 `Search` 标签。参考：`codex-rs/tui/src/exec_cell/model.rs:154`、`codex-rs/tui/src/exec_cell/render.rs:270`。

```text
• Exploring
  └ List ls -la
```

```text
• Exploring
  └ Search Change Approved
    Read diff_render.rs
```

running 的 `Exploring` 行内容来自解析后的命令动作，不是 stdout。`Read` 显示文件名，`List` 优先显示 path、没有 path 才显示原命令，`Search` 显示 query 或 `query in path`。连续纯 Read 会合并成一行并去重；混合 Search/List/Read 时按解析顺序分行。参考：`codex-rs/tui/src/exec_cell/render.rs:278`、`:306`、`:347`。

底部 status row 是另一层 UI。turn 开始时 `on_task_started()` 把 header 设成 `Working`；命令开始时也会 `ensure_status_indicator()`，保证状态行可见。elapsed 用紧凑格式：`0s`、`1m 00s`、`1h 00m 00s`。参考：`codex-rs/tui/src/chatwidget/turn_runtime.rs:49`、`codex-rs/tui/src/chatwidget/command_lifecycle.rs:242`、`codex-rs/tui/src/status_indicator_widget.rs:63`。

```text
• Working (0s • esc to interrupt)
```

如果 reasoning delta 里先出现粗体标题，底部 header 会从 `Working` 换成这个标题，例如 `Analyzing` 或 `Investigating rendering code`；这个状态仍然是全局 turn 状态，不是工具块。参考：`codex-rs/tui/src/chatwidget/streaming.rs:200`。

```text
• Investigating rendering code (0s • esc to interrupt)
```

所以 running 主界面典型同屏结构是：

```text
• Exploring
  └ Search Change Approved
    Read diff_render.rs

• Investigating rendering code (0s • esc to interrupt)

› Summarize recent commits
```

如果当前没有 active tool，但 turn 仍在跑，就只剩底部状态和 composer：

```text
• Working (0s • esc to interrupt)

› Ask Codex to do anything
```

如果 hook 和 exec 同时在跑，exec active cell 不会被 hook 覆盖；hook 作为单独 active hook cell 显示：

```text
active exec:
• Running echo done
active hooks:
• Running PostToolUse hook: checking output policy
```

如果 status 有 details，会在 status 下一行用 `  └ ` 展开，后续行继续缩进：

```text
• Working (0s • esc to interrupt)
  └ First detail line
    Second detail line
```

完成后才从 running 形态变成历史形态：`Running` 变 `Ran`，`Exploring` 变 `Explored`，输出才会按 `CommandOutput.aggregated_output` 展示并截断。running 阶段主要看 active cell 的操作摘要和 bottom status，不把完整 stdout/stderr 展开在主状态行里。

## 对 CodeLark 的启发

1. 卡片展示应该像 Codex TUI 一样消费结构化后的工具详情，而不是原始 tool envelope。
2. exec 输出应优先使用聚合 stdout/stderr 的字段，并做长度/行数限制；完整内容可以交给更重的详情入口。
3. patch 的主展示面应是文件/路径/diff summary，不应把 apply_patch 的运行 output 当作用户需要看的正文。
4. 当前运行状态和具体工具输出应分层：一个全局 `Working`/interrupt 状态，多个工具块的结构化历史。
5. 给 CodeLark 做“正在运行”展示时，优先还原 active tool cell + bottom status 的分层，而不是把完成态 history、stdout 和全局 Working 状态混成一张卡。
