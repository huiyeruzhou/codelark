# 真实飞书 E2E

真实飞书 E2E 用来回答本地测试无法回答的问题：飞书事件是否投递到当前 bridge、bot 是否在群里、回复是否指向正确 `message_id`、卡片/文件/表单是否真的出现在飞书客户端，以及测试创建的聊天是否能清理。

它不是把每个单元测试翻译成飞书消息。内部 reducer、解析器、迁移、provider 命令构造和罕见错误分支仍由本地测试负责。

## 运行入口

场景目录和覆盖 metadata 的机器可读来源：

```bash
npm run real:feishu:e2e -- --list-scenarios
```

已有报告的机器可读覆盖矩阵：

```bash
npm run real:feishu:e2e -- --coverage-matrix --reports-dir work/real-feishu
```

该矩阵按 `scenario/testName` 输出 planned、dry-run、diagnostic failure/pass、legacy pass 和 canonical pass，并在 `coverageRates` 中输出覆盖率。评审真实飞书 E2E 覆盖时看 `canonicalPercent = canonical-pass / total`；`dry-run`、`diagnostic-*` 和 legacy failure 只能作为计划或排障证据，不能计入覆盖率。`executedPercent` 只是辅助数字，表示该 slice 已有任意真实执行或诊断工件。评审 Kimi 覆盖时优先看 `coverageRates.kimiCurrent`、`coverageRates.kimiCurrentTmux`、`summary.kimiCurrentCanonicalPass` 和 `kimiCurrentGaps`；gap 会带 `reportPath`、`runId` 和 failed/missing canonical checks，没有任何报告的 planned-only gap 也会列出该场景必须补齐的 canonical checks。`unmatchedReports` 表示旧 failure 报告缺少 `coverage.testName`，只能作为诊断证据，不能计入 canonical 覆盖。新的 failure report 会写入 `scenario`、`runtime`、`provider` 和 `coverage.testName`，避免失败证据丢在矩阵之外。

聚合当前三份 Kimi canonical 报告后的关键覆盖率是：全量 3/70 = 4.3%，current 非 legacy 3/46 = 6.5%，current tmux 3/29 = 10.3%，Kimi current 3/8 = 37.5%，Kimi current tmux 3/7 = 42.9%。卡片前端 current 切片是 1/26 = 3.8%，卡片前端 current tmux/runtime-neutral 切片是 1/17 = 5.9%；这些卡片切片覆盖 stream/final card、`/t` rich card、文件确认卡、CardKit 表单、agent question form 和 Markdown card。报告目录是本地证据输入，评审时应重新运行矩阵，不要只引用文档数字。

`canonical-pass` 不是报告自称 `canonicalEligibility.eligible=true` 就能获得。矩阵还会要求报告里有并通过公共真实飞书 gate：逐消息发送 observation、最终 Feishu transcript 读取、coverage metadata、required dump/provider checks、mirror 异常检查和清理检查。Kimi current 条目还必须有 Kimi runtime identity、`kimi_wire_jsonl_found`、provider output path、mirror final 去重，以及对应场景的 transcript gate；例如 `command-state` 还要求 runtime/settings 与 file/large-file transcript gate，`basic-dialogue-suite` 还要求 Kimi 单进程 session 生命周期、`Ctrl-S` steer、wire transcript、history transcript 和 thinking/status 隔离 gate。缺少这些 evidence 的 success JSON 会被降级为 `diagnostic-pass`，不能计入 Kimi canonical。

验收 Kimi 主线场景时使用硬 gate：

```bash
npm run real:feishu:e2e -- --coverage-matrix --reports-dir work/real-feishu --require-canonical kimi-current
```

`--require-canonical kimi-current` 会检查当前主线 Kimi 条目，排除 `legacy-transitional-evidence` 的旧拆分历史场景；`--require-canonical kimi` 则检查全量 Kimi 条目。当前报告目录下该命令应当失败，但 `message-only::kimi-tmux` 和 `runtime-message::kimi-tmux` 已有 canonical 成功报告；`basic-dialogue-suite` 当前是诊断失败，剩余未跑出 canonical 的 current 条目是 `command-state`、`session-management`、`history-suite`、`agent-question-forms` 和 `markdown-rendering`。

真实发送消息必须显式开启：

```bash
CODELARK_REAL_FEISHU_E2E=1 npm run real:feishu:e2e -- \
  --test-env-file ~/.codelark/test/real-feishu-e2e.test.env \
  --launch-bridge \
  --scenario runtime-message \
  --runtime claude \
  --provider tmux \
  --fake-ccr \
  --run-id runtime-claude-tmux-fake-ccr \
  --message "请只回复 fake CCR 响应"
```

