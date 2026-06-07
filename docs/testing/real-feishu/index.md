# 真实飞书 E2E

真实飞书 E2E 用来回答本地测试无法回答的问题：飞书事件是否投递到当前 bridge、bot 是否在群里、回复是否指向正确 `message_id`、卡片/文件/表单是否真的出现在飞书客户端，以及测试创建的聊天是否能清理。

它不是把每个单元测试翻译成飞书消息。内部 reducer、解析器、迁移、provider 命令构造和罕见错误分支仍由本地测试负责。

## 运行入口

场景目录和覆盖 metadata 的机器可读来源：

```bash
npm run real:feishu:e2e -- --list-scenarios
```

真实发送消息必须显式开启：

```bash
CODELARK_REAL_FEISHU_E2E=1 npm run real:feishu:e2e -- \
  --test-env-file ~/.codelark/test/real-feishu-e2e.test.env \
  --launch-bridge \
  --create-chat \
  --scenario runtime-message \
  --runtime claude \
  --provider pty \
  --fake-ccr \
  --run-id runtime-claude-pty-fake-ccr \
  --message "请只回复 fake CCR 响应"
```

脚本会在真正清理测试群、启动临时 bridge、创建群或发送消息前先运行 `lark-cli auth status --verify` 做用户授权 preflight。真实 E2E 的触发消息和验证读取都走 `lark-cli --as user`；如果使用 `--launch-bridge`，这个检查针对隔离的 `--runtime-home`，因此该 HOME/profile 也必须完成用户登录并具备 IM 发送、读消息、读群，以及按需建群和删群权限。

测试 App ID 和 Secret 放在测试专用 env 文件中，不写入正式 `~/.codelark/config.toml`，也不要通过 npm 参数传递 secret，避免命令回显：

```text
CODELARK_REAL_FEISHU_TEST_APP_ID=cli_xxx
CODELARK_REAL_FEISHU_TEST_APP_SECRET=xxx
CODELARK_REAL_FEISHU_TEST_SITE=feishu
```

云文档 doc-as-chat 需要单独的 from-scratch 验证，不应复用只从 IM 里发 `/new` 的场景。自动化入口是 `--scenario doc-as-chat-from-scratch`，完整说明见 [云文档 doc-as-chat from-scratch E2E 示例](doc-as-chat-from-scratch.md)：它必须新建云文档、以用户身份评论并结构化 @ bot、等待 bot 创建群聊、用 user 身份读取新群信息，在群里继续对话、断言 bot 拿到云文档上下文，并清理群聊和云文档。

## 覆盖原则

真实飞书 E2E 只覆盖高风险、用户可见边界：

- 飞书事件到达当前活跃 bridge 实例。
- Bot 在目标聊天中，并按正确 `message_id` 回复。
- 文本、卡片、表单、文件和 Markdown 原始内容符合用户契约。
- 输出路径符合 provider 预期：SDK 走直接 `im:`，pty/tmux 走 `mirror:`。
- 多聊天状态隔离，测试群和 `/new` 场景群能被清理。

新增覆盖优先使用高信息量 suite，而不是继续扩张完整 provider 矩阵：

- **必跑长流程**：`basic-dialogue-suite`，覆盖启动、provider 切换、权限/更新提示、工具调用、追加输入、goal/context 状态、停止和 SDK mirror 抑制。
- **代表性功能 suite**：例如 `history-suite`，用一个代表 provider 合并验证 `/his` 默认/raw/msg/limit/json/file、长截断和空历史隔离。
- **按 runtime 压缩的命令检查**：命令密集型场景只跑 Codex 和 Claude 两条路径；只有 tmux 专属命令额外跑 `codex-tmux`。
- **短冒烟**：`runtime-smoke` 只证明 provider 路径健康，不替代功能 suite。
- **遗留证据**：旧拆分 full-matrix 场景可用于诊断，不再驱动新扩张。

## 场景基线

