# 测试方法与语义分层

本文说明当前测试体系应该怎样使用，以及 `src/__tests__` 下的测试如何按验证目标理解。测试已经按 owner 和验证强度分层，不再使用旧的平铺 `src/__tests__/*.test.ts` 结构。

当前测试目录已经按 `src/bridge`、`src/channels`、`src/runtime`、`src/operator-ui` 等源码 owner 组织，并按纯逻辑、本地 workflow、本地 mock app E2E、本地真实进程 E2E 和真实飞书 E2E 分层。本文作为测试入口和验证语义说明。

## 测试入口

所有 Node.js 命令按仓库约定使用 Node.js 24：

```bash
unset NODE_OPTIONS
source ~/.nvm/nvm.sh
nvm use 24
```

常用入口：

| 目的 | 命令 | 说明 |
| --- | --- | --- |
| 全量本地测试 | `npm test` | 通过 `scripts/run-tests.js` 递归发现 `src/__tests__/**/*.test.ts` 并串行运行。脚本会创建临时 `HOME`、`CODELARK_HOME`、`CODEX_HOME`、`CODELARK_CLAUDE_HOME`、`KIMI_CODE_HOME` 和 `USERPROFILE`，避免污染真实 bridge 与真实 Codex/Claude/Kimi home。 |
| 纯逻辑单测 | `npm test -- --unit` | 只运行 `src/__tests__/unit/`。 |
| 本地 workflow | `npm test -- --workflow` | 只运行 `src/__tests__/workflow/`。 |
| 本地 mock app E2E | `npm test -- --mock-e2e` | 只运行 `src/__tests__/e2e/mock-app/`。 |
| 本地真实进程 E2E | `npm test -- --local-e2e` | 只运行 `src/__tests__/e2e/local-process/`。Codex/Claude 覆盖真实 CLI 或 tmux 进程；Kimi 用真实 executable + 真 tmux + 本地 fake model proxy。Cursor 的 `real-cursor-agent-bridge.e2e.test.ts` 必须显式设置 `CODELARK_REAL_CURSOR_E2E=1`，否则即使文件被选中也会 skip；它使用已登录官方 backend，并隔离 config/data/workspace 验证超过 30 秒的冷启动、可见进度、冷接管和 resume。默认使用 `gpt-5.3-codex`，可用 `CODELARK_REAL_CURSOR_E2E_MODEL` 覆盖。 |
| Harness 自测 | `npm test -- --harness` | 只运行 `src/__tests__/harness/`，包括真实飞书 harness 自测和测试环境隔离 guard。 |
| 类型检查 | `npm run typecheck` | 验证 TypeScript 类型和公共导入边界。 |
| 构建验证 | `npm run build` | 验证发布构建入口和 esbuild 打包。 |
| 文档验证 | `npm run docs:build` | 验证 VitePress 文档链接、导航和 Markdown 构建。 |
| Setup wizard / lark-cli 真实本地 E2E | `CODELARK_SETUP_WIZARD_REAL_E2E=1 npm run real:setup-wizard:e2e -- ...` | 用真实 `lark-cli config init --app-id ... --app-secret-stdin` 在临时 `HOME` 下写入 `~/.lark-cli/config.json` 和本地加密 secret，再验证 setup wizard 能通过 lark-cli 配置回读 secret，并验证 CodeLark 写入 `~/.codelark/config.toml` 且不改写 legacy `config.json` / `config.env`。默认成功和失败都会清理临时目录；只有传 `--keep-temp` 才保留。 |
| 真实飞书场景目录 | `npm run real:feishu:e2e -- --list-scenarios` | 输出真实 E2E 场景、provider 矩阵、coverage tier 和对应本地覆盖。 |
| 真实飞书 E2E | `CODELARK_REAL_FEISHU_E2E=1 npm run real:feishu:e2e -- --launch-bridge ...` | 启动隔离 bridge，真实创建/复用飞书群、用 lark-cli 用户身份发消息，再用 lark-cli 用户身份拉取消息/群信息验证 bridge 回复、飞书 transcript、provider 输出路径和清理 gate；不复用当前 live bridge。 |