脚本会在真正清理测试群、启动临时 bridge、创建群或发送消息前先运行 `lark-cli auth status --verify` 做用户授权 preflight。真实发送必须使用 `--launch-bridge` 启动隔离 bridge；触发消息、验证读取和测试群清理走当前测试账号的 `lark-cli --as user` 授权环境，不把 user token 复制到隔离 bridge HOME。未传 `--chat-id` 时，harness 会直接复用产品 `/new` 背后的 new-session use case 创建初始测试群，走同一套 adapter `createGroupChat`、ownerUserId、binding、审计和建群通知逻辑；不保留 `--create-chat`、`--source-chat-id` 或 lark-cli 直接建群兼容路径。生产 `/new` 和云文档 `/new` 也必须能确定当前操作者 open_id，否则直接拒绝建群，避免创建用户无法管理的 bot-owned 群。

当 host 机器上的 `lark-cli` 已经对同一个 test app 完成用户授权时，harness 会直接使用该授权环境完成用户侧动作，让“当前账号作为测试、只换隔离 bridge”的路径不需要重复授权。bridge 侧不再维护任何私有 lark-cli runtime：隔离 bridge 不注入 `LARK_CHANNEL_CONFIG` / `LARKSUITE_CLI_CONFIG_DIR`，也不读写用户侧 lark-cli 授权；专用 CI 测试账号可以按下文迁移到 GitHub Secrets；本地与 CI 必须串行使用，避免同时刷新同一个登录态。

启动隔离 bridge 时，测试 App 不能和任何正在运行的 CodeLark bridge 使用同一个 Feishu App。飞书长连接消息采用集群随机分流而不是广播；同一个 App 同时跑两个 bridge 时，一组用户消息可能被不同实例拆分消费。harness 会在发送前检查当前用户目录下所有 `.codelark*` 实例的运行状态和 App ID；Linux 还会从存活进程声明的 `CODELARK_HOME` 补充候选，因此 `/tmp` 下手动启动的隔离 bridge 也不能漏过。补 canonical 报告时应使用真正空闲的测试 App，或由实例所有者明确停止/切走冲突 bridge；不提供跳过同 App 检查、重发消息或增加等待的兼容开关。

回复证据只剔除明确的用户回显行或整条纯回显，不能把原始命令字符串从整张机器人卡片中全局删除；`/new`、`/set` 等帮助卡会合法重复命令本身。`card-forms` 这类 runtime-neutral 场景只要求命令卡、`reply_to` 和客户端可见结构，不要求虚构 runtime identity 或模型消息来满足通用 dump check。

测试 App ID 和 Secret 放在测试专用 env 文件中，不写入正式 `~/.codelark/config.toml`，也不要通过 npm 参数传递 secret，避免命令回显：

```text
CODELARK_REAL_FEISHU_TEST_APP_ID=cli_xxx
CODELARK_REAL_FEISHU_TEST_APP_SECRET=xxx
CODELARK_REAL_FEISHU_TEST_SITE=feishu
```

如果 test app 的 user OAuth 放在独立 lark-cli HOME，而不是当前 shell 的默认 `~/.lark-cli`，可以在同一个 env 文件里显式声明用户侧 lark-cli 环境；harness 会用这些路径运行 preflight、发消息、读消息、建群和删群，但不会复制 user token。这里的 `LARKSUITE_CLI_CONFIG_DIR` 是 lark-cli 原生的配置目录覆盖能力，只作用于 harness 的用户侧命令，与 bridge 无关：

```text
CODELARK_REAL_FEISHU_AUTH_HOME=/home/me/.codelark/real-feishu-e2e/test-app-auth
CODELARK_REAL_FEISHU_TEST_LARK_CLI_CONFIG_DIR=/home/me/.codelark/real-feishu-e2e/test-app-auth/.lark-cli
CODELARK_REAL_FEISHU_TEST_LARK_CLI_XDG_DATA_HOME=/home/me/.codelark/real-feishu-e2e/test-app-auth/.local/share
```

云文档 doc-as-chat 需要单独的 from-scratch 验证，不应复用只从 IM 里发 `/new` 的场景。自动化入口是 `--scenario doc-as-chat-from-scratch`，完整说明见 [云文档 doc-as-chat from-scratch E2E 示例](doc-as-chat-from-scratch.md)：它必须新建云文档、以用户身份评论并结构化 @ bot、等待 bot 创建群聊、用 user 身份读取新群信息，在群里继续对话、断言 bot 拿到云文档上下文，并清理群聊和云文档。

## app-server 的本地与 CI 验证

本地使用相同的真实飞书 harness，加 `--codex-app-server`。此选项为 `runtime-message` / `message-only` / `app-server-lifecycle` 启动独立的真实 Codex app-server 和确定性本地模型；Bridge 的 `CODEX_HOME` 与后端一致。用户消息仍经过飞书入站事件，最终内容仍以用户身份从飞书读取，新增 `app_server_backend_used` 检查绑定的 endpoint、真实 loaded thread 与模型请求。报告的 testName 带 `::app-server`，不计作旧 SDK/TUI 的运行证据。

```bash
CODELARK_REAL_FEISHU_E2E=1 npm run real:feishu:e2e -- \
  --test-env-file ~/.codelark/real-feishu-e2e/test.env \
  --launch-bridge --codex-app-server --runtime codex --provider tmux \
  --scenario runtime-message --run-id app-server-local
```

