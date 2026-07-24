# 工具调用卡片统一展示 Proposal

## 结论

CodeLark 应在 runtime 协议和飞书组件之间增加一层稳定的“工具呈现模型”。Codex、Claude Code、Kimi Code 仍保留各自原始事件用于审计；卡片标题消费统一的动作语义：读取、浏览、搜索、运行、修改、写入、等待、调用外部工具等，展开详情仍消费真实输入输出。

这不是把 Kimi 或 shell 事件伪造成不存在的 GPT 调用。归一化结果同时保留 `rawName` 和原始输入；能可靠识别时生成 GPT/Responses 风格的 canonical name 与 arguments，不能可靠识别时退回真实工具名和安全摘要。

## 数据流与边界

```text
Codex JSONL / Claude JSONL / Kimi wire.jsonl
                    │
                    ▼
        runtime adapter（各自解析，保留 raw event）
                    │
                    ▼
 ToolCallDetail + ToolCallEvent（公共中间层，按 call id 合并）
                    │
                    ▼
 presentation model（动作、对象、结果、详情、预览）
                    │
                    ▼
 Feishu CardKit（保留历史记录容器、单工具一次折叠、状态语义、双上限预览）
```

边界原则：协议解析负责“发生了什么”，呈现层负责“读者先看到什么”。语义摘要是附加索引，不是有损替代；原始 command/query/path/diff/output 必须继续进入展开详情。Feishu renderer 不再反向猜 JSON wrapper，runtime adapter 也不负责拼卡片文案。

公共中间层不能以 Codex 命名。Codex `exec` AST、Claude JSONL block、Kimi `wire.jsonl` event 都是底层 adapter；`ToolCallDetail`、`ToolCallEvent`、call-id reducer、preview policy、`ToolPresentation` 和 renderer 属于 shared progress。旧 `CodexToolDetail`/`codexTurnEvent*` 只保留兼容 alias，不再作为新代码入口。

## 现状证据

- `7705a548-aadc-4818-8e22-f51d1aff29cc` 的 CardKit payload 只在折叠标题显示 `exec · 完成`，详情直接展示 `const r = await tools.exec_command(...)`。读者必须展开并理解 code-mode wrapper，仍不知道动作重点。
- 当前结构是“历史记录 → 工具调用组 → 单工具 → 长输出”，最多三层折叠；飞书消息读取结果只暴露“工具调用 · 14”之类的计数。
- exec output 在 shared renderer 先被截成 1000 chars，Feishu renderer 再按 2400 chars 截一次；generic output 只经过后者。两条路径规则不一致，也都没有行数上限。
- Kimi 已能产生 `tool.call` / `tool.result`，真实本地样本包含 `Bash`、`Read`、`Grep`、`Edit`、`Write`、`Agent`、`TodoList`、`FetchURL` 等工具，但当前只保留 name/input/output，没有生成结构化 detail，卡片只能走 generic fallback。

## 上游 Codex 对照

本次对照固定在 OpenAI Codex `ad65f016ed0c91992fb175fa881a373cc460dd2a`（2026-07-23 17:44:48 UTC）。关键做法如下：

- `codex-rs/code-mode-protocol/src/description.rs` 明确定义外层 `exec` 只是 V8 orchestration envelope，真实工具位于 `tools.<name>(...)`。
- `codex-rs/tui/src/exec_cell/model.rs` 和 `render.rs` 不把所有 shell 都显示为 Run；它们把命令分类为 `Read`、`List`、`Search`、`Unknown/Run`，连续读取还能合并。
- 命令标题直接显示真实脚本，web search 标题直接显示 query；完成态用视觉状态表达，不要求读者理解底层事件名。
- TUI 的短输出预览按行保留，并明确标出省略行数；完整 transcript 是另一条审计路径。

CodeLark 采用相同的语义分层，但不照搬 TUI 的 head+tail：普通工具 output 默认不进入卡片正文；`apply_patch` 的真实 diff 是例外，只保留开头并同时受字符数与行数约束。

## Canonical 工具呈现模型

| 原始来源 | 可识别输入 | canonical kind/name | 折叠标题示例 | 展开内容 |
| --- | --- | --- | --- | --- |
| Codex `exec` wrapper | 静态 `tools.exec_command({...})` | `run_command` / `exec_command` | `💻 运行 npm test · 1.2s` | 完整 command、cwd |
| shell `cat/sed/head/tail` | path、行区间 | `read_file` | `📖 读取 src/app.ts · 1–120 行` | 原命令、path、范围 |
| shell `rg/grep` | query、path | `search_files` | `🔎 搜索 “tool_call” · src/ · 18 处` | 原命令、query、path |
| shell `find/ls/rg --files` | path | `list_files` | `📂 浏览 src/runtime/` | 原命令、path |
| Kimi `Read` | `path/line_offset/n_lines` | `read_file` | `📖 读取 src/app.ts · 80 行` | path、范围 |
| Kimi `Grep` | `pattern/path` | `search_files` | `🔎 搜索 “foo” · src/` | query、path |
| Kimi `Edit/Write` | path、before/after/content | `edit_file` / `write_file` | `🛠️ 修改 src/app.ts` / `📝 写入 src/app.ts` | 变更片段或写入内容前缀 |
| `apply_patch` | patch file headers | `apply_patch` | `🛠️ 修改 3 个文件` | 文件清单、diff 前缀 |
| MCP/dynamic | server、tool、arguments | `call_tool` | `🔧 调用 server/read · src/a.ts` | arguments |
| 无法可靠识别 | raw name/input | `unknown` | `🔧 调用 FetchURL · example.com` | 原始参数 |