需要定向跑某个本地测试文件时，不要复用真实 home。可以手动模拟 `scripts/run-tests.js` 的隔离环境：

```bash
tmp="$(mktemp -d)"
mkdir -p "$tmp/runtime-home" "$tmp/codex-home" "$tmp/claude-home" "$tmp/kimi-home"
HOME="$tmp/runtime-home" \
USERPROFILE="$tmp/runtime-home" \
CODELARK_HOME="$tmp" \
CODEX_HOME="$tmp/codex-home" \
CODELARK_CLAUDE_HOME="$tmp/claude-home" \
KIMI_CODE_HOME="$tmp/kimi-home" \
node --test --import tsx --test-timeout=15000 src/__tests__/e2e/mock-app/bridge/command/bridge-command-e2e.test.ts
rm -rf "$tmp"
```

Setup wizard / lark-cli 真实本地 E2E 不访问飞书 OpenAPI，也不触碰真实 `~/.lark-cli` 或 `~/.codelark`。示例：

```bash
CODELARK_SETUP_WIZARD_REAL_E2E=1 npm run real:setup-wizard:e2e -- \
  --test-env-file ~/.codelark/test/real-feishu-e2e.test.env \
  --site feishu \
  --runtime kimi
```

`--runtime` 支持 `codex`、`ccr`、`claude`、`kimi` 和 `cursor`，默认是 `codex`；Kimi/Cursor 路径分别验证 `runtime.agent` 与固定 `tmux` provider 写入。`--test-env-file` 只读取 `CODELARK_REAL_FEISHU_TEST_APP_ID` / `CODELARK_REAL_FEISHU_TEST_APP_SECRET` / `CODELARK_REAL_FEISHU_TEST_SITE`；旧 `CTI_REAL_FEISHU_*` 写法不是有效输入。不要把真实 App Secret 放在 npm 参数里，npm 会回显完整命令。

默认会删除 `/tmp/clk-setup-wizard-real-e2e-*` 临时目录。需要排查时才加 `--keep-temp`，脚本输出 JSON 里的 `runRoot` 是保留现场路径。

## 跨平台 CI

GitHub Actions 把“完整回归”和“真实平台依赖 smoke”分开：Linux job 运行完整测试、文档构建和打包检查；跨平台 matrix 验证用户实际会走到的原生终端路径，不用 Linux mock 代替操作系统行为。

- macOS 26 arm64 安装 Homebrew tmux，验证 `tmux -V` 和 session 的创建、查询、名称读取、清理，再运行 typecheck、unit/workflow、build、pack 和 CLI smoke。
- Windows x64 job 使用原生 Windows runner，通过 WinGet 安装 psmux，验证同一组 `tmux.exe` session 生命周期，再运行 typecheck、完整 unit、Windows runtime-sensitive workflow、build、pack 和 CLI smoke。runtime-sensitive 层覆盖真实 psmux/Codex、Claude、Kimi 和 service-manager；平台无关的 command workflow 已由 Linux/macOS 双重覆盖，不在 Windows 重复数百次 Bash fake 冷启动。psmux 走 ConPTY，不经过 WSL。
- matrix job 不等于真实 Codex/Claude/Kimi 或真实飞书 E2E；provider TUI、CardKit 客户端和用户可见行为仍按下文对应层级补验。

Windows 托管 runner 的版本可以随 GitHub 支持范围升级；发布 gate 关注的是 x64 Node.js、WinGet、原生进程/PATH、ConPTY/psmux 这条用户路径，而不是把某个 runner 标签宣传成桌面 Windows 版本。

## 本地测试的层次

本地测试有四种强度，不应只统称为“单元测试”：