`.github/workflows/real-feishu.yml` 提供手动触发的 GitHub Actions 工作流，依次验证 direct（`sdk` 入口）和 mirror（`tmux` 入口）。CI 复用已经在本地授权的专用测试账号，不再为每次运行要求扫码。仓库需要 `FEISHU_E2E_APP_ID`、`FEISHU_E2E_APP_SECRET` 和 `FEISHU_E2E_LARK_AUTH_B64` 三个 Secrets。

在已授权的专用测试目录执行下面命令即可更新登录态 Secret。脚本先核验身份，只打包单一测试 App/用户的配置、加密凭据和对应密钥，通过 stdin 传给 `gh secret set`，不会把凭据打印到终端或写进仓库：

```bash
python3 scripts/ci/feishu-auth.py publish \
  --home ~/.codelark/real-feishu-e2e/test-app-auth \
  --app-id <测试AppID> --repo <owner/repo>
```

Runner 在临时目录恢复登录态，核验实际 App/用户后执行真实飞书测试。每轮结束缓存 CLI 刷新后的**加密用户凭据文件**，供后续运行续用；解密密钥只随 Secret 恢复，不进入缓存或 artifact。更新 Secret 会自动切换缓存代次，避免复用旧登录态。测试失败后仍保留已成功核验的刷新状态，并清理 runner 临时授权目录。授权被用户撤销或 refresh token 最终失效时，需要在专用测试目录重新登录并更新 Secret。

同一个测试 App 的本地与 CI 运行必须串行，不能与其余 Bridge 同时使用。CI concurrency 约束 CI 内的运行，本地仍执行活跃 Bridge 冲突检查；进程环境扫描限制为 Node 进程。需要重新从本地发布授权时，先确认没有正在运行的 CI；迁移后以 CI 最新刷新状态为准，本地旧副本失效时不可覆盖 CI 的有效状态。原生协议、审批回放及 macOS/Desktop 共享后端测试在 `codex-desktop.yml` 中独立运行。

协议路径的 `/p tmux` 验证“共享线程已就绪、可直接发送消息”，随后以真实模型执行和消息回读确认可用；旧路径仍验证原 Provider 切换结果。本地真实飞书验收已通过 tmux 18 项、sdk 17 项检查，模型依赖为隔离的确定性响应服务，Codex 与飞书边界均为真实执行。

这里的真实飞书场景目前覆盖用户入站、协议执行、最终投递和消息回读。完整生命周期使用下面的独立故事验收；真实审批按钮点击与 Desktop GUI 分别报告，不能用 payload 或模拟 callback 冒充真实操作。

### 完整 app-server 生命周期故事

`app-server-lifecycle` 在 SDK/direct 与 tmux/mirror 两个入口运行同一条故事：真实用户配置与输入、模型运行中追加到原 turn、`/stop` 的原生 `interrupted` 与飞书卡片终态、`/clear` 新 thread、`/new` 产品路径新群、配置继承、Bridge 重启续用原 thread 且不重复发送（同时比对两个群的新增机器人消息，空 mirror 卡也算重复）、原生 Codex 问答与真实用户文字回答，最后进入原生审批步骤。

```bash
CODELARK_REAL_FEISHU_E2E=1 node --import tsx scripts/real-feishu-e2e.ts \
  --test-env-file ~/.codelark/real-feishu-e2e/test.env \
  --launch-bridge --codex-app-server --runtime codex --provider sdk \
  --scenario app-server-lifecycle --run-id lifecycle-sdk \
  --run-root /tmp/clk-real-feishu-life-sdk \
  --output /tmp/codelark-feishu-lifecycle-acceptance/sdk.json
```

完成后换 `--provider tmux` 与新的 run ID/root 串行执行。Codex 和飞书均为真实边界，只有模型使用不转发请求的 `startFixtureModel.enqueue`。隔离 Codex 配置开启原生 `default_mode_request_user_input` feature，以便普通模式提供问答工具；不修改用户的 Codex 配置。观察连接只订阅和读取线程，不提交输入或处理审批；Bridge 重启时观察连接也断开，避免替 Bridge 保持旧订阅。

真实飞书 CI 固定 Codex `0.153.4`，与本地完整故事一致。隔离 `models_cache.json` 仅提供 `/model` 菜单，不提供原生工具 metadata；`0.160` 已删除 gpt-5.4 的工具目录，因此升级前需同时选择该版本实际支持工具的模型并重新验证完整故事。

默认自动步骤会产生真实原生命令审批卡片并由用户身份回读，随后通过真实 `/stop` 取消；`approval.status=unverified`，`acceptanceComplete=false`。这表示自动部分通过，**不表示真实点击已验收**。报告中的 `approval.chatUrl` 可打开保留的测试群查看卡片。要验收点击，重新运行时增加 `--approval-wait-ms 300000 --require-approval`，在报告显示 `waiting` 时打开群并从真实飞书客户端点击允许；等待期间本次 Bridge 和原生后端保持存活，`approval.deadline` 给出截止时间；真实飞书 callback 入站日志、命令执行成功、原生轮次完成和最终用户回读均成立才算通过。等待超时会明确记录未验收，要求审批的运行返回非零。

