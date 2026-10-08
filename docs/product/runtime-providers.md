# 运行时与提供方

CodeLark 把“使用哪个 AI 工具”和“如何驱动它”拆成两层。

- 运行时：当前会话使用 Codex、Claude Code、Kimi Code、Cursor Agent 还是 ZCode。
- 提供方：当前运行时通过哪个兼容层运行。Codex 固定为 tmux；app-server 是自动执行后端，不是并列提供方。

日常 IM 操作流程见 [会话与配置工作流](../guide/session-workflows.md)。本文主要说明 provider 能力边界和实现模块。

## 能力矩阵

| 运行时 | 提供方 | 适用场景 | 输出路径 |
| --- | --- | --- | --- |
| Codex | `tmux` | app-server 优先执行；tmux 提供可 attach 查看入口，并作为协议不可用时的唯一兼容回退 | app-server events；兼容回退时为 tmux screen + JSONL mirror |
| Claude Code | `tmux` | 默认路径；需要可 attach 的 Claude Code TUI 长会话 | tmux screen + Claude JSONL mirror |
| Claude Code | `pty` | 使用本机 `claude` 或 `ccr code` TUI | Claude JSONL mirror + pty screen |
| Claude Code | `sdk` | 使用 Claude Agent SDK | SDK message stream |
| Kimi Code | `tmux` | 使用本机 Kimi Code TUI 长会话；仅向 active turn 自动补 `Ctrl-S` steer | tmux screen + Kimi `wire.jsonl` mirror |
| Cursor Agent | `tmux` | 直接运行官方 `agent` TUI，保留原生交互和 slash 命令 | tmux screen + Cursor transcript JSONL mirror |
| Cursor Desktop | `desktop`（自动） | `/t` 接管已经在 Cursor Desktop 中存在的可见对话 | Cursor Desktop Bridge 单写入 + 同一 transcript 只读 mirror |
| ZCode | `tmux` | 运行本机 `zcode` TUI，保留原生 slash 命令和可 attach 会话 | ZCode SQLite/WAL direct stream + tmux screen；后台 mirror 同步外部变化 |

补充说明：

- Claude Code 运行时默认使用 `tmux` 提供方，便于从 IM 和本机终端同时观察/接管 Claude Code TUI；可通过 `/provider pty` 或 `/provider sdk` 为当前会话切换。
- Codex 运行时固定使用 `tmux` Provider。正常情况下 app-server 是唯一 writer，tmux 只是 `--remote` 查看入口；只有 app-server 明确不可用时才由 tmux 承担兼容执行。
- Kimi Code 当前只支持 `tmux` 提供方。fresh session 只启动一次 `kimi -y`，等待 TUI 同时出现真实 `Session:`、输入框与 context footer 后保存 CLI 生成的 session id；只有恢复已绑定 session 才使用 `kimi -r <session> -y`。首条输入不以 `wire.jsonl` 已存在为前置条件：文件较早出现时从尾部续读，较晚出现时先提交 prompt，再从头读取首轮事件。已有 tmux 但 Bridge 身份缺失时，会先从 TUI 恢复 session id；普通消息只有在对应 prompt 已进入 `wire.jsonl` 并启动 turn 后才算转发成功，未确认时会重投一次并显式报错，不会静默显示成功。输出由 Kimi wire mirror 同步；状态区会展示截断后的「当前思考」。
- Cursor Agent 新建/CLI 会话使用 `tmux`：只启动一次 `agent --trust`，首轮提交后从 Cursor 后台创建的 `meta.json` 和 transcript JSONL 发现 chat UUID；恢复已绑定 CLI 会话使用 `agent --resume <chatId>`。`/t cursor` 同时合并 Cursor Agent CLI chat 与 Cursor Desktop conversation 索引，并从 Desktop 全局/工作区状态还原 cwd；只有无法还原 cwd 的残留记录会隐藏。
- 从 Cursor Desktop conversation index 识别出的会话自动固定为 `desktop`，不作为全局可选默认 provider。输入通过 Cursor 的 discovery、Bearer token 和 Unix socket 精确提交给已打开的同一 thread；输出仍从该 thread 的 transcript 读取。这是一个 writer 加只读 mirror，不是向 Desktop 和 tmux 双写。Cursor 的 Beta 设置中需启用 `Allow CLI to access desktop agents`；若当前 Cursor 版本或账号未提供该开关，CodeLark 会明确提示 Desktop Bridge 不可用，并拒绝降级到 tmux。bridge 请求会验证 discovery 权限、live PID、socket 和精确 thread；`queued` 消息会等待本次 user row 后才接收终态，避免串入上一轮输出。
- CodeLark 不解析 Cursor TUI ANSI 屏幕来取得回答。CLI 会话的原生 Cursor slash 命令可用 `/tmux /<command>` 发送；首版假设 chat ID 固定，不自动跟随 `/new`、`/fork`、`/resume` 的身份变化。Desktop 会话保留 Desktop 自己选择的模型和模式，CodeLark 不在发送时覆盖。
- ZCode 当前只支持 `tmux` 提供方，并要求 `zcode` 可执行文件位于 Bridge 的 PATH。CodeLark 启动 provider-owned tmux，当前普通回合由 Provider 从 ZCode SQLite 的 message/part/turn usage 直接读取正文、工具、usage 与成功/失败终态并更新同一张流式卡片；后台 mirror 对该交互 turn 做 suppression，只同步交互 turn 之外的本地变化。SQLite 使用 WAL 时同时监听主库和 WAL 的聚合快照。`//goal` 等转义后的原生 slash 由 ZCode TUI 自己解析；这类命令不产生 SQLite turn，因此结果从 TUI 屏幕回传到当前常规卡片。CodeLark 不逐条实现 ZCode slash 命令。
- `/p tmux` 会销毁同名 provider-owned tmux 并以已保存的稳定 `sess_*` 执行 `zcode --resume`；Bridge 重启后 `/t zcode` 也按 `sess_* + cwd` 发现和接管会话。CodeLark 不安装 ZCode、不代理登录，也不会改写 ZCode 的账户配置。

