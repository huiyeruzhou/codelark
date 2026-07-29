# 功能与测试覆盖审计

本文把当前用户可见的 bridge 功能映射到本地测试覆盖和真实飞书 E2E 证据。真实飞书场景组织、当前证据和报告 gate 统一维护在 [真实飞书 E2E](real-feishu/)。

真实飞书 E2E 不应逐条镜像单元测试，而应通过基础对话 suite 和功能 suite 覆盖高风险、客户端可见的工作流，并在一次运行中收集多项相关断言。诊断、终端和会话控制命令 suite 应按 runtime（`codex`、`claude`、`kimi`）检查，而不是按完整 provider 矩阵检查；tmux 专属命令需覆盖 Codex tmux、Claude 默认 tmux 路径和 Kimi tmux。

真实飞书 harness 现在暴露 `coverageTier` 来描述测试结构。`mandatory-suite` 用于最高优先级长流程；`representative-suite` 用于验证功能丰富的工作流，是否按完整 runtime/provider 矩阵运行由该场景的 `providerCoverage` 决定；`runtime-compressed-command-check` 用于命令密集型检查；`legacy-transitional-evidence` 用于较旧但仍有诊断价值的拆分 full-matrix 场景，这类场景不应继续驱动新扩张。

报告证据必须用 harness 机器矩阵复核：

```bash
npm run real:feishu:e2e -- --coverage-matrix --reports-dir work/real-feishu
```

该输出把 15 个真实飞书场景展开为 70 个矩阵条目，其中 Kimi 相关条目为 12 个，并输出 `coverageRates`。真实飞书覆盖率只看 `canonicalPercent = canonical-pass / total`；`dry-run`、`diagnostic-failure`、`diagnostic-pass` 和旧 failure 的 `unmatchedReports` 只能说明计划或排障证据，不计入覆盖率。`executedPercent` 只是执行面参考，表示该 slice 里有任意真实报告或诊断报告的比例。

当前报告目录 `work/real-feishu` 的机器矩阵 `work/real-feishu/coverage-matrix-stage178-doc-sync.json` 给出的关键覆盖率：

| Slice | 覆盖率口径 | 当前值 | 说明 |
| --- | --- | --- | --- |
| 全量真实飞书矩阵 | `coverageRates.all.canonicalPercent` | 3/70 = 4.3% | 全部 planned 条目，包含 legacy |
| Current 非 legacy | `coverageRates.current.canonicalPercent` | 3/46 = 6.5% | 后续扩张主线，不含 legacy transitional |
| tmux 全量 | `coverageRates.tmux.canonicalPercent` | 3/45 = 6.7% | 只看 provider=`tmux` 的矩阵条目 |
| current tmux | `coverageRates.currentTmux.canonicalPercent` | 3/29 = 10.3% | 用户当前要求优先补测的 tmux 主线 |
| Kimi current | `coverageRates.kimiCurrent.canonicalPercent` | 3/8 = 37.5% | 非 legacy Kimi 主线，含 cross-provider long suite |
| Kimi current tmux | `coverageRates.kimiCurrentTmux.canonicalPercent` | 3/7 = 42.9% | 暂不测 SDK 时最直接的 Kimi tmux 覆盖面 |
| 卡片前端 current | `coverageRates.cardFrontend.canonicalPercent` | 1/26 = 3.8% | stream/final card、`/t` rich card、文件确认卡、CardKit 表单、question form、Markdown card |
| 卡片前端 current tmux/runtime-neutral | `coverageRates.cardFrontendTmux.canonicalPercent` | 1/17 = 5.9% | 当前优先补测的 tmux 与 runtime-neutral 卡片行为 |

聚合 `message-only::kimi-tmux`、`runtime-message::kimi-tmux` 和 `session-management::kimi-tmux` 三份 canonical 报告后得到上表；其余 Kimi current 场景仍是 Kimi parity 的真实缺口。