报告持续落盘，失败时保留阶段、用户消息 ID、线程/轮次、配置快照、原生事件和最终用户回读。`automaticPassed` 与 `acceptanceComplete` 分开：CI 默认先检查自动部分，真实点击是独立的人工验收项。此场景保留测试群供核对；没有执行任何伪造 callback、额外扫码或凭据发布。测试进程只停止自身 Bridge/fixture 和对应隔离 tmux socket。

## 覆盖原则

真实飞书 E2E 只覆盖高风险、用户可见边界：

- 飞书事件到达当前活跃 bridge 实例。
- Bot 在目标聊天中，并按正确 `message_id` 回复。
- 文本、卡片、表单、文件和 Markdown 原始内容符合用户契约。
- 输出路径符合 provider 预期：SDK 走直接 `im:`，tmux 走 `mirror:`。
- 多聊天状态隔离，测试群和 `/new` 场景群能被清理。

新增覆盖优先使用高信息量 suite；是否跑完整 runtime/provider 矩阵由各场景的 `providerCoverage` 决定：

- **必跑长流程**：`basic-dialogue-suite`，覆盖启动、provider 切换、权限/更新提示、工具调用、追加输入、goal/context 状态、停止和 SDK mirror 抑制。
- **历史功能 suite**：`history-suite` 合并验证 `/his` 默认/raw/msg/limit/json/file、长截断和空历史隔离，并进入包含 `kimi-tmux` 的 runtime/provider 矩阵。
- **按 runtime 压缩的命令检查**：命令密集型场景按 Codex、Claude 和 Kimi runtime 压缩；只有 tmux 专属命令额外跑代表性 tmux provider。
- **短冒烟**：`runtime-smoke` 只证明 provider 路径健康，不替代功能 suite。
- **遗留证据**：旧拆分 full-matrix 场景可用于诊断，不再驱动新扩张。

## 场景基线

| 场景 | 角色 | 维护要求 |
| --- | --- | --- |
| `basic-dialogue-suite` | 最高优先级长流程 | 使用 `--scripted-basic-dialogue --launch-bridge` 时，通过隔离 Codex Responses proxy、CCR fake backend 和 fake Kimi executable 串起 `codex-sdk -> claude-sdk -> kimi-tmux -> codex-tmux`，不依赖 live bridge 或宿主 Kimi 会话；Kimi 阶段还必须在非 final 流式状态区 checkpoint 中出现「当前思考」，且 completed final card 不能泄漏 thinking 文本，证明 fresh Kimi 只执行一次不带 `-r` 的启动、没有 Ctrl-C bootstrap、从 TUI 保存 fake CLI 生成的 session id，随后对用户输入发送 Ctrl-S steer，并证明 `ChannelChat.runtimeBridgeSessionIds.kimi` 保留独立 Kimi `BridgeSession`、能定位同一个 `wire.jsonl`，从该 transcript 读回本轮 think、marker 文本和 `step.end`，且历史 transcript 读取只返回 marker 正文、不返回 thinking/status 内容。 |
| `runtime-smoke` | provider 路径健康检查 | 只在需要快速完整 provider 信号时运行。 |
| `session-command-suite` | 命令和会话管理 | 覆盖 `/status`、`/runtime`、`/p`、`/help`、`/set`、`/new`、`/cd`、`/current`、`/check`、`/t` 和一个最终 marker prompt。 |
| `history-suite` | 历史功能簇 | 进入 runtime/provider 矩阵；当前已有 canonical 报告是 `real-feishu::history-suite::codex-tmux` 的 `histsuite-codex-tmux-live-0858.json`，`kimi-tmux` 仍需真实飞书重跑。 |
| `card-form-suite` | 交互表单 | 覆盖 `/new-form` 和模型生成 `<clk-ask>`；只有 harness 能触发真实 `card.action.trigger` 时才断言 submit callback。 |
| `rendering-suite` | Markdown/卡片渲染 | 覆盖表格、代码块、长流式卡片完成和工具详情卡片形态；保留“历史记录”容器，单工具内部不得再嵌套折叠，标题使用动作图标并由代码拼成单行，展开后保留真实 command/patch。多文件 patch 必须按文件后缀生成独立语言块并共享总预览预算；只有正文含字面 `${...}` 的单个块才以缩进代码保持多行和原字符。 |
| `codex-runtime-error` | Codex TUI 异常终态 | 用隔离 custom Responses provider 返回真实 HTTP 400；直接向窄 tmux TUI 提交后不再发送消息，验证 0.144.3 rollout 无 error 字段时仍只生成一个 error 卡，streaming 关闭，footer 同时保留完整 type/message、耗时和可用的 context。历史方块、重叠 checkpoint 和批量 turn 不得错归。 |
| `permission-recovery-suite` | 运维恢复 | 诊断 bot 不在群、缺权限、重复 App 实例、清理失败等真实环境问题。 |
| `doc-as-chat-from-scratch` | 云文档入口验收 | 从零创建云文档和评论触发 `/new`，验证群聊创建、群内后续对话的文档上下文，以及群聊/文档清理；示例见 `doc-as-chat-from-scratch.md`。 |

