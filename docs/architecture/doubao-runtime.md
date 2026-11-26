# Doubao ACP runtime

Doubao 在 CodeLark 中是独立 runtime，当前唯一 provider 是 `doubao:acp`。CodeLark 直接通过标准 stdio JSON-RPC 2.0 ACP v1 协议驱动本机 `doubao acp serve`，复用共享 `src/runtime/acp/client.ts` 客户端，不依赖 tmux 或屏幕解析。

## 用户合同

- `/runtime doubao` 创建或切回该聊天记住的独立 Doubao BridgeSession，不与 Codex/Claude/Kimi/Cursor/ZCode 共用原生会话。
- `/mode normal|plan|yolo`（或 `/yolo on|off`）映射为 ACP `default` / `plan` / `bypass_permissions`，下一轮发消息时通过 `session/set_mode` 热生效，无需重启子进程。
- `/model <id|名称|default>` 与 `/reasoning none|minimal|low|medium|high|xhigh|max|default` 在下一轮通过 `session/set_config_option`（`model` / `effort`）热更新，若当前账号或模型不支持则会明确拒绝而不提交输入。
- `/provider` / `/p` 固定展示 `acp`；切换为 `tmux` 等不支持的 provider 会明确拒绝。
- `/stop` 与运行中追问新消息会通过 `session/cancel` 中断当前生成并等待 drain 确认，随后在同一原生会话继续下一轮。
- `/t doubao` 通过 ACP `session/list`（带短期内存缓存与刷新）列出云端 Doubao 会话，按 `doubaoSessionId + cwd` 接管与恢复；`/t archive` 调用 `doubao delete <sessionId>` 删除。

## 协议与生命周期

- **进程与握手**：每个活跃 BridgeSession 对应一个 `doubao acp serve -C <cwd>` 子进程（可选附带 `--model` / `--effort`，权限模式统一在建连后经 ACP `session/set_mode` 同步）；复用 `doubao login` 本机凭据（`authMethods: []`），未登录时透出明确引导运行 `doubao login`。
- **POSIX `stdin` 管道兼容**：真实 `doubao` CLI 要求 `stdin` 为 terminal、POSIX `pipe`（`S_IFIFO`）或 regular file，会拒绝 Node.js `child_process` 默认通过 `socketpair()` 创建的 `S_IFSOCK`。因此共享 `AcpClient` 为 Doubao 开启 `stdinPipe: true`（在 POSIX 平台通过临时 FIFO 与后台 feeder 桥接真正的内核 `S_IFIFO`，并在目标进程提前退出时立即清理 feeder、透传真实退出码，同时继续丢弃 `stderr` 避免泄露凭据），`listDoubaoModels` 与 `archiveDoubaoSession`（自动解析数值云端 ID 并执行 `doubao delete <id> --yes`）则以 `stdio: ['ignore', 'pipe', 'pipe']` 运行。
- **新建与恢复**：首次对话调用 `session/new` 获取原生 UUID `sessionId`、当前模式与可用 `configOptions`；已有 `doubaoSessionId` 时调用 `session/load`（要求 `cwd` 与创建会话时一致），并在注册 turn listener 前屏蔽 `session/load` 触发的历史 `session/update` 回放，避免旧消息重新流向当前卡片。
- **实时流式事件**：`agent_message_chunk` 映射为正文流、`agent_thought_chunk` 映射为思考状态、`tool_call` / `tool_call_update`（含 diff patch 渲染）映射为工具块、`plan` 映射为任务列表更新。
- **权限审批**：`normal` / `plan` 模式下 `session/request_permission` 经由 `PendingPermissions` 路由到 IM 审批卡片；`yolo`（`bypass_permissions`）模式下直接自动选择 `allow_always` / `allow_once` 放行。
- **瞬态错误自动续接**：遇到 `429` / `resource_exhausted` / `unavailable` / `http/2 stream closed` 等瞬态错误且无未完成工具或挂起审批时，自动在同原生会话发起最多 2 次续接，明确提示不要重复已完成操作。
- **镜像边界**：与 `cursor:acp` 一致，Doubao ACP 实时事件直连流式卡片，不注册后台本地文件 mirror；Bridge 停止或 `/clear` 时主动关闭受管 ACP 子进程。

## 配置与存储契约

- `config.toml`（v2）：`[runtime.doubao]` 支持 `model`（默认 `""`）、`provider`（固定 `"acp"`）、`mode`（`"normal" | "plan" | "yolo"`，默认 `"normal"`）、`reasoning_effort`（`"" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`，默认 `""`）。
- `sessions.json`：`runtime.activeRuntime = "doubao"`，并在 `runtime.doubao` 中持久化 `sessionId`、`cwd`、`provider: "acp"`、`model`、`mode`、`reasoningEffort`。
- `channel-chats.json`：`runtimeBridgeSessionIds.doubao` 记住每个聊天独立的 Doubao BridgeSession。
- Operator UI、`/set`、`/current` 和 `codelark setup` 向导（自动探测 `~/.doubao` / `~/.local/share/doubao_cli`）均原生支持 Doubao 配置与会话管理。

## 模块结构

- 共享 ACP 客户端：`src/runtime/acp/client.ts`（同时被 `src/runtime/cursor/acp-client.ts` 与 Doubao 复用）
- Doubao ACP Provider：`src/runtime/doubao/acp-provider.ts`
- 模型列表解析与模糊匹配：`src/runtime/doubao/models.ts`
- 会话列表缓存、查询与删除：`src/runtime/doubao/session-index.ts`

## 测试覆盖与验收边界

- 单元测试覆盖 `DoubaoAcpProvider` 协议交互（流式正文/思考/工具/计划、跨进程 `session/load` 历史回放抑制、热更新 mode/model/effort、权限审批与 yolo 自动放行、取消与重试）、`models.ts` 日志混杂 JSON 解析、`session-index.ts`、`json-schemas.test.ts`、全部 IM 命令/TOML/Operator UI/setup-wizard 配置链路。
- 本地子进程 E2E（`src/__tests__/e2e/local-process/doubao/doubao-acp.e2e.test.ts`）通过真实 stdio JSON-RPC 子进程验证 `AcpClient` + `DoubaoAcpProvider` + `processMessage` 全链路。
- 若涉及飞书客户端卡片视觉表现的最终验收，仍需在隔离测试群进行真实端手测。