| 场景 | 角色 | 维护要求 |
| --- | --- | --- |
| `basic-dialogue-suite` | 最高优先级长流程 | 下一步主线；应使用可控 session simulator 串起 `codex-sdk -> claude-sdk -> codex-tmux -> claude-pty -> codex-pty`。 |
| `runtime-smoke` | provider 路径健康检查 | 只在需要快速完整 provider 信号时运行。 |
| `session-command-suite` | 命令和会话管理 | 覆盖 `/status`、`/runtime`、`/p`、`/help`、`/set`、`/new`、`/cd`、`/current`、`/check`、`/t` 和一个最终 marker prompt。 |
| `history-suite` | 历史功能簇 | 当前 canonical 代表路径是 `real-feishu::history-suite::codex-tmux`，报告 `histsuite-codex-tmux-live-0858.json`。 |
| `card-form-suite` | 交互表单 | 覆盖 `/new-form` 和模型生成 `<clk-ask>`；只有 harness 能触发真实 `card.action.trigger` 时才断言 submit callback。 |
| `rendering-suite` | Markdown/卡片渲染 | 覆盖表格、代码块、长流式卡片完成和工具详情卡片形态。 |
| `permission-recovery-suite` | 运维恢复 | 诊断 bot 不在群、缺权限、重复 App 实例、清理失败等真实环境问题。 |
| `doc-as-chat-from-scratch` | 云文档入口验收 | 从零创建云文档和评论触发 `/new`，验证群聊创建、群内后续对话的文档上下文，以及群聊/文档清理；示例见 `doc-as-chat-from-scratch.md`。 |

当前仍可作为基线的代表性通过证据：

- `require-at-toggle`：`rat-cleanup-2014.json`。
- `message-only`：codex-sdk、codex-pty、codex-tmux、claude-pty、claude-sdk 均已有 canonical 报告。
- `runtime-message`：codex-sdk、codex-pty、codex-tmux、claude-pty、claude-sdk 均已有 canonical 报告。
- `command-state`：五条 runtime/provider 路径均已有 canonical 报告。
- `session-management`：当前语义 gate 已把 `/t` 纳入命令回复断言；已有 codex-pty 和 codex-tmux 证据早于 `/t` 单表 runtime 下拉卡片，codex-sdk、claude-pty、claude-sdk 旧报告也需要新 gate 重跑。
- `history-suite`：codex-tmux 已有代表性通过证据；拆分的 history 场景仅保留为诊断和局部回归参考。
- `markdown-rendering`：codex-pty 与 codex-tmux 已有真实飞书 Markdown 表格和代码块证据。

## 成功报告标准

成功报告必须由自动 gate 写出；gate 失败只能写 `.failure.json`，不能人工解释为通过。

必需检查：

- `message_observations_passed`：每条用户消息都有预期 bot `reply_to`，或过滤场景明确没有回复。
- `final_feishu_transcript_present`：最终飞书 transcript 存在，并包含本轮发送的 message id。
- `required_checks_passed`：binding、session、runtime identity、audit、provider 输出路径等 required checks 全部满足。
- `provider_output_path`：SDK/direct 路径出现 `im:` 且不出现 `mirror:`；pty/tmux/mirror 路径出现 `mirror:`。
- `mirror_final_not_duplicated_in_direct_reply`：mirror provider 的最终业务文本不能同时出现在 direct `reply_to` 状态卡中。
- `created_chat_cleanup_completed`：harness 创建的测试群成功清理，除非显式 `--keep-group`。
- `scenario_created_chat_cleanup_completed`：场景命令额外创建的群也要清理。
- `doc_as_chat_context_assertion`：云文档 from-scratch 场景必须证明后续群内 bot 回复包含绑定文档的 `file_type`、`file_token` 和文档 marker；只证明建群不算通过。
- `created_document_cleanup_completed`：云文档 from-scratch 场景创建的测试文档必须删除，除非失败运行明确保留诊断资源。
- `create_chat_bot_invited`：`--create-chat` 必须能确定 bot app id，不能创建没有 bot 的空群。
- `fake_ccr_backend_used`：`--fake-ccr` 场景必须证明 fake backend 收到请求，并且最终 bot 回复包含 fake marker。

场景级断言只记录用户可见契约，不重复展开每个历史拆分场景：

- 命令场景必须检查命令级语义文本，不能只检查有 `reply_to`。
- mirror provider 的 final prompt 必须先观察本次 `mirror:` stream，并等待 mirror card `completed` 后再发送历史 follow-up。
- `/his json` 和 `/his file` 必须返回飞书 file message，并包含真实 `file_key` 或 lark-cli 规范化后的 `<file key="file_v...">`。
- 空历史和跨群隔离必须同时检查空态文案和 forbidden marker。
- 长历史截断必须同时检查头部 marker、ASCII 截断标记 `...`，并排除尾部 marker。
- 表单场景必须检查飞书 `interactive` 消息和 CardKit form/callback 前缀字段；看到文本 fallback 不算通过。
- Markdown 渲染以飞书原始消息为准；当前 code fence 语言可能被规范化为 `plain_text`。