当前仍可作为基线的代表性通过证据：

- `require-at-toggle`：`rat-cleanup-2014.json`。
- `message-only`：Codex/Claude 五条历史 runtime/provider 路径已有 canonical 报告；`kimi-tmux` 已有真实飞书 canonical 报告 `work/real-feishu/real-feishu-message-only-kimi-tmux.json`，覆盖隔离 test app、隔离 bridge、Kimi auth/config 隔离复制、当前测试账号真实飞书发送/读取、Kimi `wire.jsonl`、provider output path 和 mirror final 去重。
- `runtime-message`：Codex/Claude 五条历史 runtime/provider 路径已有 canonical 报告；`kimi-tmux` 已有真实飞书 canonical 报告 `work/real-feishu/real-feishu-runtime-message-kimi-tmux.json`，覆盖 `/runtime kimi`、`/p tmux`、Kimi runtime identity 绑定、最终 transcript marker、Kimi `wire.jsonl`、provider output path 和 mirror final 去重。
- `command-state`：Codex/Claude 五条历史 runtime/provider 路径已有 canonical 报告；harness 现在也计划 `kimi-tmux`，并通过 `runtime_prompt_final_transcript_marker` 验证尾部 runtime prompt marker，通过 `command_state_runtime_settings_transcript` 从最终飞书 transcript 验证 runtime/settings 与 `/every` 回复，通过 `command_state_file_and_large_file_transcript` 验证小文件 `file` 回复和大文件 `interactive` 确认卡，但 Kimi 真实飞书 canonical 报告仍待跑。
- `kimi-tmux`：Kimi 目前已有本地 unit/workflow/mock-app 覆盖，并已有 `message-only`、`runtime-message` 与 `session-management` 三条真实飞书 canonical 报告；下一步重点是 `basic-dialogue-suite` 长流程。当前 `basic-dialogue-suite --scripted-basic-dialogue` 诊断失败卡在 Kimi 阶段前的 Codex SDK queued followup 收尾，报告为 `work/real-feishu/real-feishu-basic-dialogue-scripted-kimi.failure.json`。
- `session-management`：`kimi-tmux` canonical 报告 `work/real-feishu/kimi-session-management-real-cli-fake-20260729T211529Z.json` 使用真实 Kimi 0.29.2 和本地 OpenAI-compatible 假模型，完整验证 `/new` 新群切换、长群名截断、`/clear` 最终重命名、`/current`、`/check`、`/t`、解绑、runtime prompt、`/his`、`/t archive` 与双群清理。runtime/session/wire 检查必须在 `/t archive` 前取证；归档回复与最终群名仍在终态后从真实飞书读取。当前矩阵只维护 SDK/tmux；旧 PTY 报告仅作历史参考，不再属于发布 gate。
- `history-suite`：codex-tmux 已有通过证据；harness 现在计划完整 runtime/provider 矩阵并包含 `kimi-tmux`，并通过 `runtime_prompt_final_transcript_marker` 验证短历史 runtime prompt marker，通过 `history_suite_transcript_contract` 从最终飞书 transcript 验证短历史、json/file 附件、长截断和空历史隔离；拆分的 history 场景仅保留为诊断和局部回归参考。
- `markdown-rendering`：codex-tmux 已有真实飞书 Markdown 表格和代码块证据；harness 会对 Kimi tmux 等 runtime/provider 路径计划同一 transcript 结构 gate，并用 `runtime_prompt_final_transcript_marker` 兜底验证 Markdown marker 从最终 transcript 读回。

## 成功报告标准

成功报告必须由自动 gate 写出；gate 失败只能写 `.failure.json`，不能人工解释为通过。新的 failure report 顶层会写入 `failure.message`、`failure.name` 和可用时的 `failure.stack`/`failure.cause`，用于定位真实 thrown error；这些诊断字段不改变 canonical gate 判定。
`--dry-run` 会输出 `plannedSuccessCheckNames`，用于在 harness 自测里锁定真实 run 必须执行的发送后读取与成功 gate。

必需检查：