Cursor tmux 是生产支持的 runtime，不是 UI 占位。真实官方 `agent` 测试已覆盖冷启动、不中断接管和 tmux 丢失后恢复同一 chat UUID；该测试需要已登录的 Cursor backend，因此目前是 opt-in，不在普通 CI 中自动执行。真实飞书 runtime/provider 矩阵已包含 Cursor 场景，但发布验收仍应区分“场景已定义”和“本次已有真实飞书执行证据”，不能把 planned-only coverage 表述为已验收。

## 用户配置入口

- `/runtime codex|claude|kimi|cursor|zcode`：切换当前会话使用的运行时。
- `/provider` 或 `/p`：查看或切换当前运行时的提供方。
- `/model`：查看或切换当前会话模型。
- `/reasoning`：按当前 runtime 设置 Codex/Claude effort、Kimi Thinking 开关或 Cursor 模型 effort；ZCode 不做跨产品参数映射。
- `/cd <path>`：修改当前会话工作目录。
- `/set`：查看或修改全局默认值。
- Web 工作台配置页：编辑全局默认值。
- Web 工作台会话配置弹窗：编辑单个会话的覆盖值。

Claude 的 `executable` 影响 `tmux` 和 `pty` 提供方；Claude SDK 提供方不走本机 `claude` / `ccr code` TUI。Claude tmux 启动会先确认所选 executable 确实存在；缺失时直接提示安装/PATH/`/set claudeExecutable` 修复方式，不创建 tmux 或保存失败的 provider binding。首次启动的 welcome、theme 和 terminal setup 页面会作为 onboarding 依次确认；工作目录信任页会显式移动到 `Yes, I trust this folder` 再确认。YOLO 首启风险页不会自动接受，而是通过 IM 选择卡让用户选择 `No, exit` 或 `Yes, I accept`，选择前不会向 TUI 发送按键。已有 Claude session identity 时，`/p tmux`、tmux 自动恢复和 pty/tmux provider 启动都会执行 `--resume <session_id>`，且输出只绑定该 session 的 JSONL；fresh 会话才从新产生的 JSONL 发现 identity。