矩阵接受 `canonical-pass` 时会检查报告内的实际 evidence，而不是只信 `canonicalEligibility.eligible=true`。公共 evidence 必须证明 lark-cli 发送 observation、最终飞书 transcript 读取、coverage metadata、required dump/provider checks、mirror 异常检查和清理检查都通过；Kimi current 条目还必须证明 Kimi runtime identity、`kimi_wire_jsonl_found`、provider output path、mirror final 去重，以及对应场景的 transcript gate。薄报告会显示为 `diagnostic-pass` 并列出 `missingCanonicalChecks`，不能贡献 Kimi canonical 覆盖。

主线 Kimi 验收应使用：

```bash
npm run real:feishu:e2e -- --coverage-matrix --reports-dir work/real-feishu --require-canonical kimi-current
```

该命令会要求非 legacy 的 Kimi current 条目全部为 `canonical-pass`。聚合上述三份报告时仍有 5 个未通过条目：`basic-dialogue-suite`、`command-state`、`history-suite`、`agent-question-forms` 和 `markdown-rendering`。`session-management::kimi-tmux` 已由真实 Kimi executable + 本地假模型的隔离飞书运行覆盖。

## 功能面

| 区域 | 用户可见行为 | 本地覆盖 | 真实飞书覆盖 |
| --- | --- | --- | --- |
| Runtime 路由 | 普通 IM 消息进入选定 runtime；Claude 默认走 tmux，slash 命令仍在 bridge 内联处理。 | `bridge-adapter-runtime.test.ts`、`interactive-turn-runner.test.ts`、`session-runtime.test.ts`；`bridge-command-e2e.test.ts` 现在覆盖显式 `/runtime kimi` + `/p tmux` 后的普通飞书消息会进入 Kimi tmux、自动 `Ctrl-S`、绑定 Kimi session/cwd，并以 `mirror:` 返回 `**kimi:**` final。 | `message-only`、`runtime-message` 已有 Codex/Claude canonical 报告；`message-only::kimi-tmux` 和 `runtime-message::kimi-tmux` 也已有真实飞书 canonical 报告，证明隔离 test app、隔离 bridge、Kimi auth/config 隔离复制、真实飞书发送/读取、Kimi `wire.jsonl`、provider output path、runtime identity 绑定和 mirror 去重链路。有稳定 marker 的后续场景继续通过 `runtime_prompt_final_transcript_marker` 从最终飞书 transcript 命名验证 runtime prompt 最终回复 |
| Provider 选择 | `/provider` 和 `/p` 切换 Codex/Claude/Kimi provider；Kimi 当前只支持 `tmux`。 | `command-dispatch.test.ts`、`bridge-command-e2e.test.ts`、`codex-routing-provider.test.ts`、`claude-tmux-provider.test.ts`、`kimi-tmux-provider.test.ts` | `message-only::kimi-tmux`、`runtime-message::kimi-tmux` 和 `session-management::kimi-tmux` 已有真实飞书 canonical 通过；`command-state` 仍需补 Kimi canonical |
| Session 生命周期 | `/new`、`/t`、`/current`、`/cd`、`/clear`、`/his`、`/check`、重命名和归档流程。 | `feishu-markdown.test.ts` 覆盖 `/t` CardKit 表格结构；`command-dispatch.test.ts` 覆盖 `/t` 默认 20、50/100、Codex/Claude/Kimi runtime 下拉、用户输入轮数、接管确认、running 拒绝、Claude/Kimi archive，以及 Kimi `/check` 在 session id 发现前仍显示 identity 字段和 cwd；`command-dispatch.test.ts` 和 `bridge-command-e2e.test.ts` 覆盖 `/clear` 保留当前 runtime、继承 provider、清理旧 tmux session 和保留 alternate runtime mapping；`command-dispatch.test.ts` 覆盖 `/shell` 的 Codex sandbox、read-only/workspace-write、流式卡片和风险确认；`bridge-command-e2e.test.ts` 覆盖 mock app `/t` 卡片按钮链，并覆盖 Kimi `/current-runtime` 在 Kimi/Codex BridgeSession 之间来回切换且保留 Kimi session 配置；`bridge-command-e2e.test.ts` 现在覆盖 Kimi `/t <session>` 接管后 `/current`、`/check`、`/t`、`/t n 50`、`/t unbind`、重新接管和 `/t archive`，断言 `kimi_session_id`、`runtime_cwd` 与 Kimi archive sidecar；`bridge-manager.test.ts` 覆盖群删除 Codex/Claude/Kimi 归档。 | `session-management::kimi-tmux` 已有 canonical 真实飞书证据：真实 Kimi 0.29.2 连接隔离假模型，完整执行 `/new` 跨群、`/clear`、`/shell`、`/current`、`/check`、`/t`、解绑、runtime prompt、`/his` 与归档。runtime/session/wire 证据在 `/t archive` 前采集，归档回复和最终群名从归档后的真实飞书 transcript/群信息验证；两个测试群均由用户身份删除。Codex/Claude 其他 provider 仍需按当前 gate 重跑。 |
| Runtime 配置 | `/model`、`/mode`、`/sandbox`、`/network`、`/reasoning`、全局 `/set`。 | `command-dispatch.test.ts`、`bridge-command-e2e.test.ts`、`config.test.ts`；`bridge-command-e2e.test.ts` 现在覆盖 Kimi `/p` 仅接受 `tmux/default`、`/model` 写入 `runtime.kimi.model`、`/mode` 固定、`/sandbox`/`/network`/`/reasoning` 返回不支持且不继续改变 Codex/Claude runtime 配置，并在 Kimi command-state 链路里一并覆盖 `/status` 和 `/require-at off`。 | `command-state` 覆盖 runtime 设置并带命令级飞书文本断言；`command_state_runtime_settings_transcript` 会从最终飞书 transcript 命名验证 `/model`、`/mode`、`/provider`、`/sandbox`、`/network` 和 `/reasoning`，其中 Kimi 必须证明固定模式和不支持 Bridge 沙箱/网络/思考设置文案；`session-management` 覆盖 `/set` |
| 自动化输入 | `/every` 创建/列表/取消、表单新建和 every card 回调；`/then` 创建/列表/修改/取消、卡片新建/修改/取消、长 prompt 折叠和一次性后续发送。 | `bridge-command-e2e.test.ts`、`command-dispatch.test.ts`；`bridge-command-e2e.test.ts` 的 Kimi command-state 链路现在覆盖 `/every` 创建、列表和取消，断言列表卡片含 `runtime_id` 列，且整个过程保持当前聊天绑定在 Kimi BridgeSession。 | `command-state` provider 矩阵计划覆盖 Codex/Claude/Kimi 的 `/every` 创建/列表/取消，并通过 `command_state_runtime_settings_transcript` 从最终飞书 transcript 验证创建和列表回复包含 `session runtime-id`，证明自动化输入绑定到当前 runtime 身份；`card-forms` 真实飞书场景会发送并读回 `/every-form` 和 `/then-form` 的 `interactive` CardKit 表单，断言自动化表单字段与 `clk-command` callback 前缀。已有真实飞书 canonical 报告主要覆盖 Codex/Claude，Kimi 路径仍待跑。`/then` 当前已有本地 workflow 证据；由于 `/then <prompt>` 会立即触发后续 agent turn，真实飞书 command-state 不直接创建 `/then` agent follow-up，后续仍需补真实 submit/callback 事件证据 |
| Require-at 策略 | `/require-at on/off` 和非 mention 群消息过滤。 | `command-dispatch.test.ts`、`feishu-adapter.test.ts`、`bridge-command-e2e.test.ts`；Kimi command-state mock-app E2E 使用配置通道验证 `/require-at off` 可写当前 TOML 通道配置，不因 runtime 切换失效。 | `require-at-toggle` runtime-neutral 报告；`command-state` 也会在 Codex/Claude/Kimi provider 矩阵中检查 `/require-at off` 的命令回复 |
| 流式和 mirror 交付 | SDK provider 使用直接 `im:` 卡片；tmux provider 使用 `mirror:` 交付，且不重复最终文本；悬挂 mirror identity 按 runtime 清理。 | `interactive-turn-runner.test.ts`、`mirror-runtime.test.ts`、`turn-coordinator.test.ts`、`bridge-manager.test.ts` | `message-only`、`runtime-message`、`command-state`、`session-management` provider gate |
| Claude Code 集成 | Claude tmux 默认 provider、CCR 激活、Claude JSONL 身份、Claude SDK query 路径。 | `claude-tmux-provider.test.ts`、`claude-sdk-provider.test.ts`、`claude-session-jsonl.test.ts`、`real-claude-tmux-provider.e2e.test.ts` | Claude SDK 报告使用 CCR-backed SDK env + fake backend；Claude tmux 真实飞书证据待补。PTY 专属测试已删除，不再作为发布保证。 |
| Kimi Code 集成 | Kimi tmux provider、fresh CLI 随机 session id、输入前/后两种 `wire.jsonl` 创建时序、`think` 状态区展示和自动 `Ctrl-S` steer。 | `kimi-tmux-provider.test.ts`、真实 Kimi executable E2E、`kimi-tmux-provider-local-process.e2e.test.ts`、`kimi-session-index.test.ts`、`mirror-runtime.test.ts`、`command-dispatch.test.ts`、Operator UI/session registry 测试；workflow 覆盖 lazy wire，真实 executable + fake proxy 覆盖 fresh、running steer、复用、tmux 丢失恢复和错误终态。 | real-Feishu `message-only::kimi-tmux` 和 `runtime-message::kimi-tmux` 已用真实 Kimi + 隔离 `KIMI_CODE_HOME` 证明 `/runtime kimi`、`/p tmux`、真实 IM 发送/读取、Kimi `wire.jsonl`、provider output path 和 mirror final 去重；0.2.0 发布还要求当前 revision 重跑一次用户可见 Kimi 热点故事。 |
| Codex 终端 provider | Codex tmux 启动、prompt 注入、JSONL mirror 和清理。 | `codex-tmux-provider.test.ts`、`real-codex-tmux-provider.e2e.test.ts`、`bridge-command-e2e.test.ts` | Codex tmux 报告要求 `mirror:` 输出和 tmux 清理；PTY 专属测试已删除。 |
| 飞书 adapter | 消息发送、卡片更新/完成、reply threading、Markdown/card 渲染、事件过滤。 | `feishu-adapter.test.ts`、`feishu-adapter-card-e2e.test.ts`、`plain-markdown.test.ts`、`delivery-pipeline.test.ts` | 所有真实飞书报告都要求逐消息 `reply_to`；`card-forms` 覆盖 `/new-form`、`/every-form`、`/then-form` 作为 `interactive` CardKit 表单回复，并带 callback_data 前缀证据；`agent-question-forms` 覆盖模型生成的 `<clk-ask>` 问题表单和 `clk-agent-question` callback 前缀证据，最终报告还会从飞书 transcript 命名 gate `agent_question_form_interactive_transcript`，确保 Kimi tmux 等 mirror provider 不能只靠 mirror 响应计数通过；`markdown-rendering` 会通过 `markdown_rendering_transcript_structure` 从最终飞书 transcript 检查 marker、表格、fenced code block 和规范化后的 `plain_text` language tag，`markdown-rendering::codex-tmux` 已有对应 canonical 飞书原始内容证据；表单场景尚未触发真实 submit callback 事件。当前发布 gate 使用 SDK/tmux 路径。 |
| 诊断和清理 | 真实 E2E dump、bridge 日志、测试群创建/清理、测试 tmux 清理、过期锁处理。 | `real-feishu-e2e-harness.test.ts`、`service-manager.test.ts`、`command-dispatch.test.ts` | 每个真实飞书报告都 gate 群清理；未传 `--chat-id` 时主测试群必须通过产品 `/new` use case 创建，不能保留 `--create-chat`、`--source-chat-id` 或 lark-cli 直接建群兼容路径；`/new` 和云文档 `/new` 在缺少操作者 open_id 时拒绝建群，避免产生用户无法管理的群；tmux 报告 gate 测试 tmux 清理 |
| UI 和服务管理 | 配置 UI 路由、通道配置、服务 start/stop/status、hot update。 | `ui-*.test.ts`、`service-manager.test.ts`、`command-dispatch.test.ts` | 主要依赖本地覆盖；只有 IM 可见的 hot-update dry-run/log 行为在本地覆盖 |
| 附件和 artifact | 出站 artifact、问题卡片/表单、云文档评论交付。 | `outbound-artifacts.test.ts`、`streaming-artifact-delivery.test.ts`、`delivery-pipeline.test.ts`、`command-dispatch.test.ts`；`interactive-turn-runner.test.ts` 和 `bridge-manager.test.ts` 覆盖 answer 中间态立即发送、thinking 排除和 completed 去重；`mirror-feedback-controller.test.ts` 与 Feishu adapter 合同测试覆盖卡片创建中的异步 message id；`real-codex-tmux-provider.e2e.test.ts` 以真实 Codex CLI + tmux + Mock Responses 流验证 answer 文件在服务端终止事件前回复到流式卡片。`bridge-command-e2e.test.ts` 覆盖 Kimi `/t` 绑定后 mirror `<clk-ask>` 输出被清理成 Feishu question form。 | `command-state` provider 矩阵计划发送小文件 `/file <fixture>` 并要求 Feishu `file` 回复和 `file_key`，同时发送超过 20 MB 的 sparse fixture 并要求 Feishu `interactive` 大文件确认卡、文件名和 `clk-command` callback 前缀。先前隔离测试 App 的流式 artifact 样本只证明 file API 记录早于 completed，文件实际是 `reply_to=null` 的根消息，不能算用户侧交付通过；修复后必须重新手测并从用户入口确认附件挂在当前流式卡片下、同 turn 恰好一次且最终卡不泄漏协议块。云文档评论附件和真实确认 submit callback 尚未覆盖。 |