- `message_observations_passed`：每条用户消息都有预期 bot `reply_to`，或过滤场景明确没有回复。
- `final_feishu_transcript_present`：最终飞书 transcript 存在，并包含本轮发送的 message id。
- `runtime_prompt_final_transcript_marker`：所有需要 runtime output、final prompt 有稳定 marker、且没有更专门最终形态 gate 的场景，都必须从最终飞书 transcript 中读回该 marker；Kimi tmux 等 mirror provider 不能只证明 provider output 或 mirror 完成。`agent-question-forms` 使用专门的 CardKit 表单 gate，`basic-dialogue-suite` 使用多阶段状态/历史 gate。
- `required_checks_passed`：binding、session、runtime identity、audit、provider 输出路径等 required checks 全部满足。
- `provider_output_path`：SDK/direct 路径出现 `im:` 且不出现 `mirror:`；tmux/mirror 路径出现 `mirror:`。
- `mirror_final_not_duplicated_in_direct_reply`：mirror provider 的最终业务文本不能同时出现在 direct `reply_to` 状态卡中。
- `codex_runtime_error_terminal_card`：真实 Codex 0.144.3 + custom provider HTTP 400 必须证明直接 TUI 输入无需下一条消息即可终止 streaming；最终卡 footer 含完整 `type · message · elapsed`，窄终端换行不能截断 JSON，rollout 缺失 error 时由 checkpoint fallback 补齐且不能产生第二个错误块。
- `created_chat_cleanup_completed`：harness 创建的测试群成功清理，除非显式 `--keep-group`；失败报告也不能默认保留测试群。
- `scenario_created_chat_cleanup_completed`：场景命令额外创建的群也要清理。
- `doc_as_chat_context_assertion`：云文档 from-scratch 场景必须证明后续群内 bot 回复包含绑定文档的 `file_type`、`file_token` 和文档 marker；只证明建群不算通过。
- `created_document_cleanup_completed`：云文档 from-scratch 场景创建的测试文档必须删除，除非失败运行明确保留诊断资源。
- 初始测试群创建：未传 `--chat-id` 时必须通过产品 `/new` use case 创建，并能确定 bot app id 与操作者 open_id，不能创建没有 bot 或无法绑定到当前用户的空群。
- `fake_ccr_backend_used`：`--fake-ccr` 场景必须证明 fake backend 收到请求，并且最终 bot 回复包含 fake marker。
- `fake_kimi_backend_used`：`--fake-kimi` 场景必须证明本地 OpenAI-compatible backend 收到真实 Kimi Code 请求。
- `fake_kimi_real_executable_used`：`--fake-kimi` 场景必须记录非 scripted 的 Kimi executable 路径与可解析版本号；用脚本替换 `kimi` 不能满足该 gate。
- `basic_dialogue_scripted_kimi_lifecycle_and_ctrl_s`：scripted `basic-dialogue-suite` 必须证明 fresh Kimi fake executable 只记录一次不带 `-r` 的启动、零次用于发现 session 的 Ctrl-C、从 TUI 绑定 fake CLI 生成的 session id，以及至少一次 Ctrl-S steer。
- `basic_dialogue_kimi_runtime_slot_persisted`：scripted `basic-dialogue-suite` 必须证明聊天绑定的 Kimi runtime slot 指向独立 Kimi `BridgeSession`，且该 session 记录的 Kimi session id/cwd 能解析到 `wire.jsonl`。
- `basic_dialogue_kimi_wire_transcript_read`：scripted `basic-dialogue-suite` 必须从 Kimi runtime slot 的 `wire.jsonl` 读回本轮 scripted thinking、final marker text 和 `step.end`，不能只证明文件存在。
- `basic_dialogue_kimi_history_transcript_excludes_thinking`：scripted `basic-dialogue-suite` 必须从同一个 Kimi runtime slot 的历史 transcript 读取路径读回 final marker，并证明「当前思考」和 scripted thinking 文本不会进入历史正文。
- `basic_dialogue_kimi_thinking_status_only`：scripted `basic-dialogue-suite` 必须证明 Kimi thinking 只出现在非 final 流式状态区 checkpoint，completed final card 不包含「当前思考」或 thinking 文本。
- `agent_question_form_interactive_transcript`：`agent-question-forms` 必须从最终飞书 transcript 中读回 bot 的 `interactive` CardKit 问题表单，并匹配 `clk_choice`、`clk_input`、`submit_btn` 和 `clk-agent-question` callback 字段；Kimi tmux 等 mirror provider 不能只证明有 mirror 响应。
- `markdown_rendering_transcript_structure`：`markdown-rendering` 必须从最终飞书 transcript 中读回 Markdown marker、表格行、fenced code block 和飞书规范化后的 `plain_text` language tag；Kimi tmux 等 mirror provider 不能只证明有 mirror 响应。
- `command_state_runtime_settings_transcript`：`command-state` 必须从最终飞书 transcript 中读回 `/status`、`/require-at off`、`/runtime`、`/p`、`/current`、`/model`、`/mode`、`/provider`、`/sandbox`、`/network`、`/reasoning` 和 `/every` 创建/列表/取消回复；`/current` 必须展示当前 runtime 分栏、Provider、当前 agent，并在继承项中包含“跟随上层配置（当前：…）”的有效值。Kimi tmux 路径必须证明固定模式、不支持 Bridge 沙箱/网络，并正确展示 Thinking 模式。
- `command_state_file_and_large_file_transcript`：`command-state` 必须从最终飞书 transcript 中读回小文件 `/file` 的 `file` 消息和 `file_key`，以及超过 20 MB 文件的 `interactive` 确认卡、文件名、大小提示和 `clk-command` 字段；Kimi tmux 等路径不能只依赖命令发送计数或本地 store。
- `session_management_runtime_identity_transcript`：`session-management` 必须从最终飞书 transcript 中读回 `/current`、`/check` 和 `/t archive` 的 runtime identity/归档回复；Kimi tmux 路径必须证明 `/check` 暴露 `kimi_session_id` 与 `runtime_cwd`，且 `/t archive` 归档的是本地 Kimi Code 会话。
- `history_suite_transcript_contract`：`history-suite` 必须从最终飞书 transcript 中读回 A 群短历史 `/his raw 1`、`/his`、`/his msg 1`、`/his json`、`/his file`，长历史 `/his raw 2`、`/his msg 2` 的头部 marker 与截断标记，并读回 B 群空历史文案且排除 A 群 marker；Kimi tmux 等 mirror provider 不能只依赖逐消息 observation metadata。