完成态使用与动作对应的图标；成功不再额外出现“完成”或 `Success`。运行中和异常仍使用状态图标，异常额外显示 `exit N` 或错误摘要。

## 卡片结构

### 折叠前

沿用既有的“历史记录”容器和“工具调用 · N”分组面板；展开分组后，每个工具调用对应一个折叠面板，单工具内部不再追加“长输出”折叠。标题由代码拼成一行：动作图标、动作、对象和非重复证据摘要；过长时交给 Feishu 客户端自然换行，不主动插入换行符。内容按以下优先级组织：

1. 状态图标。
2. 动作 + 主要对象，例如“读取 `src/a.ts`”“搜索 `foo`”“运行 `npm test`”。
3. 只补充新信息：命中数、文件数、行范围、非零退出码、耗时。

例如：

```text
📖 读取 src/runtime/kimi/session-index.ts · 第 420–520 行 · 101 行
```

```text
🛠️ 修改 3 个文件 · src/a.ts · src/b.ts · src/c.ts · 1.4s
```

标题不显示底层 wrapper，不重复成功状态，不同时出现同义的图标、颜色和状态词。

### 展开后

展开工具调用组和目标单工具后看到可复核信息：

- command/query/path/cwd 等关键输入；
- patch/file list 等结构化变更；
- `apply_patch` 的实际 normalized diff，文件清单不能替代 diff；
- 普通工具默认不显示 output 正文；output 只参与命中数、输出行数、exit code 等标题摘要；
- 必要时附原始工具名，但只作为 notation 级审计信息。

长输出不再使用单工具内部的额外折叠面板。历史记录容器仍按原设计存在且默认展开；工具调用组用于整体收纳，单工具面板用于查看参数或 `apply_patch` diff。

## 长内容双上限

普通工具输入使用统一 preview policy：默认最多 **4000 Unicode characters** 且最多 **80 lines**；普通 output 不进入卡片正文。`apply_patch` 输入是高价值审计证据，使用独立的 **8000 Unicode characters** 且 **160 lines** 上限。算法只保留原文前缀，任一上限先到即停止；返回值必须包含 `shownChars/totalChars`、`shownLines/totalLines` 和触发的限制。

约束：

- `shownChars <= 4000`；
- `shownLines <= 80`；
- patch 分别满足 `shownChars <= 8000`、`shownLines <= 160`；
- 不截断 surrogate pair；
- code fence 内容只放 preview，本体省略说明放在 fence 外，避免说明文字侵占上限；
- 必须先裁剪原始 code content，再生成 opening/closing fence；禁止截断已经渲染完成的 Markdown，否则会切掉 closing fence 并让 Feishu 把多行 code block 错误布局成一行；
- exec、read、search、generic、Kimi result 使用同一个 helper，不允许各层二次硬截断。

## `exec` wrapper 的安全归一化

继续使用 AST 静态解释，不执行模型提供的 JavaScript。扩展白名单以覆盖真实卡片里出现的安全表达式：

- template literal 的静态插值；
- 静态变量引用；
- object/array/literal 和字符串拼接；
- `JSON.stringify(staticValue)`。

任意动态函数、属性 getter、import、I/O、未知调用都保持 unresolved。单个可靠子调用转成 canonical tool call；多个子调用保留一个父 lifecycle，并生成子动作摘要；完全无法解释时以 `javascript` fence 展示按 top-level statement 分行后的源码，不再伪装成 JSON 或压成一行。

## Mock 模型与测试矩阵

建立可脚本化的 `LLMProvider` 测试模型。scenario 可以按顺序产生 reasoning、tool start、tool result、text、terminal 事件，并支持：

- 指定任意工具名、参数、结果、状态和延迟；
- 多工具、并发、长输出、Unicode、超长单行、超多短行；
- Codex `exec` wrapper、Kimi native tools、generic/MCP fallback；
- 固定 call id，保证 CardKit payload 和 SSE lifecycle 可重复断言。

它是确定性回归基座，不替代真实协议测试。Kimi 再通过 fake TUI + `wire.jsonl` 做本地 tmux E2E，最后用已授权的隔离 Feishu app 创建临时群、发送测试、读取卡片、完成后删除群。

## Kimi 完整接入验收

Kimi 达到“真的能用”至少需要同时通过：

1. 新 session 启动、resume id 获取、wire 文件定位、prompt 注入和终态收敛。
2. `Read/Grep/Bash/Edit/Write` 的开始/结束事件进入统一 detail，卡片标题有真实动作与对象。
3. 中间 `finishReason=tool_use` 不提前结束 turn；最终 `end_turn/cancel/error` 正确收敛。
4. `/t` 能列出和恢复 Kimi session；工作目录隔离不串 session。
5. fake Kimi local-process、Mock provider → Feishu adapter、真实 Kimi smoke、隔离 Feishu CardKit 四层测试均通过。

## 实施顺序

1. 提取 canonical detail/presentation 与双上限 preview helper，先用单测固定文案和边界。
2. 扩展 AST 静态解释，复现并关闭 `7705a548` 的 wrapper/单行问题。
3. 接入 Kimi native tool detail，补真实 wire 样本形状回归。
4. 保留“历史记录 → 工具调用组 → 单工具”结构，移除单工具内部的嵌套长输出和重复状态。
5. 建立 scripted Mock 和 fake Kimi E2E，最后跑隔离 Feishu 实卡验收。
