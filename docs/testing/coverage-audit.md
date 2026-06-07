# 功能与测试覆盖审计

本文把当前用户可见的 bridge 功能映射到本地测试覆盖和真实飞书 E2E 证据。真实飞书场景组织、当前证据和报告 gate 统一维护在 [真实飞书 E2E](real-feishu/)。

真实飞书 E2E 不应逐条镜像单元测试，而应通过基础对话 suite 和功能 suite 覆盖高风险、客户端可见的工作流，并在一次运行中收集多项相关断言。诊断、终端和会话控制命令 suite 应按 runtime（`codex` 和 `claude`）检查，而不是按完整 provider 矩阵检查；tmux 专属命令需覆盖 Codex tmux 和 Claude 默认 tmux 路径。

真实飞书 harness 现在暴露 `coverageTier` 来描述测试结构。`mandatory-suite` 用于最高优先级长流程；`representative-suite` 用于在选定 provider 上验证功能丰富的工作流；`runtime-compressed-command-check` 用于命令密集型检查；`legacy-transitional-evidence` 用于较旧但仍有诊断价值的拆分 full-matrix 场景，这类场景不应继续驱动新扩张。

## 功能面

| 区域 | 用户可见行为 | 本地覆盖 | 真实飞书覆盖 |
| --- | --- | --- | --- |
| Runtime 路由 | 普通 IM 消息进入选定 runtime；Claude 默认走 tmux，slash 命令仍在 bridge 内联处理。 | `bridge-adapter-runtime.test.ts`、`interactive-turn-runner.test.ts`、`session-runtime.test.ts` | `message-only`、`runtime-message` 覆盖 codex-sdk/codex-pty/codex-tmux/claude-pty/claude-sdk；Claude tmux 作为默认路径需补 canonical 证据 |
| Provider 选择 | `/provider` 和 `/p` 切换 Codex/Claude `sdk|pty|tmux`。 | `command-dispatch.test.ts`、`bridge-command-e2e.test.ts`、`codex-routing-provider.test.ts`、`claude-tmux-provider.test.ts` | `runtime-message`、`command-state`、`session-management` provider 矩阵 |
| Session 生命周期 | `/new`、`/t`、`/current`、`/cd`、`/clear`、`/his`、`/check`、重命名和归档流程。 | `feishu-markdown.test.ts` 覆盖 `/t` CardKit 表格结构；`command-dispatch.test.ts` 覆盖 `/t` 默认 20、50/100、Codex/Claude runtime 下拉、用户输入轮数、接管确认、running 拒绝和 Claude archive；`bridge-command-e2e.test.ts` 覆盖 mock app `/t` 卡片按钮链；`bridge-manager.test.ts` 覆盖群删除 Codex/Claude 归档。 | `session-management` harness 已把 `/t` 纳入命令级飞书文本断言；当前 codex-pty 和 codex-tmux 已有语义 canonical 证据，但这些报告早于 `/t` 单表卡片，codex-sdk/claude-pty/claude-sdk 也仍需重跑。拆分历史场景在 Codex mirror provider 上有可用历史 canonical 证据；`history-suite::codex-tmux` 现在是 `/his` default/raw/msg/limit/json/file、长截断和 B 群空历史隔离的首选代表性 provider 证据。 |
| Runtime 配置 | `/model`、`/mode`、`/sandbox`、`/network`、`/reasoning`、全局 `/set`。 | `command-dispatch.test.ts`、`bridge-command-e2e.test.ts`、`config.test.ts` | `command-state` 覆盖 runtime 设置并带命令级飞书文本断言；`session-management` 覆盖 `/set` |
| 自动任务 | `/auto` 创建/列表/删除和 auto card 回调。 | `bridge-command-e2e.test.ts`、`command-dispatch.test.ts` | `command-state` provider 矩阵通过真实飞书消息覆盖创建/列表/删除，并断言 created/list/deleted 文本 |
| Require-at 策略 | `/require-at on/off` 和非 mention 群消息过滤。 | `command-dispatch.test.ts`、`feishu-adapter.test.ts`、`bridge-command-e2e.test.ts` | `require-at-toggle` runtime-neutral 报告 |
| 流式和 mirror 交付 | SDK provider 使用直接 `im:` 卡片；pty/tmux provider 使用 `mirror:` 交付，且不重复最终文本；悬挂 mirror identity 按 runtime 清理。 | `interactive-turn-runner.test.ts`、`mirror-runtime.test.ts`、`turn-coordinator.test.ts`、`bridge-manager.test.ts` | `message-only`、`runtime-message`、`command-state`、`session-management` provider gate |
| Claude Code 集成 | Claude tmux 默认 provider、Claude pty onboarding/trust setup、CCR 激活、Claude JSONL 身份、Claude SDK query 路径。 | `claude-tmux-provider.test.ts`、`claude-pty-provider.test.ts`、`claude-sdk-provider.test.ts`、`real-claude-pty-provider.e2e.test.ts`、`claude-session-jsonl.test.ts` | Claude pty 报告使用真实 `ccr code` + fake backend；Claude SDK 报告使用 CCR-backed SDK env + fake backend；Claude tmux 真实飞书证据待补 |
| Codex 终端 provider | Codex pty/tmux 启动、prompt 注入、JSONL mirror 和清理。 | `codex-tmux-provider.test.ts`、`real-codex-pty-provider.e2e.test.ts`、`real-codex-tmux-provider.e2e.test.ts`、`bridge-command-e2e.test.ts` | Codex pty/tmux 报告要求 `mirror:` 输出和 tmux 清理 |
| 飞书 adapter | 消息发送、卡片更新/完成、reply threading、Markdown/card 渲染、事件过滤。 | `feishu-adapter.test.ts`、`feishu-adapter-card-e2e.test.ts`、`plain-markdown.test.ts`、`delivery-pipeline.test.ts` | 所有真实飞书报告都要求逐消息 `reply_to`；`card-forms` 覆盖 `/new-form` 作为 `interactive` CardKit 表单回复，并带 callback_data 前缀证据；`agent-question-forms` 覆盖模型生成的 `<clk-ask>` 问题表单和 `clk-agent-question` callback 前缀证据；`markdown-rendering::codex-pty` 和 `markdown-rendering::codex-tmux` 有最终 Markdown 表格/代码块结构的 canonical 飞书原始内容证据；表单场景尚未触发真实 submit callback 事件 |
| 诊断和清理 | 真实 E2E dump、bridge 日志、测试群创建/清理、测试 tmux 清理、过期锁处理。 | `real-feishu-e2e-harness.test.ts`、`service-manager.test.ts` | 每个成功真实飞书报告都 gate 群清理；`--create-chat` fallback 现在会推断或要求 bot app id，确保 lark-cli user 创建的群仍邀请 bridge bot；tmux 报告 gate 测试 tmux 清理 |
| UI 和服务管理 | 配置 UI 路由、通道配置、服务 start/stop/status、hot update。 | `ui-*.test.ts`、`service-manager.test.ts`、`command-dispatch.test.ts` | 主要依赖本地覆盖；只有 IM 可见的 hot-update dry-run/log 行为在本地覆盖 |
| 附件和 artifact | 出站 artifact、问题卡片/表单、云文档评论交付。 | `outbound-artifacts.test.ts`、`delivery-pipeline.test.ts` | 尚未由 canonical 真实飞书矩阵覆盖 |