默认 `npm test` 会先按原生测试层隔离 `unit`、`workflow`、`mock-e2e`、`harness`、`local-e2e`；其中 `unit` 和 `mock-e2e` 使用 Node 原生 `--test-shard=1/2` 拆成两个文件 shard，Windows 曾暴露平台悬挂的 `workflow` 进一步拆成四个文件 shard，共十个进程组，并按 `os.availableParallelism()` 限制同时运行数。每组由 `run-tests.js` 创建独立的 HOME、CODELARK_HOME、各 runtime home 和 `TMUX_TMPDIR`，shard 内仍保持 `--test-concurrency=1`，因此不会让同一测试文件、配置目录或真实 tmux server 内部并发。结束时只打印各组摘要和日志目录；失败组额外打印尾部。需要复现旧串行顺序时使用 `npm run test:serial`；传入 `npm test -- --unit --workflow` 等 layer 参数时默认仍只启动所选单组，也可显式追加 Node 原生 `--test-shard=N/M`（`1 ≤ N ≤ M`）。需要让选定 layer 也走同一隔离分组时使用 `npm test -- --parallel --unit --workflow`；CI 对稳定层和跨平台层使用该入口，并给测试 step 设置 20 分钟上限，避免平台进程永久悬挂。

tmux workflow 的 fake transport 必须通过 `TmuxCore` 的可执行命令注入运行 Node helper，不要在 Windows 上用无扩展名 shebang 或 `.cmd` 去遮蔽真实 `tmux.exe`：`CreateProcess` 的可执行文件搜索语义与 POSIX PATH 不同，这种 fake 会静默落到真实 psmux。真实 psmux/tmux lifecycle 仍由跨平台 CI 的独立 smoke 与 real-tmux workflow 覆盖。

| 层次 | 回答的问题 | 典型特征 | 何时必须跑 |
| --- | --- | --- | --- |
| 纯逻辑测试 | 解析、格式化、状态 reducer、schema、配置转换是否正确。 | 位于 `src/__tests__/unit/<owner>/`，不启动真实 provider，不依赖网络，不触碰真实 home。 | 改命令解析、渲染、存储结构、schema、配置、权限状态时。 |
| 本地 workflow 测试 | 一条 IM 命令或 runtime turn 经过 bridge 内部编排后，是否生成正确状态和交付动作。 | 位于 `src/__tests__/workflow/<slice>/`，使用 fake adapter/provider/store；可能覆盖多个内部组件。 | 改命令体系、会话绑定、delivery、mirror、turn runner、UI application 时。 |
| 本地 mock app E2E | daemon 级入口、fake channel/provider、状态持久化和交付动作是否闭环。 | 位于 `src/__tests__/e2e/mock-app/`，仍不证明真实 provider 可执行文件或真实飞书客户端契约。 | 改 bridge host 集成、命令入口、card payload 或应用级编排时。 |
| 本地真实进程 E2E | Codex/Claude 的真实 tmux/CLI，Kimi Code 真实 executable + fake model proxy，以及 opt-in Cursor 已登录官方 backend，在隔离 runtime 数据目录中是否能启动、产生事件、冷接管、恢复或完成清理。 | 位于 `src/__tests__/e2e/local-process/`；仍不等于真实飞书。Cursor 测试读取宿主安全凭据但不把测试 chat 写入真实 `~/.cursor`。当前 GitHub Actions 只持续运行 Codex/Claude/Kimi 三个真实 executable shard，Cursor 仍是本机显式发布门禁；在有无凭据的 Cursor fake Connect/protobuf backend 之前，不得把它描述为 CI gate。 | 改 provider 启动、tmux、JSONL/wire/transcript 发现、CLI bootstrap、真实进程清理时。 |

真实飞书 E2E 是第四层，专门验证外部平台契约：飞书事件投递、bot 入群、`reply_to`、真实卡片/文件/表单消息、provider 输出路径和测试群清理。它不替代本地测试。

真实飞书 E2E 的最低验收标准是“先真实发，再以用户身份真实读”。测试必须用 `lark-cli --as user` 或等价 user 身份发送触发消息，然后再用 `lark-cli --as user` 拉取群消息、成员/群信息或云文档评论来断言结果。只检查本地 store、bridge 日志、mock adapter 调用或 bot 身份响应不能单独称为真实端到端通过。

## 维护粒度

测试应按语义边界组织，而不是按单个返回值、单个 enum 值或单个默认值机械拆分。纯逻辑测试可以用一个表驱动或矩阵用例覆盖同一解析器/格式化器的一组等价输入；只有错误路径、兼容格式、外部协议边界、异步状态转换、持久化迁移和用户可见回归应拆成独立用例，方便 fast-fail 定位。