## 当前真实飞书 Gate

只有 harness 在自动 gate 通过后写出非 failure JSON 报告，成功报告才有效。必需 gate 包括：

- `message_observations_passed`：每条已发送飞书消息都有预期的 bot `reply_to`，或在预期过滤时没有回复。
- `final_feishu_transcript_present`：最终 transcript 包含当前场景聊天中的相关 message id。
- `required_checks_passed`：选定路径的 binding/session/runtime identity/audit/provider 检查满足要求。
- `provider_output_path`：SDK 路径产生直接 `im:` 输出且没有 `mirror:`；tmux 路径产生 `mirror:` 输出。
- `mirror_final_not_duplicated_in_direct_reply`：mirror provider 不把最终模型文本复制到直接状态回复中。
- `created_chat_cleanup_completed` 和 `scenario_created_chat_cleanup_completed`：harness 创建的聊天和 `/new` 场景创建的聊天都默认删除，失败时也不能因为没有显式 `--keep-group` 而保留。
- `fake_ccr_backend_used`：fake CCR 场景证明 fake backend 确实收到模型请求。

## 缺口

当前 provider/scenario 矩阵已经较宽，但这些功能区域仍主要依赖本地测试：

- 历史边界：空历史、跨聊天隔离、长 transcript 截断和 `/his json`/`/his file` 附件已有合并的 `history-suite::codex-tmux` canonical 证据，报告为 `histsuite-codex-tmux-live-0858.json`。该报告证明组合命令计划和分阶段 A/B 预期，包括同一个 `/his` 命令字符串在不同阶段对应不同 expectation。`history-suite` harness 现在改为 runtime/provider 矩阵，`kimi-tmux` 会和 Codex/Claude 进入同一个发送、读取、raw/json/file、截断和空历史隔离 gate；本地 mock-app E2E 现在额外证明 Kimi `/t` 绑定后 `/his` 默认、`msg`、`raw`、`json`、`file` 都从 Kimi `wire.jsonl` 读取，并排除 user/think/Bridge 缓存。`history_suite_transcript_contract` 会从最终飞书 transcript 命名验证短历史、json/file 附件、长截断和 B 群空历史隔离，避免 Kimi tmux 等路径只靠逐消息 observation metadata 通过。较旧拆分场景仍有历史证据和本地回归辅助价值。
- 非 final 命令回复中的最终文本断言：`command-state` 检查 status/settings/runtime/provider/current-state/every 命令的语义文本，并通过 `command_state_runtime_settings_transcript` 从最终飞书 transcript 命名验证这些回复；Kimi tmux 路径必须证明 Kimi Code 固定模式、不支持 Bridge 沙箱/网络/思考设置，以及 `/every` 创建/列表/取消的 runtime 绑定文本。`command-state` 还会对 `/file <fixture>` 检查 Feishu file message 与 `file_key`；`session-management` harness 检查 help/config/new/clear/cd/shell/current/check 命令文本，其中 `/shell --sandbox read-only printf <marker>` 要求读回 `/shell 执行完成`、stdout marker、`Codex sandbox`、`read-only` 和退出码 `0`，最终报告还会通过 `session_management_runtime_identity_transcript` 从飞书 transcript 命名验证 `/current`、`/check` 和 `/t archive` 的 runtime identity/归档回复。`codex-tmux` 已有当前语义证据；`codex-sdk`、`claude-sdk`、`claude-tmux` 的旧报告仍只证明遗留 `reply_to`，必须在新语义 gate 下重跑，旧 PTY 报告只作历史参考。一次旧的非隔离 `session-management::codex-sdk` 诊断证明命令链可以到达飞书和 `/his 5`，但因为当时 bridge provider 状态不受 harness 控制，canonical provider-output gate 失败。旧 `session-management::codex-tmux` 诊断失败已被 `session-codex-tmux-semantic-live-0550.json` 取代，该报告证明 mirror-stream final observation、`/his 5` marker、provider path 和双重清理。剩余命令密集型场景还需要对 permission 和 card callback 路径做同等处理。
- 附件和 artifact：图片/文件入站、出站附件、云文档评论回复路径和权限卡片。`command-state` 覆盖命令生成的小文件 `/file` 飞书 file 回复，并通过大文件 `/file` sparse fixture 覆盖 Feishu `interactive` 确认卡和 `clk-command` callback 前缀；最终报告还会通过 `command_state_file_and_large_file_transcript` 从飞书 transcript 命名验证小文件 `file_key` 和大文件确认卡字段，避免 Kimi tmux 等路径只靠命令发送计数通过。`card-forms` 覆盖命令生成的 `/new-form`、`/every-form`、`/then-form` CardKit 表单和 callback_data 前缀；`agent-question-forms` 现在覆盖 harness 矩阵中模型生成的 `<clk-ask>` 问题表单，并用最终 transcript gate 校验 `interactive` 表单字段和 `clk-agent-question` 前缀；Kimi tmux 的 mock-app E2E 还验证 `/t` 绑定的 Kimi mirror final 会清理 ask block，并额外投递带 `clk_choice`、`clk_input` 和 `clk-agent-question` callback 的 question form。表单场景和大文件确认卡都尚未证明真实 submit/click callback 事件，出站 agent artifact 和云文档评论附件仍主要依赖本地测试。
- 飞书渲染：`markdown-rendering::codex-tmux` 已有 Markdown 表格和代码块 canonical 真实飞书证据；当前真实飞书 mirror/card transcript 会把 `ts` fence 规范化为 `plain_text`，因此 `markdown_rendering_transcript_structure` gate 检查代码 fence 保留和规范化后的语言，并适用于 Kimi tmux 等 planned runtime/provider 路径。Kimi tmux 现在有 mock FeishuAdapter E2E 证明 `wire.jsonl` mirror final 中的表格和 fenced code 会生成 `interactive` markdown card，且 `think`/「当前思考」不进入 final 卡片正文；同一测试族也覆盖 Markdown 正文与 `<clk-ask>` 同时出现时，ask block 从 final markdown 中剥离并作为独立 question form 发送。但 `markdown-rendering::kimi-tmux` 仍缺真实飞书发送与 transcript 读取后的 canonical 报告。剩余 Markdown provider canonical 报告、嵌套代码块、工具详情卡片、长流式更新和 mirror 控制通知仍主要依赖本地测试。
- 权限和恢复体验：缺少读消息权限、缺少删除权限、缺少事件订阅、bot 不在群里、重复 App 实例争抢。
- 服务/UI 操作：setup UI 和 service manager 行为主要依赖本地测试，因为它们不自然地由飞书聊天消息驱动。

