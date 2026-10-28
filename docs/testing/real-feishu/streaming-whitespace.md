# 流式正文空白保留验证

## 2026-10-27 回归

原因位于共用正文快照 reducer：对新增片段调用 `trim()` 后直接连接，导致 `This sample` → `This sample keeps` 变成 `This samplekeeps`。原始完整快照仍然正确，所以只检查模型最终返回值无法发现卡片历史已经被破坏。

单测逐字符覆盖英文词间空格、纯空白分片、重复快照、段落换行、Markdown 硬换行、Tab、代码缩进和中英文混排；mirror controller 回归模拟同一原生消息的连续快照并检查实际 history 内容。修订快照和工具历史的既有检查继续保留。

真实验收使用独立测试 App 和用户所属群，经真实用户消息、Feishu WebSocket、隔离源码 daemon、原生 Codex app-server 到流式卡片。模型夹具以多个 SSE 分片分别输出单词、纯空格、换行和四空格缩进；首次 item 事件不能提前暴露完整答案。用户身份读取的中途卡片仍处于 streaming 且不含终态标记，完成后再次读回并核对：

- `This sample keeps the spaces.` 完整保留词间空格。
- 两个段落之间保留空行。
- Python `return 1` 行保留精确四个缩进空格。
- 最终卡片已关闭 streaming。

飞书回读会在 fenced code 内插入额外空行，因此缩进按代码行逐行检查，不以相邻非空行之间的空行数量判断缩进是否丢失。首轮夹具还在 item-added 事件携带了完整正文，不能证明真实分片链路；该轮报告保留为无效验收记录。修正夹具并补断言后重跑通过。

### 段落到代码块的边界

2026-10-27 验收还发现：回读的最终卡片里 `Second paragraph.` 与 ```` ```python ```` 之间的空行消失（发送侧为正确的 `\n\n`，24 次 API 回读均为直接相邻）。因此脚本现在显式记录 `paragraphToFenceNewlines`；该边界在 10-27 那次验收没有检查，不能把"段落与代码块之间的空行"算作已验证项。

### 复跑

真实验收脚本已入库：`npm run real:feishu:streaming-whitespace`（需要 `CODELARK_REAL_FEISHU_E2E=1`、已降级的 lark-cli profile 和测试 App 通道；可选 `CODELARK_REAL_FEISHU_RETAIN_GROUP=1` 保留测试群，默认解散）。证据默认写到 `work/whitespace/real-chunks/report.json`，可用 `CODELARK_REAL_FEISHU_WHITESPACE_DIR` 改位置。`work/` 不入库，证据请在合并前归档或重跑。

最终证据字段：中途与终态原始用户回读、模型分片、`cardSyncPlans`。隔离进程在 `finally` 中停止。此验证使用确定性模型，覆盖实际出站交付与卡片内容；没有把 OpenAPI 成功码或日志预览作为显示验收。