fake 测试也要遵守真实职责边界。`fake tmux` 只模拟 tmux transport：session/pane 存在性、`capture-pane`、`send-keys` 和进程退出；Codex TUI 的 update prompt、permission prompt、delayed-ready、选择后退出或进入正常输入界面由 `fake Codex TUI` 模拟。真实进程 E2E 覆盖 happy path 后，不应保留只重复 happy path 的 fake 断言；但 orphan callback、启动失败、update 后重启、bootstrap 后选择、已有 session 卡在选择页这类真实 E2E 不稳定或不应真实触发的分支仍应保留 fake/workflow 覆盖。

long-running 功能不能只测“成功派发 worker”。精炼用户故事至少覆盖：入口及时 ACK；进行态按合理频率刷新；worker 日志明确失败、worker 无完成标记提前退出和超时都进入失败终态；破坏性动作前已经持久化恢复 receipt；成功重启后由新进程消费 receipt，更新原卡或发送 fallback 完成卡。涉及真实安装、stop/start 或平台卡片时，本地 workflow 负责确定性失败矩阵，真实端再完成一次“用户点击 → 进程变化 → 用户身份回读终态”的主路径验收。

## 语义分类

### 用户对话、命令和会话体验

这些测试证明用户在 IM 中发送 slash command 或普通消息后，bridge 能选择正确 runtime/provider、更新会话状态、回复正确文案，并维持聊天与 session 的绑定。

| 测试文件 | 关注点 |
| --- | --- |
| `bridge-command-e2e.test.ts` | 命令级本地 workflow：普通消息、`/new`、`/his`、`/every`、runtime/provider、表单卡片、历史附件等用户可见行为。 |
| `command-dispatch.test.ts` | slash command 解析、runtime/provider 设置、状态命令、require-at、Claude history JSONL 等分派语义。 |
| `help-command.test.ts` | `/help` 命令分组和用户可读帮助文本。 |
| `bridge-adapter-runtime.test.ts` | adapter 事件进入 bridge 后按当前 runtime 路由。 |
| `interactive-runtime.test.ts` | runtime 选择、provider 绑定和运行时上下文。 |
| `runtime/runtime-options.test.ts` | runtime/provider 选项解析和业务 fallback；配置层只提供 schema 校验后的统一值。 |
| `session-runtime.test.ts` | `BridgeSession` 上 Codex/Claude/Kimi runtime 字段的读写语义。 |
| `session-registry.test.ts`、`session-registry-bindings.test.ts`、`session-display-query.test.ts`、`session-health-runtime.test.ts` | session 创建、聊天绑定、展示查询、健康诊断和跨 runtime 状态。 |
| `turn-classifier.test.ts` | 普通用户消息、命令、特殊控制输入等 turn 类型识别。 |
| `turn-coordinator.test.ts` | 同一会话内 turn 的排队、互斥、取消和状态协调。 |
| `local-codex-terminal-router.test.ts` | 本地 Codex terminal/tmux 输入路由与会话匹配。 |
| `bridge-manager.test.ts` | bridge 顶层编排：prompt context、目录解析、别名、状态、stop/doctor、channel lifecycle、startup cleanup、mirror recovery、新会话处理等。 |

### Runtime/provider 执行链路

这些测试证明 bridge 与 Codex/Claude/Kimi provider 的协议边界稳定：事件流、session identity、tmux 生命周期、CLI 可执行文件、模型列表和错误事件。PTY provider 的专属测试已经移除，不再作为发布保证；配置迁移测试仍可保留旧 `pty` 值，防止读取历史配置时损坏数据。