## 当前真实飞书 Gate

只有 harness 在自动 gate 通过后写出非 failure JSON 报告，成功报告才有效。必需 gate 包括：

- `message_observations_passed`：每条已发送飞书消息都有预期的 bot `reply_to`，或在预期过滤时没有回复。
- `final_feishu_transcript_present`：最终 transcript 包含当前场景聊天中的相关 message id。
- `required_checks_passed`：选定路径的 binding/session/runtime identity/audit/provider 检查满足要求。
- `provider_output_path`：SDK 路径产生直接 `im:` 输出且没有 `mirror:`；pty/tmux 路径产生 `mirror:` 输出。
- `mirror_final_not_duplicated_in_direct_reply`：mirror provider 不把最终模型文本复制到直接状态回复中。
- `created_chat_cleanup_completed` 和 `scenario_created_chat_cleanup_completed`：harness 创建的聊天和 `/new` 场景创建的聊天都在成功时删除。
- `fake_ccr_backend_used`：fake CCR 场景证明 fake backend 确实收到模型请求。

## 缺口

当前 provider/scenario 矩阵已经较宽，但这些功能区域仍主要依赖本地测试：

- 历史边界：空历史、跨聊天隔离、长 transcript 截断和 `/his json`/`/his file` 附件现在已有合并的 `history-suite::codex-tmux` canonical 证据，报告为 `histsuite-codex-tmux-live-0858.json`。该报告证明组合命令计划和分阶段 A/B 预期，包括同一个 `/his` 命令字符串在不同阶段对应不同 expectation。较旧拆分场景仍有历史证据和本地回归辅助价值，但默认不应继续驱动完整 provider 矩阵活动。
- 非 final 命令回复中的最终文本断言：`command-state` 现在检查 status/settings/runtime/provider/current-state/auto 命令的语义文本；`session-management` harness 检查 help/config/new/cd/current/check 命令文本，codex-pty/codex-tmux 已有当前语义通过证据。旧 `session-management` 报告中的 codex-sdk/claude-pty/claude-sdk 仍只证明遗留 `reply_to` 证据，必须在新语义 gate 下重跑。一次 live `session-management::codex-sdk` 重跑证明命令链可以到达飞书和 `/his 5`，但因为 live bridge 仍为 SDK 发出 mirror stream，canonical provider-output gate 失败。旧 live `session-management::codex-tmux` 诊断失败已被 `session-codex-tmux-semantic-live-0550.json` 取代，该报告证明 mirror-stream final observation、`/his 5` marker、provider path 和双重清理。剩余命令密集型场景还需要对 `/clear`、`/t`、`/shell`、`/file`、permission 和 card callback 路径做同等处理。
- 附件和 artifact：图片/文件入站、出站附件、云文档评论回复路径和权限卡片。`card-forms` 覆盖命令生成的 `/new-form` CardKit 表单和 callback_data 前缀；`agent-question-forms` 现在覆盖 harness 矩阵中模型生成的 `<clk-ask>` 问题表单。两个场景都尚未证明真实 submit callback 事件。
- 飞书渲染：Markdown 表格和 fenced code block 现在已有 `markdown-rendering::codex-pty` 与 `markdown-rendering::codex-tmux` canonical 真实飞书通过证据；当前真实飞书 mirror/card transcript 会把 `ts` fence 规范化为 `plain_text`，因此 gate 检查代码 fence 保留和规范化后的语言。剩余 Markdown provider 路径、嵌套代码块、工具详情卡片、长流式更新和 mirror 控制通知仍主要依赖本地测试。
- 权限和恢复体验：缺少读消息权限、缺少删除权限、缺少事件订阅、bot 不在群里、重复 App 实例争抢。
- 服务/UI 操作：setup UI 和 service manager 行为主要依赖本地测试，因为它们不自然地由飞书聊天消息驱动。

## 下一批测试切片

`history-suite::codex-tmux` 已有 canonical 证据。下一批高价值切片是 `basic-dialogue-suite`，作为主要长流程集成测试。它的 harness metadata 和 dry-run plan 已描述一条 cross-provider 对话，本地 session simulator 已覆盖 `codex-sdk -> claude-sdk -> codex-tmux -> claude-pty -> codex-pty` 上可控的 preload/tool/context/goal/mirror-suppression 检查点。下一步是把该 simulator 接到真实飞书运行，并使用确定性模型输出。命令密集型 suite 应继续按 runtime 压缩。历史 suite 应保持以下 gate 作为回归准则：

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