场景级断言只记录用户可见契约，不重复展开每个历史拆分场景：

- 命令场景必须检查命令级语义文本，不能只检查有 `reply_to`。
- mirror provider 的 final prompt 必须先观察本次 `mirror:` stream，并等待 mirror card `completed` 后再发送历史 follow-up。
- `/his json` 和 `/his file` 必须返回飞书 file message，并包含真实 `file_key` 或 lark-cli 规范化后的 `<file key="file_v...">`。
- 空历史和跨群隔离必须同时检查空态文案和 forbidden marker。
- 长历史截断必须同时检查头部 marker、ASCII 截断标记 `...`，并排除尾部 marker。
- 表单场景必须从 user 身份的飞书 transcript 检查 `interactive` 消息、`<form>` 结构、可见字段标签和提交按钮；看到文本 fallback 不算通过。`lark-cli` 会把 CardKit 内部 `name` / `callback_data` 规范化成用户可见文本，因此不得从 transcript 反向断言 `clk_form` 等内部键仍存在；机器字段和 callback 前缀由发送前 CardKit payload 合同测试检查，真实 callback 语义由用户点击后的 bridge 事件与持久状态证明。
- Markdown 渲染以飞书原始消息为准；当前 code fence 语言可能被规范化为 `plain_text`。
- 工具详情不能只用 bridge 日志的 `markdown_previews` 验收，因为该日志会压缩空白。报告至少同时保存 CardKit payload checkpoint 和 user 身份读取的最终 transcript；结构上断言存在“工具调用组 → 单工具”，且单工具内部没有“长输出”面板。普通工具要断言 output 正文不进入卡片；长 patch 要断言原始 diff 先按字符/行双上限裁剪，多文件的所有 fence 合计也不能超过总预算，并分别匹配目标文件语言。长路径标题还必须命中一个完整闭合的 `` `文件名` 等 N 个文件`` token，不能出现省略号或奇数个反引号。普通反引号检查 closing fence；只有正文含字面 `${...}` 时才检查命中的完整 block 已变为缩进代码、仍为多行且没有零宽字符/entity，其他文件块仍应保持高亮。最终卡片不得含 `Script completed`、`Wall time` 或 `Success`。

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
- 如果群里返回 Claude Code 欢迎页、安全提示或 trust prompt，说明 Claude Code tmux provider 还没有完成 onboarding，不能算 runtime 响应通过。
- `--fake-ccr` 必须配合 `--launch-bridge` 使用；它只会给 harness 启动的隔离 bridge 写入 fake CCR 配置，不能注入已运行的 live bridge。
- `--fake-kimi` 必须配合 `--launch-bridge --runtime kimi --provider tmux` 使用；它通过 Kimi 官方 `KIMI_MODEL_*` 环境覆盖把真实 executable 指向本地假模型，不复制宿主 OAuth，也不替换 `kimi`。
- `--scripted-basic-dialogue` 只能配合 `basic-dialogue-suite` 和 `--launch-bridge` 使用；它会把 Codex Responses、CCR 和 Kimi executable 都隔离在本次 run root 下。
- 接受 `basic-dialogue-suite --scripted-basic-dialogue` canonical 报告前，先检查报告 JSON：`canonicalEligibility.eligible` 必须为 `true`，`automatedSuccessChecks` 必须包含通过的 `canonical_report_eligible`，`runRoot` 必须是本次临时目录，`codelarkHome`、`runtimeEnvironment.runtimeHome`、`runtimeEnvironment.codexHome` 和 `runtimeEnvironment.kimiHome` 都必须位于该 `runRoot` 下，且 Kimi executable 来源应为 `scripted-fake-executable`。任何显示 `codelarkHome=/home/*/.codelark`、`codexHome=/home/*/.codex` 或 `kimiHome=/home/*/.kimi-code` 的报告都只能作为诊断，不算 canonical。

## lark-cli 与清理注意事项