| 测试文件 | 关注点 |
| --- | --- |
| `codex-provider.test.ts` | Codex SDK/SSE 事件转换、图片输入、错误事件和 provider 主路径。 |
| `codex-routing-provider.test.ts` | Codex/Claude/Kimi provider 选择和 fallback，包含 Claude 默认 tmux 与 Kimi tmux。 |
| `codex-cli-executable.test.ts`、`codex-models.test.ts` | Codex CLI 定位和模型列表缓存。 |
| `codex-tmux-provider.test.ts` | Codex tmux prompt 注入、启动参数、auto-enter、清理和事件输出。 |
| `codex-session-index.test.ts`、`codex-session-mirror.test.ts` | Codex JSONL/session 索引读取、mirror cursor 对齐和事件重放。 |
| `claude-tmux-provider.test.ts`、`claude-sdk-provider.test.ts`、`claude-session-jsonl.test.ts` | Claude tmux 启动/注入/mirror SSE、Claude SDK helper、Claude JSONL session 读取。 |
| `kimi-tmux-provider.test.ts`、真实 Kimi executable E2E、`kimi-tmux-provider-local-process.e2e.test.ts` | fresh 不带 `-r` 单次启动、从真实 TUI 发现 CLI session id、wire 在首条输入前或输入后创建、跨 turn 复用、慢模型 `Ctrl-S` steer、tmux 丢失恢复、think/status 和 terminal 归属；scripted fixture 继续穿过真实 tmux，但不冒充真实 executable gate。 |
| `cursor-tmux-provider.test.ts`、`real-cursor-agent-bridge.e2e.test.ts` | 默认 suite 用确定性 pane 状态保护“空白但存活的冷索引不得 kill tmux”，并用真实捕获的 JSONL 把两版 assistant revision 拆到不同 poll cycle，证明最终正文不是只在全量读取时偶然去重；显式真实 gate 用官方 `agent`、真 tmux、真实 backend 和一次性 35 秒延迟覆盖旧 30 秒失败边界、等待进度、同 pane/UUID 冷接管与 tmux 丢失后 resume。前者防代码回归，后者证明真实 CLI 集成；两者不能互相冒充。 |
| `sse-stream-decoder.test.ts` | SSE 文本流解码和事件边界。 |
| `interactive-turn-runner.test.ts` | 一次 runtime turn 的主编排，含 stream、tool、context、goal、stop、mirror suppression、基础对话 simulator，以及 answer 中间态附件立即发送、thinking 排除和终态去重。 |
| `interactive-turn-sdk-conversation-engine.test.ts`、`interactive-turn-sdk-stream-events-controller.test.ts`、`interactive-turn-final-response-plan.test.ts`、`interactive-turn-terminal-finalization-controller.test.ts` | SDK conversation 内联附件/tool 展开、stream event 控制、最终回复计划和终端 provider finalization。 |
| `real-codex-tmux-provider.e2e.test.ts`、`real-claude-tmux-provider.e2e.test.ts`、`real-kimi-code-bridge.e2e.test.ts`、`real-kimi-code-tmux-provider.e2e.test.ts`、`kimi-tmux-provider-local-process.e2e.test.ts` | 隔离 home 中启动真实 provider 进程或 fake backend；Codex 以真实 CLI + tmux + Mock Responses 流验证 answer 附件在终止事件前发送、回复到异步就绪的流式卡片且 completed 不重复。Kimi 用真实 executable + 真 tmux + 本地 OpenAI-compatible proxy 覆盖 fresh/steer/resume，并让同一 proxy 返回确定性 402，证明真实 CLI 写出的 `ERROR turn failed` 会进入 SSE error 且不产生成功 result；thinking 排除和 fake CLI session/wire 生命周期继续用确定性 fixture 回归。 |

### 交付、流式、mirror 和用户可见渲染

这些测试回答“模型输出怎样安全地变成 IM 消息”：直接回复、stream card、mirror card、最终文本去重、Markdown、工具/任务进度、附件和问题表单。