## 排障流程

真实 E2E 失败时不要只等待超时。按下面顺序主动读取证据：

1. 读取飞书群消息，确认用户消息和 bot 回复：
   ```bash
   unset NODE_OPTIONS
   npx lark-cli im +chat-messages-list --chat-id <oc_xxx> --page-size 20 --format json
   ```
2. 检查 bridge 日志是否收到事件并发出请求：
   - `CODELARK_HOME/logs/bridge.log`（结构化 JSONL，一行一条日志）
   - 关键日志：`msg` 或 `event` 中的 `Started adapter`、`Bridge started`、`ws client ready`、对应飞书事件名；优先看 `level=ERROR/WARN`
3. 检查 `CODELARK_HOME/data`：
   - `data/audit.jsonl`
   - `data/audit.json`（legacy 数组，存在时也要一起看）
   - `data/channel-chats.json`
   - `data/sessions.json`
4. 判断 runtime 实际卡点：Claude Code 欢迎页、trust prompt、权限卡、JSONL mirror、模型响应或错误文本。
5. 如果读取群消息失败，优先检查飞书应用是否有“读取群组中所有消息”权限；没有该权限时不能声称真实 E2E 通过。
6. 确认同一个 Feishu App ID 只有一个 bridge 长连接实例，避免事件投递随机进入另一实例。
7. 修改飞书权限或事件订阅后，需要重新发布/应用配置，再重启临时 bridge。

Claude/CCR 场景额外要求：

- bridge 日志应出现 `Route Claude Code request`，且 executable 是 `ccr`。
- 如果群里返回 Claude Code 欢迎页、安全提示或 trust prompt，说明 Claude Code TUI provider（tmux 默认路径或显式 pty）还没有完成 onboarding，不能算 runtime 响应通过。
- `--fake-ccr` 必须配合 `--launch-bridge` 使用；它只会给 harness 启动的隔离 bridge 写入 fake CCR 配置，不能注入已运行的 live bridge。

## lark-cli 与清理注意事项

- 真实飞书 E2E 必须按用户视角闭环：用 `lark-cli --as user` 发出触发消息后，再用 `lark-cli --as user` 拉取群消息、群成员/群信息或云文档评论验证结果。只看本地 store、bridge log、mock adapter 调用或 bot 身份读数不算完整 E2E。
- `im +messages-send` 不支持 `--format`。
- `im +chat-messages-list` 支持 `--format json`，但需要足够的消息读取权限。
- 删除测试群优先使用 lark-cli user；失败时再尝试测试 App user token，最后用 bot OpenAPI 兜底。
- 如果 lark-cli 删除提示缺权限，运行：
  ```bash
  lark-cli auth login --scope "im:chat im:chat:delete"
  ```
- 失败运行默认保留测试群、failure report 和日志，排查后再显式删除。
- 测试群 registry 默认在系统临时目录 `codelark-real-feishu-e2e-chats.json`；不要放在真实 `~/.codelark` 下，避免污染 live bridge 工作目录。

## 本地目录隔离

- `npm test` 会把 `CODELARK_HOME`、`CODEX_HOME`、`CODELARK_CLAUDE_HOME`、`HOME` 和 `USERPROFILE` 指到 `/tmp/codelark-test-*`。
- 真实飞书 harness 的 bridge 子进程使用 `--run-root` 下的隔离 `codelark-home`、`codex-home`、`runtime-home` 和 `claude-home`。
- 如果不传 `--launch-bridge`，harness 只驱动当前 live bridge；此时必须显式传 `--clk-home ~/.codelark` 或对应 live `CODELARK_HOME`。
- 复用本机 Codex/Claude/CCR 登录状态时，只把认证文件或配置目录以符号链接接入隔离 runtime home；测试写入应发生在隔离 home 中。

## 下一步

1. 继续把 `basic-dialogue-suite` 做成主线长流程，并接入真实飞书 session simulator/确定性模型输出。
2. 命令密集型 suite 保持按 runtime 压缩，不再扩张完整 provider 矩阵。
3. 保留 `history-suite::codex-tmux` 作为历史功能簇主线证据，旧拆分 history 场景只做定向回归。
4. 继续补表单 submit callback、附件 ingestion、权限失败恢复、tool detail card 和更多跨群生命周期场景。