- 真实飞书 E2E 必须按用户视角闭环：用 `lark-cli --as user` 发出触发消息后，再用 `lark-cli --as user` 拉取群消息、群成员/群信息或云文档评论验证结果。只看本地 store、bridge log、mock adapter 调用或 bot 身份读数不算完整 E2E。
- `im +messages-send` 不支持 `--format`。
- `im +chat-messages-list` 支持 `--format json`，但需要足够的消息读取权限。
- 未传 `--chat-id` 的主测试群必须通过产品 `/new` use case 创建，dry-run 会输出 `initialChatCreation=product-new-session-use-case`；harness 不再提供 lark-cli 直接建群或 source-chat 发送 `/new` 的兼容入口。
- 删除测试群优先使用 lark-cli user；失败时再尝试测试 App user token，最后用 bot OpenAPI 兜底。
- 如果 lark-cli 删除提示缺权限，运行：
  ```bash
  lark-cli auth login --scope "im:chat im:chat:read im:chat:delete im:message.send_as_user im:message.group_msg:get_as_user im:message.p2p_msg:get_as_user"
  ```
- 失败运行默认保留 failure report 和日志，但不默认保留测试群；只有显式 `--keep-group` 才允许保留 harness 创建的群。
- 测试群 registry 默认在系统临时目录 `codelark-real-feishu-e2e-chats.json`；不要放在真实 `~/.codelark` 下，避免污染 live bridge 工作目录。

## 本地目录隔离

- `npm test` 会把 `CODELARK_HOME`、`CODEX_HOME`、`CODELARK_CLAUDE_HOME`、`KIMI_CODE_HOME`、`HOME` 和 `USERPROFILE` 指到 `/tmp/codelark-test-*`。
- 真实飞书 harness 的 bridge 子进程使用 `--run-root` 下的隔离 `codelark-home`、`codex-home`、`runtime-home` 和 `claude-home`；Kimi 的 `KIMI_CODE_HOME` 固定为 `<runtime-home>/.kimi-code`。需要稳定验证真实 CLI 时使用 `--fake-kimi`，不要依赖宿主订阅或 OAuth。
- 真实发送不允许省略 `--launch-bridge`，也不允许驱动当前 live bridge；`--dry-run`、`--list-scenarios`、`--dump-only` 和 `--stop-test-bridge` 只是计划、读取或清理辅助路径。
- 复用本机 Codex/Claude/CCR/Kimi 登录状态时，只把认证文件或配置目录以符号链接接入隔离 runtime home；测试写入应发生在隔离 home 中。

## 下一步

1. 继续用 `basic-dialogue-suite --scripted-basic-dialogue` 作为主线长流程，补真实飞书 canonical 报告，并保持 Codex/Claude/Kimi 都由隔离确定性模型或 fake executable 驱动。
2. 在已有 Kimi runtime smoke 与 session-management 代表路径基础上，补 `command-state` 和 `history-suite`。
3. 命令密集型 suite 保持按 runtime 压缩，不再扩张完整 provider 矩阵。
4. 用 `history-suite` 的 runtime/provider 矩阵补齐 Kimi/Claude/Codex 的同层历史功能簇证据，旧拆分 history 场景只做定向回归。
5. 继续补表单 submit callback、附件 ingestion、权限失败恢复、tool detail card 和更多跨群生命周期场景。


### 原生文件、权限与 MCP 卡片

真实飞书 CI 已启用此扩展；本地在 `app-server-lifecycle` 上增加 `--native-request-cards`，使用同一保留群验证 Codex 0.153.4 的文件 diff、额外权限、MCP 表单和 URL。模型仍由共享 fixture 编排，MCP 使用独立的本地 stdio helper。全部输入均由真实用户 CLI 发送，全部卡片由用户身份回读，观察连接不提交消息或审批答复。

自动模式先完成原有生命周期和命令审批收卡，再执行这些检查：

- MCP 表单：真实用户发送越界数字 `0`，确认产品拒绝且原生请求继续等待；发送上界 `3` 与 `false`，确认原生工具结果保留数字和布尔类型，并回读最终结果。
- 文件审批：真实 `apply_patch` 产生包含中文、尖括号、引号和嵌套代码围栏的多行 diff；对照对应的 `item/started` 与实际用户回读卡片，确认批准前和自动取消后文件均不存在。
- 额外权限：真实 `request_permissions` 请求单一隔离写入路径，用户回读卡片必须包含精确范围及“仅本轮允许”。
- MCP URL：真实服务端请求展示 `http://127.0.0.1:9/codelark-fixture` 本地测试链接与编码尖括号；不打开链接。自动模式用真实 `/stop` 取消原生轮次，真实“取消”按钮仍为未验收。

`nativeCards` 保存每种请求、原始卡片、群链接和验收状态。结合 `--approval-wait-ms` 时，原生命令审批通过后，在同群依次提示文件“允许”、权限“仅本轮允许”、URL“取消”；每一步保留活 Bridge 并公布截止时间，只有真实 callback 与对应原生结果、最终用户回读都成立才标记通过。文件步骤还检查真实文件内容，权限步骤核验本轮范围，URL 步骤核验原生取消结果。任何人工步骤超时即停止后续人工序列并标记未验收；不把 `/stop`、直接 RPC 或合成 callback 当成点击。
