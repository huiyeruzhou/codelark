# Codex 工具调用解析与卡片展示

本文说明 CodeLark 如何从 Codex session JSONL 解析工具调用，并把它们展示到飞书流式卡片。重点是 GPT-5.6 引入的 `exec` orchestration envelope，以及它和旧工具事件的兼容边界。

## 数据流

工具调用依次经过以下层次：

1. `src/runtime/codex/session-index/event-mirror-parser.ts` 读取 session JSONL 的 `response_item` / `event_msg`。
2. `tool-call-normalizer.ts` 在输入边界识别 GPT-5.6 wrapper；`tool-call-events.ts` 把调用转换成统一的 `tool_started` / `tool_finished` mirror record。
3. `src/runtime/codex/turn-events.ts` 按 `call_id` 合并开始和结束事件，形成 `ToolCallInfo`。
4. `src/shared/progress/tool-call-details.ts` 抽取 command、patch、退出码、耗时和输出等结构化详情。
5. `src/shared/progress/tool-rendering.ts` 生成工具标题和 Markdown；`src/channels/feishu/markdown.ts` 把同一轮的工具按时间位置放入飞书折叠面板。

`src/runtime/codex/session-index/history-parser.ts` 使用同一套 normalizer 和 detail renderer，因此流式 mirror 与历史读取不会对同一条工具调用给出两种格式。

## 旧格式

旧格式直接给出逻辑工具名称和参数。例如：

```json
{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"npm test\"}"}
```

`Bash`、`shell_command` 和 `exec_command` 都进入 command detail，命令使用 `bash` code fence。`apply_patch` 和 `edit` 进入 patch detail，补丁使用 `diff` code fence，并从 `*** Add/Update/Delete File` 行提取文件摘要。

Codex SDK 的高层 `ThreadItem::CommandExecution` / `FileChange` 也分别映射到 `Bash` / `Edit`，不经过 GPT-5.6 wrapper 兼容逻辑。

## GPT-5.6 orchestration 格式

GPT-5.6 的 session JSONL 可能把逻辑工具包在一个 free-form custom tool 中：

```json
{
  "type": "custom_tool_call",
  "name": "exec",
  "input": "const r = await tools.exec_command({\"cmd\":\"npm test\"}); text(r.output);"
}
```

patch 常见形态是先声明静态字符串，再传给内层工具：

```js
const patch = "*** Begin Patch\n*** Update File: src/app.ts\n@@\n+const enabled = true;\n*** End Patch";
text(await tools.apply_patch(patch));
```

CodeLark 不执行这段 JavaScript。normalizer 使用 Acorn 解析 AST，再只解释 literal、object/array、简单字符串拼接和静态变量引用等白名单节点；动态 import、任意函数调用和其他表达式不会被求值。这样可以可靠跳过字符串/注释中的伪调用，并找出 `Promise.all` 等编排结构里的 `tools.<name>(...)`。

单个内层调用且参数可静态确定时，外层 `exec` 会被还原为内层工具名称和输入，随后完全复用旧格式的 detail 与 renderer：

- `tools.exec_command(...)` → `exec_command` 工具面板 + `bash` fence。
- `tools.apply_patch(...)` → `apply_patch` 工具面板 + `diff` fence。
- 其他单一、静态内层调用保留其真实工具名称并走现有 generic/专用 detail。

一次 wrapper 含多个内层调用时，CodeLark 保留一个外层 lifecycle / `call_id`，标题显示为 `exec_command × N` 或 `tools × N`，并在组内按源码顺序分别渲染每个子工具。可静态确定的 command/patch 仍分别使用 `bash` / `diff` fence；动态参数显示为未求值的参数源码。外层只有一份聚合输出，因此它只显示在“编排输出”区，不会被伪造为某个子工具的输出。

GPT-5.6 对 patch 还可能同时写入一个不同 call id 的低层 `patch_apply_end`。共享 turn reducer 会把唯一同名 running wrapper 的 completion 合并回原工具；如果它属于唯一的多工具 orchestration wrapper，则忽略这个冗余 lifecycle，等待外层 output 完成。没有 wrapper 的旧事件仍独立展示；多个同名 running 工具存在歧义时也不猜测归属。

## wrapper 输出

新 `custom_tool_call_output` 可能由多个 `input_text` block 组成：

```text
Script completed
Wall time 0.2 seconds
Output:
tests passed
```

这类明确带 `Script completed/running/failed` 前缀的输出会保留换行，使既有 command parser 能继续抽取 wall time 和 `Output:` 正文。其他结构化 free-text 仍沿用原来的紧凑归一化行为。

## 验证边界

- normalizer 单测覆盖单 command、静态变量 patch、字符串伪装、`Promise.all` 多工具顺序和旧格式不变。
- session parser 集成测试用真实 GPT-5.6 JSONL shape 验证 mirror record 与 history 的 `bash` / `diff` fence。
- mock-app E2E 从一个包含 bash + patch 的多工具 wrapper 出发，经过 session JSONL、mirror reducer 和真实 `FeishuAdapter` CardKit payload，验证最终卡片显示 `tools × 2`、两个子工具、正确 code fence，并且不泄漏外层 orchestration JavaScript。
- 真实飞书验收必须使用独立 test app 和隔离 `CODELARK_HOME`；触发消息与最终 transcript 都由 `lark-cli --as user` 发送/读取，不能复用当前 live bridge app。mirror provider 必须等到 `Card finalized status=completed` 后再收集报告；流式卡片回显的用户 prompt 不能当作 final marker。