| 测试文件 | 关注点 |
| --- | --- |
| `delivery-pipeline.test.ts` | 文本、卡片、附件和 question form 的交付编排；同 chat 队列不等待远端 ACK 且保持发送顺序。 |
| `response-assembler.test.ts` | 分段 stream 输出合并成用户可读最终响应。 |
| `stream-state.test.ts`、`streaming-metadata.test.ts`、`stream-feedback-controller.test.ts` | stream 状态、metadata 和反馈卡片更新节奏。 |
| `mirror-runtime.test.ts`、`mirror-turns.test.ts`、`mirror-delivery-plan.test.ts`、`bridge-manager.test.ts` | mirror pending delivery、turn 队列和交付策略；Codex `task_complete.error` 在存在时必须形成 error 终态并保留真实 errorText。对 0.144.3 还要用真实 custom-provider HTTP 400 验证：直接 TUI 提交后不再发送消息，rollout 不含 error，但空闲 checkpoint 能排除历史方块并在 completed 后补成 error；checkpoint/turn 重叠、同批多 turn、capture 期间 rollout 增长均必须拒绝错归。窄 tmux 必须让 JSON error cell 在字符串内部换行并仍恢复完整 type/message。baseline 调度回归还必须证明多个 subscription 共用一次 `tmux list-sessions`，只 capture 真实存活 session，缺失 session 在退避期不重复 list/capture。 |
| `mirror-feedback-controller.test.ts`、`mirror-reconcile-core.test.ts`、`mirror-reconcile-batch.test.ts`、`mirror-subscription-registry.test.ts`、`mirror-subscription-state.test.ts`、`mirror-runtime.test.ts` | mirror 订阅、reconcile、批处理、状态恢复和反馈控制；稳定 binding 跨多轮 reconcile 只能做已知文件 stat，不得重复 source discovery，路径失效后才重新定位并切换 watcher。新 attach 首次只建立 cursor、不回放历史；Bridge 重启恢复已有水位时必须追回水位之后的记录。runtime 可声明补充增量事件源；Kimi 用独立游标读取 session 自己的 `kimi-code.log`，即使主 wire 没变化也必须把完整 `ERROR turn failed` 变成一次 error 终态，不能把可重试 WARN 提前终结，也不能重复投递。 |
| `feishu-markdown.test.ts`、`plain-markdown.test.ts` | Markdown 到飞书卡片/纯文本的转换，含表格、代码块、工具/任务进度、Kimi 单行统一 footer 和最终卡片 JSON。 |
| `scripted-tool-model.test.ts`、`tool-presentation.test.ts`、`text-preview.test.ts` | 确定性生成任意工具 start/result/error 序列，验证公共标题语义和字符数/行数双 hard upper bound；不依赖真实模型随机输出。 |
| `feishu-adapter-card-e2e.test.ts` | 飞书 card 级本地 E2E，覆盖 SDK/mirror question form、GPT-5.6 orchestration、Kimi Markdown、terminal→usage 后无悬挂 pending turn、内部 reminder 不可见，以及真实 bash/patch 详情等 payload 形态。 |
| `outbound-artifacts.test.ts`、`streaming-artifact-delivery.test.ts` | 出站 artifact、问题表单和附件描述；流式附件的完整块检测、异步去重、失败后终态重试资格。 |
| `permission.test.ts`、`permission-broker.test.ts` | 权限请求、pending permission 状态和 broker 行为。 |

主路径性能回归必须同时覆盖三层：`command-dispatch.test.ts` 用永久 pending 的 fake Feishu reply、群名同步、callback answer 和 mirror reconcile 证明 raw handler 及时结束、下一条命令可继续入队；`permission-broker.test.ts` 用 pending 权限卡 ACK 证明 forwarding 立即返回并在 receipt 到达后回填 permission link，还要证明最终投递失败会立即结束 pending permission/selection waiter；`feishu-adapter.test.ts` 用 pending notice/reaction ACK 证明构造完成的内部消息先入队；`interactive-turn-runner.test.ts` 证明 stream finalize/fallback/onMessageEnd 的顺序留在后台 delivery job 中。`/new` 这类必须先取得远端主键的事务要验证文本命令和 command callback 都被路由到不阻塞 conversation 的 long-I/O job lane。常规测试必须显式 drain 后台 delivery，禁止为了让测试立刻读到 `sent` 而在产品 handler 末尾增加 `setImmediate` 或等待远端 ACK；也禁止用直接删除 `await` 的方式让卡片 cleanup 抢在 finalize 前执行。

### IM 通道、平台 adapter 和 Web 工作台

这些测试证明飞书通道和本地 UI 的边界稳定：飞书 API 包装、事件过滤、路由、配置页、绑定页和服务页。