Codex tmux 的 fresh 首消息会在 workspace trust 后继续处理模型迁移等启动选择，并等待输入框稳定后才注入文本与 Enter。全新聊天继承有效的全局 YOLO 和 reasoning 配置，不会再被 hidden draft 写死为 low。

思考能力不跨 runtime 硬映射：Codex 支持到 `ultra`；Claude Code 支持到 `max`；Kimi Code 只有 `--thinking/--no-thinking`；Cursor 通过 `--model 'model[effort=...]'` 传递模型级 effort；ZCode 使用自己的模型与原生命令。Cursor `force` 与 `maxMode` 都不等同于 reasoning effort。

## 设计模块

| 主题 | 模块 |
| --- | --- |
| 提供方路由 | [src/runtime/codex/routing-provider.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/runtime/codex/routing-provider.ts) |
| Codex tmux | [src/runtime/codex/tmux-provider.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/runtime/codex/tmux-provider.ts) |
| Claude tmux | [src/runtime/claude/tmux-provider.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/runtime/claude/tmux-provider.ts) |
| Kimi tmux | [src/runtime/kimi/tmux-provider.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/runtime/kimi/tmux-provider.ts) |
| Cursor tmux | [src/runtime/cursor/tmux-provider.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/runtime/cursor/tmux-provider.ts) |
| Cursor Desktop | [src/runtime/cursor/desktop-provider.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/runtime/cursor/desktop-provider.ts)、[src/runtime/cursor/desktop-bridge-client.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/runtime/cursor/desktop-bridge-client.ts) |
| Cursor session index | [src/runtime/cursor/session-index.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/runtime/cursor/session-index.ts) |
| ZCode tmux | [src/runtime/zcode/tmux-provider.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/runtime/zcode/tmux-provider.ts) |
| ZCode session index | [src/runtime/zcode/session-index.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/runtime/zcode/session-index.ts) |
| tmux session 生命周期 | [src/bridge/tmux/runtime.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/tmux/runtime.ts) |
| Claude pty | [src/runtime/claude/pty-provider.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/runtime/claude/pty-provider.ts) |
| Claude SDK | [src/runtime/claude/sdk-provider.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/runtime/claude/sdk-provider.ts) |
| Claude Code Router | [src/runtime/claude/code-router.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/runtime/claude/code-router.ts) |
| 会话运行时设置 | [src/domain/session-runtime.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/domain/session-runtime.ts) |
| 交互 turn | [src/bridge/turn/interactive/runner.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/turn/interactive/runner.ts) |

## app-server 与 tmux 输出差异

app-server 直接把结构化事件交给 IM turn。协议不可用时的 tmux 兼容路径更接近真实终端使用，会依赖本地 JSONL mirror 把最终输出同步到 IM。

tmux Provider 的普通文本会先转发到 tmux 中的当前 runtime TUI。Codex tmux 如需自动预创建 `codex_thread_id` 或恢复缺失的 tmux session，启动进度会更新到同一张 Provider 卡片；Claude、Kimi、Cursor 和 ZCode 分别从自身 JSONL、transcript 或 SQLite 同步结构化输出。显式发送 `/p tmux` 时会重建 provider-owned session；Kimi、Cursor 与 ZCode 由各自 provider 负责恢复稳定 session id 和注入输入。`/clear` 和 `/t archive` 会 best-effort 清理记录在 runtime state 中的 tmux provider session。

tmux 兼容路径不把飞书图片或文件的二进制内容直接注入 TUI。用户发送附件后，CodeLark 会提示其引用原附件并补充处理指令；引用的飞书消息 id 和类型会作为模型上下文传入。遇到 `merge_forward` 等 adapter 未直接解析的引用类型时，上下文会明确要求模型使用 `lark-cli` 按消息 id 读取原消息。

相关模块：

- mirror 订阅：[src/bridge/mirror/subscription-registry.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/mirror/subscription-registry.ts)
- mirror 运行时：[src/bridge/mirror/runtime.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/mirror/runtime.ts)
- mirror turn 合并：[src/bridge/mirror/turns.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/mirror/turns.ts)
- mirror 反馈：[src/bridge/mirror/feedback-controller.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/mirror/feedback-controller.ts)