## 下一批测试切片

`runtime-message::kimi-tmux` 和 `session-management::kimi-tmux` 已有真实飞书 canonical 报告；前者证明 Kimi runtime prompt 最终文本可从最终飞书 transcript 读回，后者补齐跨群 session 生命周期、真实 CLI、归档时序与清理。`command-state`、`history-suite`、`markdown-rendering` 等有稳定 final marker 的 runtime 场景继续使用同一 gate，但仍需各自的真实飞书 canonical 报告。`history-suite::codex-tmux` 已有 canonical 证据；`history-suite::kimi-tmux` 已进入同一矩阵但仍需真实飞书 canonical 报告。下一批高价值切片仍是 `basic-dialogue-suite`，作为主要长流程集成测试。它的 Kimi gate 必须证明 fresh 只启动一次 `kimi -y`、没有用于发现 identity 的 Ctrl-C、从 TUI 读取随机 session id、至少一次 Ctrl-S steer，并从该 identity 对应的 `wire.jsonl` 读回 think、marker 与 `step.end`；completed final card 和历史正文都不能泄漏 thinking/status。命令密集型 suite 应继续按 runtime 压缩。历史 suite 应保持以下 gate 作为回归准则：

1. 保持跨聊天顺序：外层 `/runtime`、`/p`、`/new`；内层 `/runtime`、`/p`、`/cd`、final chat，然后执行历史命令。
2. 每个命令都继续要求 `reply_to`。
3. 接受新的 canonical 报告前，保持 `command-state` 和 `session-management` 语义回复断言与当前命令输出一致。
4. 要求 `history-suite` 在 A 群发送明确的短 marker echo prompt，然后要求 `/his raw 1`、`/his` 和 `/his msg 1` 回复包含 final chat marker 和历史标题/limit 文本。
5. 要求 `/his limit 3` 包含设置成功文本。
6. 要求 `/his json` 和 `/his file` 回复为带具体飞书 file key 的飞书 file 消息。
7. 要求空历史回复包含 `当前会话还没有历史消息。`，并通过 `expectedForbiddenTexts` 排除前一个聊天的 marker；在空 B 群执行 `/his*` 前不要做 provider setup，因为 provider 初始化本身会创建历史条目。
8. 要求长历史回复包含长 prompt 头部 marker 和 ASCII 截断标记 `...`，并通过 `expectedForbiddenTexts` 排除尾部 marker。
9. 对 mirror provider，要求两个 A 群 runtime prompt 都通过 `mirror-stream-evidence` 被观测，并要求 mirror card 在发送 `/his*` follow-up 前进入 `completed`；不要要求 prompt 本身有 direct `reply_to`。
10. 要求最终报告证明 tmux `mirror:` provider 路径、direct reply 中无最终文本重复，以及外层/A/B 聊天清理。
11. 考虑真实飞书重跑前，先运行脚本 typecheck、harness 单元测试和项目 typecheck。