| 测试文件 | 关注点 |
| --- | --- |
| `feishu-adapter.test.ts`、`feishu-markdown.test.ts` | 飞书消息、mention 过滤、结构化 stream 区域和事件处理；覆盖一个 canonical tool_panel 以单个工具调用为 cursor 续卡，并断言两侧重新分组、patch 多行 fence、末尾 sentinel 和单卡 payload 安全线；同时冻结短用户输入内联、超过 800 字的输入用无边框 panel 折叠且展开内容完整，以及空 final text 时 history-only 工具不能被 footer 覆盖。 |
| `channel-adapter.test.ts`、`channel-router.test.ts`、`adapter-sync-plan.test.ts` | 通道队列、默认目标路由和 adapter 实例同步计划。 |
| `ui-auth-routes.test.ts`、`ui-binding-application.test.ts`、`ui-channel-routes.test.ts`、`ui-config-routes.test.ts`、`ui-service-routes.test.ts`、`ui-session-application.test.ts`、`ui-session-history.test.ts` | Web 工作台的鉴权、绑定、通道、配置、服务、会话和历史。 |

### 存储、配置、迁移、诊断和发布辅助

这些测试保护不直接表现为一条聊天回复、但会影响长期运行和可维护性的基础设施。

| 测试文件 | 关注点 |
| --- | --- |
| `config.test.ts`、`json-schemas.test.ts` | 配置转换、secret masking、读写 round-trip 和发布 JSON schema。 |
| `store.test.ts`、`storage-migrations.test.ts`、`channel-chat-migration-script.test.ts` | JSON store、启动迁移和旧 binding 到 channel chat 的迁移脚本。 |
| `logger.test.ts` | 日志参数格式化和 secret 脱敏。 |
| `doctor.test.ts`、`real-e2e-dump.test.ts` | doctor prompt 构造、真实 E2E dump 的 live log 范围。 |
| `service-manager.test.ts`、`hot-update-script.test.ts` | 后台服务 pid/lock/startup、延迟卸载、hot update dry-run/log 行为。 |
| `test-environment-isolation.test.ts` | 测试环境必须隔离 home，防止写入真实用户目录。 |

### 真实飞书 harness 自测和真实平台 E2E

这些测试/脚本不只是检查业务逻辑，还检查真实 E2E harness 自己生成的计划、metadata、gate 和报告是否可信。

| 测试或脚本 | 关注点 |
| --- | --- |
| `real-feishu-e2e-harness.test.ts` | `scripts/real-feishu-e2e.ts` 的场景 metadata、命令计划、dry-run/report gate、history suite、card form、markdown rendering、basic dialogue suite 等。 |
| `scripts/real-feishu-e2e.ts` | 真实飞书主 harness：创建/复用群、`/new` 场景群名校验、lark-cli 用户消息、隔离 bridge、fake CCR、场景命令、reply observation、provider path gate、清理 gate 和 report dump。 |

### 测试辅助文件

这些文件也在 `src/__tests__` 下，但它们不是独立 suite：

| 辅助文件 | 用法 |
| --- | --- |
| `test-setup.ts` | 本地测试共享 setup，集中处理测试环境默认值和全局准备。 |
| `test-bridge-utils.ts` | bridge workflow 测试使用的 fake adapter、fake provider、临时 store 和断言辅助。 |
| `real-codex-e2e-utils.ts` | Codex 真实进程 E2E 的临时 home、CLI/tmux 运行和清理辅助。 |

## 真实飞书场景怎么选

先用 metadata 看当前场景和 provider 矩阵：

```bash
npm run real:feishu:e2e -- --list-scenarios
```

按验证目的选择：

