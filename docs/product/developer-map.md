# 开发者源码地图

## 按功能找代码

| 功能 | 主要源码 |
| --- | --- |
| CLI、setup、run/start/stop/status | [src/entrypoints/cli.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/entrypoints/cli.ts)、[src/local-service/manager.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/local-service/manager.ts) |
| Bridge 启动和消息主循环 | [src/entrypoints/daemon.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/entrypoints/daemon.ts)、[src/bridge/host/manager.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/bridge/host/manager.ts) |
| 通道抽象和 adapter | [src/channels/contracts.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/channels/contracts.ts)、[src/channels/feishu/](https://github.com/huiyeruzhou/codelark/blob/master/src/channels/feishu/) |
| 命令分发和命令展示 | [src/bridge/command/dispatch.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/bridge/command/dispatch.ts)、[src/bridge/command/](https://github.com/huiyeruzhou/codelark/blob/master/src/bridge/command/) |
| 会话、绑定、线程接管、工作目录和 runtime 设置 | [src/bridge/session/](https://github.com/huiyeruzhou/codelark/blob/master/src/bridge/session/)、[src/domain/session-runtime.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/domain/session-runtime.ts)、[src/bridge/session/channel-router.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/bridge/session/channel-router.ts) |
| Codex provider | [src/runtime/codex/provider.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/runtime/codex/provider.ts)、[src/runtime/codex/pty-provider.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/runtime/codex/pty-provider.ts)、[src/runtime/codex/tmux-provider.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/runtime/codex/tmux-provider.ts) |
| Claude Code provider | [src/runtime/claude/tmux-provider.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/runtime/claude/tmux-provider.ts)、[src/runtime/claude/pty-provider.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/runtime/claude/pty-provider.ts)、[src/runtime/claude/sdk-provider.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/runtime/claude/sdk-provider.ts)、[src/runtime/claude/session-jsonl.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/runtime/claude/session-jsonl.ts) |
| 交互 turn 和 SDK stream | [src/bridge/turn/interactive/](https://github.com/huiyeruzhou/codelark/blob/master/src/bridge/turn/interactive/) |
| mirror | [src/bridge/mirror/runtime.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/bridge/mirror/runtime.ts)、[src/bridge/mirror/turns.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/bridge/mirror/turns.ts)、[src/bridge/mirror/feedback-controller.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/bridge/mirror/feedback-controller.ts) |
| Web 工作台 | [src/operator-ui/server.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/operator-ui/server.ts)、[src/operator-ui/shell.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/operator-ui/shell.ts)、[src/operator-ui/routes/](https://github.com/huiyeruzhou/codelark/blob/master/src/operator-ui/routes/) |
| 本地 JSON store | [src/storage/json-store.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/storage/json-store.ts)、[schemas/](https://github.com/huiyeruzhou/codelark/blob/master/schemas/) |
| 真实飞书 E2E | [scripts/real-feishu-e2e.ts](https://github.com/huiyeruzhou/codelark/blob/master/scripts/real-feishu-e2e.ts) |

## 推荐阅读顺序

1. 先读 [产品文档入口](index.md#产品主线)，确认用户语义。
2. 再读 [当前架构](../architecture/current.md)，确认 `BridgeSession`、`ChannelChat`、runtime identity 和 mirror 的边界。
3. 找到对应命令或 UI route。
4. 找到对应 adapter/provider/store 模块。
5. 查看同名或邻近测试，例如 `src/__tests__/command-dispatch.test.ts`、`src/__tests__/bridge-command-e2e.test.ts`、`src/__tests__/feishu-adapter-card-e2e.test.ts`、`src/__tests__/real-feishu-e2e-harness.test.ts`。
6. 如果功能影响真实飞书行为，再更新 [真实飞书 E2E](../testing/real-feishu/) 和必要的 harness scenario。

## 文档同步清单

新增或修改产品功能时，同步检查：

- [README.md](https://github.com/huiyeruzhou/codelark/blob/master/README.md) 是否需要更新快速介绍或入口链接。
- 本产品文档目录是否需要新增或修改页面。
- [当前架构](../architecture/current.md) 是否需要更新设计边界。
- [覆盖审计](../testing/coverage-audit.md) 是否需要更新测试覆盖。
- [真实飞书 E2E](../testing/real-feishu/) 是否需要更新真实飞书证据。
- schema、UI、命令帮助是否仍和文档一致。

文档应优先描述“用户能做什么、为什么需要、何时使用”，再给出设计模块和源码入口。