| 验证目的 | 首选场景 | 说明 |
| --- | --- | --- |
| provider 路径是否健康 | `message-only` 或 `runtime-message` | 证明消息能到达 runtime 并回到飞书，不证明复杂功能。Cursor 的 `runtime-message` 额外检查最终 CardKit 是否使用共享 header、runtime/model metadata 和 history 区域，防止正文正确但卡片退化为无标题旧结构。 |
| 同一会话多 provider 基础对话 | `basic-dialogue-suite` | 最高优先级长流程，按 `codex-sdk -> claude-sdk -> kimi-tmux -> codex-tmux` 覆盖代表路径。 |
| 命令状态和配置 | `command-state` | 覆盖 `/status`、runtime/provider 设置、require-at、`/every` 等语义文本。 |
| 会话生命周期 | `session-management` | 覆盖 `/help`、`/set`、`/new`、`/cd`、`/current`、`/check`、`/t`、最终 prompt 和 `/his`。 |
| 历史功能簇 | `history-suite` | 在 runtime/provider 矩阵中合并验证 `/his` 默认/raw/msg/limit/json/file、长截断和跨群空历史隔离，包含 `kimi-tmux`。 |
| mention 策略 | `require-at-toggle` | runtime-neutral，专门验证非 mention 群消息过滤。 |
| 表单和交互卡片 | `card-forms`、`agent-question-forms` | 覆盖 `/new-form` 和模型输出 `<clk-ask>` 后的 CardKit/interactive payload。 |
| Markdown 真实渲染 | `markdown-rendering` | 以飞书原始消息为准检查表格和 fenced code block。 |
| 工具卡片 | `rendering-suite` | 检查保留历史记录容器、单工具内部无二次折叠、单行语义标题与动作图标、真实 command/patch、闭合多行 fence、transport envelope 清理和双上限预览。 |

真实 E2E 通过必须以 harness 自动 gate 写出的非 failure JSON 为准。至少检查 `message_observations_passed`、`required_checks_passed`、`provider_output_path`、`created_chat_cleanup_completed`、`scenario_created_chat_cleanup_completed` 和场景级断言；gate 失败的 `.failure.json` 不能人工解释为通过。

## 改动后该跑什么

| 改动类型 | 最小本地验证 | 需要补充的验证 |
| --- | --- | --- |
| 命令文案、slash command、session 绑定 | `npm test` 或定向跑 `command-dispatch.test.ts`、`bridge-command-e2e.test.ts`、相关 session 测试；改飞书卡片结构时加 `feishu-markdown.test.ts` | 改用户可见命令语义时，补 `command-state` 或 `session-management` 真实飞书。 |
| runtime/provider 选择或启动 | provider 相关测试、`interactive-turn-runner.test.ts`、`npm run typecheck` | 改 tmux/SDK/Claude Code/Codex CLI 时，补对应真实 executable E2E；用户可见路径补 `runtime-message`。 |
| mirror、stream、delivery、Markdown、卡片 | delivery/mirror/stream/markdown/card 测试 | 改飞书 payload 或真实客户端形态时，补 `markdown-rendering`、`card-forms` 或 `agent-question-forms`。 |
| 历史、附件、文件交付 | `bridge-command-e2e.test.ts`、`store.test.ts`、`delivery-pipeline.test.ts` | 补 `history-suite`，特别是 `/his json`、`/his file`、长截断和跨群隔离。 |
| 通道配置、UI、服务管理 | 对应 `ui-*`、`channel-*`、`service-manager.test.ts` | 只有 IM 可见行为变化才补真实飞书；本地 Web/API 行为以本地测试为主。 |
| 存储 schema、迁移、配置 | `config.test.ts`、`json-schemas.test.ts`、`store.test.ts`、`storage-migrations.test.ts` | 运行 `npm run typecheck` 和必要的 dry-run 迁移；涉及发布包时跑 `npm run build`。 |
| 文档 | `npm run docs:build` | 若文档改变测试策略，还应确认 `--list-scenarios` 输出与文档一致。 |

## 维护原则

- 新增测试时先判断它证明的是纯逻辑、本地 workflow、本地真实进程，还是外部平台契约；不要把真实飞书 E2E 当成本地测试的逐条镜像。
- 工具调用测试以 scripted Mock 为协议回归基座，再用真实 Codex/Kimi fixture 验证协议 shape，最后才用隔离飞书 App 验证 CardKit 客户端边界；真模型输出不能替代确定性断言。
- 命令密集型真实 E2E 按 runtime 压缩，不默认扩张完整 provider 矩阵；provider 差异只在 SDK/tmux 输出路径和真实风险足够高时增加。
- `src/__tests__` 下的本地测试要尽量保持隔离 home；任何读取真实 `~/.codelark`、`~/.codex`、`~/.claude` 的测试都应被视为风险。
- 真实飞书成功证据必须来自自动 gate 和 report，不来自“群里看起来回了消息”的人工观察。
