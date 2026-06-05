# 生命周期与解耦评估

本文记录一次面向维护者的架构评估，回答三个问题：

- 当前项目实际有几个主要进程，生命周期如何启动和停止。
- 哪些运行时边界由谁拥有，哪些只是 bridge 内部的调度或展示机制。
- 哪些模块已经有清晰边界，哪些地方值得继续解耦。

本文是现状审计，不是消息链路说明，也不是强制改造方案。消息投递、lane、mirror 渲染链路的细节见 [当前架构](./current.md)；本文只保留它们对生命周期和解耦判断有影响的结论。

## 进程拓扑

CodeLark 的常见稳态由几个进程或外部运行体组成。

| 运行体 | 入口 | 生命周期 owner | 主要状态文件 | 职责 |
| --- | --- | --- | --- | --- |
| CLI 一次性进程 | `src/entrypoints/cli.ts` | 用户命令 `codelark ...` | 无长期状态 | 执行 `run`、`start`、`status`、`stop`、`setup` 等本地服务管理动作。 |
| UI server | `src/operator-ui/server.ts` | `src/local-service/manager.ts` 的 `ensureUiServerRunning()` | `~/.codelark/runtime/ui-server.json` | 提供本地工作台页面和 API，默认监听 `4781`，端口被占用时向后探测。 |
| Bridge daemon | `src/entrypoints/daemon.ts` | `src/local-service/manager.ts` 或 `scripts/daemon.sh` | `~/.codelark/runtime/status.json`、`bridge.pid`、instance lock | 连接 IM 通道、运行消息主循环、协调命令、turn、mirror、权限和 delivery。 |
| Feishu WebSocket 连接 | `src/channels/feishu/adapter.ts` | Bridge daemon 内的 adapter lifecycle | adapter 内存状态、audit log | 接收飞书事件，转换成 `InboundMessage`，并发送文本、文件、卡片和流式卡片更新。 |
| Codex SDK/exec 子进程 | `src/runtime/codex/provider.ts` | Bridge daemon 内的 Codex SDK provider | Codex 自有 `~/.codex` 数据 | 通过 Codex SDK/exec 执行 prompt，产出 SSE 风格事件。 |
| Codex pty child | `src/runtime/codex/pty-provider.ts` | Bridge daemon 内的 pty provider | 内存中的 pty screen map、Codex JSONL | 在 daemon 内创建 pty child，注入 prompt，读取屏幕和 JSONL mirror。 |
| Codex tmux session | `src/runtime/codex/tmux-provider.ts`、`src/bridge/tmux/*` | tmux server + Bridge daemon 编排 | tmux session、Codex JSONL | 在 tmux 中运行 Codex TUI，Bridge 通过 tmux CLI 注入输入和捕获屏幕。 |
| Claude pty child | `src/runtime/claude/pty-provider.ts` | Bridge daemon 内的 Claude pty provider | 内存中的 pty session map、Claude JSONL | 在 pty 中运行 Claude Code，注入 prompt，读取屏幕和 JSONL mirror。 |

`codelark run` 会尝试启动 UI server 和 Bridge daemon；`codelark start` 只启动 Bridge daemon。启动 Bridge 前，`src/local-service/manager.ts` 会为当前 CodeLark 配置初始化专属 lark-cli 运行环境，并把 `LARK_CHANNEL_CONFIG` / `LARKSUITE_CLI_CONFIG_DIR` 注入 daemon。Linux 下 `scripts/daemon.sh start` 使用 `setsid` 或 `nohup` 启动 `dist/daemon.mjs`，macOS 走 launchctl，Windows 走 PowerShell supervisor。

## Bridge Daemon 启动生命周期

Bridge daemon 的启动路径集中在 `src/entrypoints/daemon.ts`：

1. 抢占 bridge instance lock，避免重复 daemon。
2. 运行本地存储迁移。
3. 读取配置，创建 `JsonFileStore`、`PendingPermissions` 和 `CodexRoutingProvider`。
4. 通过 `initBridgeContext()` 注入 store、llm、permission gateway 和 lifecycle hook。
5. 调用 `bridgeManager.start()`。
6. `bridgeManager.start()` 同步通道 adapter，启动成功后设置 `state.running = true`。
7. 为每个运行中的 adapter 启动消费 loop。
8. 启动定时 reconcile：adapter 配置、session health、terminal runtime、mirror poll。
9. 写入 `bridge.pid` 和 `status.json`。
10. 监听 `SIGTERM`、`SIGINT`、`SIGHUP`，停止 bridge、释放锁并写入停止状态。

`src/local-service/manager.ts` 负责从 CLI 侧启动和停止 daemon。它在启动前检查 status、PID、preflight、start lock 和 stale lock，然后 detached spawn `dist/daemon.mjs`，再轮询 `status.json` 等待 daemon 报告 `running=true`。

## 内部生命周期边界

这几个机制容易被误解成独立进程或通用事件总线，但当前实现都运行在 Bridge daemon 内：

| 机制 | 生命周期 owner | 当前边界 | 解耦判断 |
| --- | --- | --- | --- |
| Adapter ingress | Bridge manager + adapter runtime | adapter 把平台事件转成 `InboundMessage`，adapter runtime 负责消费和调度。 | 边界可用，但 manager 仍承担太多路由细节。 |
| Lane 调度 | adapter runtime + session executor | lane 表达消息之间的等待关系；同一工作会话串行，不同会话、控制动作和部分长 I/O 可并行。 | 概念已经清楚，应该继续从 manager 中拆成独立 ingress/router 服务。 |
| Turn progress | interactive turn / mirror turn | SDK stream 和 JSONL mirror 都写入 `UnifiedTurnProgressState`。 | 这是当前最值得保留和强化的内部语义边界。 |
| Mirror reconcile | mirror runtime | `fs.watch` / poll 只唤醒 reconcile；订阅间有界并发，单订阅内按 cursor 顺序处理。 | 边界清晰，复杂度来自 JSONL 不确定性、回声抑制和终态归属。 |
| Stream UI | stream feedback + channel adapter | runtime-neutral 层只表达 text/history/tools/tasks/status/finalize；Feishu adapter 负责 CardKit 状态机。 | 抽象方向正确，但能力协商仍分散。 |

因此，本文后续不再重复消息投递、lane 分类、mirror records 或 Feishu 卡片 diff 的完整链路。评估重点放在 owner 是否清楚、状态是否集中、模块是否容易单测。

## 现有好的边界

以下边界值得保留：

- `InboundMessage` / `OutboundMessage`：通道抽象明确，平台事件不会直接流入 bridge 业务层。
- `ChannelChat -> BridgeSession`：IM chat 不直接绑定 runtime thread，便于切换和接管。
- `CodexRoutingProvider`：Codex SDK、Codex pty、Codex tmux、Claude pty、Claude sdk 有统一 `LLMProvider.streamChat()` 入口。
- `UnifiedTurnProgressState`：SDK stream 和 mirror record 的共同语义模型。
- `MirrorJsonlSource`：Codex 和 Claude JSONL source 共享 mirror runtime。
- `TurnCoordinator`：active IM turn 和外部 terminal/mirror 终态之间有显式 claim 机制。
- `local-service/manager.ts`：CLI 侧服务管理和 daemon 内部 bridge 生命周期分离。

## 主要耦合点

### 1. `bridge/host/manager.ts` 是过厚的宿主总管

该文件同时承担：

- adapter lifecycle
- adapter loop 到 message handling
- command routing 入口
- interactive turn 依赖装配
- mirror runtime 装配
- session health runtime 装配
- startup notice
- auto task
- tmux/pty 运行中特例
- stop/cleanup

风险：

- 新增功能容易直接在 manager 中插入特例。
- 生命周期状态散落在同一个全局 state 对象。
- 单元测试需要构造过多无关依赖。
- 很难从代码结构看出“进程生命周期”和“业务消息处理”哪个是主轴。

### 2. `channels/feishu/adapter.ts` 同时承担平台连接、转换、发送和卡片状态机

该文件同时处理：

- WSClient/EventDispatcher。
- 飞书 inbound 内容解析、附件下载、mention 清洗。
- outbound text/post/card/file/reaction。
- 权限卡片和普通 rich card。
- streaming card 的复杂增量刷新状态。
- chat/group 管理。

风险：

- Feishu 平台协议变化会影响 stream card 逻辑的可读性。
- 卡片状态机难以单独压测。
- 通用 channel contract 与 Feishu CardKit 细节交织。

### 3. Command dispatch 仍是集中式大 switch

`bridge/command/dispatch.ts` 已拆出不少 handler，但入口仍是一个大 switch。

风险：

- 命令增加时冲突和顺序规则不显式。
- callback、form、slash 文本和 command alias 的关系难以整体审计。
- 每次修改一个命令都容易需要理解整个 dispatch。

### 4. Stream feedback 与平台能力协商分散

`runInteractiveMessage()`、`stream-ui-controller.ts`、Feishu adapter 和 mirror feedback controller 都需要知道某种形式的 stream UI 能力。

风险：

- 最终消息是否跳过、卡片是否 active、状态是否 persistent 的判断分散。
- 新增通道时，容易复制 Feishu 的隐含行为。

### 5. Runtime provider 的进程模型没有统一生命周期视图

SDK、pty、tmux、Claude pty 的实际运行体不同，但对外都叫 provider。

风险：

- 用户和维护者难以判断“当前到底有哪些进程仍在运行”。
- stop/force stop/append input/screen capture 这些行为在 provider 之间语义不同。
- UI status 难以解释 tmux server、pty child、SDK exec 子进程和 mirror JSONL 的关系。

## 解耦建议

### 优先级 P1：拆薄 Bridge manager

目标不是一次性重写，而是先把生命周期轴线命名清楚。

建议拆出：

- `BridgeApplication`：只负责 start/stop 和组合服务。
- `ChannelIngressService`：adapter loop、lane/session 调度、message ack。
- `MessageRouter`：权限快捷回复、terminal append、command、ordinary prompt 的分流。
- `TurnOrchestrator`：包装 `runInteractiveMessage()` 所需依赖，隔离 manager 对 turn 的装配细节。
- `BridgeLifecycleState`：收敛 daemon 内全局 state，不让每个 feature 直接扩展 manager state。

验收标准：

- `bridge/host/manager.ts` 不再直接包含普通消息的完整路由细节。
- adapter loop 和 `handleMessage()` 可独立单测。
- mirror、health、auto task 的装配入口仍在应用层，但业务逻辑不留在应用层。

### 优先级 P1：拆 Feishu adapter 的四个角色

建议拆出：

- `FeishuEventSource`：启动 WSClient，注册 EventDispatcher，只发出平台事件。
- `FeishuInboundMapper`：平台事件和内容下载转换成 `InboundMessage`。
- `FeishuOutboundClient`：发送 text/post/card/file/reaction/group 操作。
- `FeishuStreamingCardController`：CardKit v2 state、flush plan、batch update、full refresh。

验收标准：

- `BaseChannelAdapter` 实现文件主要做组合。
- streaming card controller 可以用 fake outbound client 做单元测试。
- inbound mapper 可以用录制的平台 payload 做纯函数测试。

### 优先级 P2：命令注册表化

把大 switch 逐步收敛成 registry：

```ts
interface BridgeCommandHandler {
  names: string[];
  scope: 'channel' | 'session' | 'global';
  run(ctx: BridgeCommandContext): Promise<BridgeCommandResult>;
}
```

短期不需要重写所有命令。可以先让现有 handler 通过 registry 调用，保留 command alias 和 presentation。

验收标准：

- 新增命令不需要修改一个超长 switch。
- 命令 scope、是否需要 session、是否允许无绑定，在元数据中可见。
- callback/form command 能和 slash command 使用同一套 command result。

### 优先级 P2：建立 Runtime Process Registry

新增一个只读 registry，统一描述当前 runtime 运行体：

- daemon PID。
- UI PID。
- adapter running state。
- SDK active task。
- pty child/session。
- tmux session/pane。
- mirror subscription file path、dirty、last reconciled。

它不一定负责控制生命周期，先负责解释生命周期。

验收标准：

- `/status` 和 UI status 可以显示“当前有哪些本地运行体”。
- stop/force stop 可以记录自己实际停止了哪个运行体。
- 文档中的进程拓扑能从代码 API 读出来，而不是靠人工推断。

### 优先级 P3：收敛 Stream UI 能力协商

定义一个 runtime-neutral 的 `StreamUiCapability` 或 `StreamDeliveryPolicy`：

- 是否支持 structured streaming card。
- 是否支持 persistent status。
- final text 是否由 card 承载。
- card active 判断方式。
- fallback delivery 策略。

验收标准：

- `runInteractiveMessage()` 不需要理解 Feishu 的特殊判断。
- 新通道可以显式声明能力，而不是靠存在某些 optional method 推断全部行为。

### 优先级 P3：把 mirror parser 和 delivery 的测试矩阵文档化

Mirror 的复杂度合理，但需要固定测试面：

- JSONL partial line。
- file rotation / truncation。
- duplicated assistant text。
- task_started/task_complete 缺失。
- active turn terminal claim。
- suppression window。
- blocked session pending delivery。

验收标准：

- 每个 mirror 边界都有至少一组单元测试或 harness scenario。
- 修改 parser 或 delivery plan 时，维护者能知道必须跑哪些测试。

## 建议演进顺序

1. 先做 Runtime Process Registry，只读、低风险，立刻改善可观测性和维护者理解。
2. 拆 `MessageRouter` 和 `ChannelIngressService`，把 manager 的消息主路径拿出来。
3. 拆 Feishu streaming card controller，因为这是最重的单文件状态机。
4. 命令 registry 化，降低后续命令增长成本。
5. 收敛 stream UI capability，让新通道接入更可控。

## 不建议做的事

- 不建议引入通用 Observable、FRP 或全局 signal 框架。当前复杂度来自外部平台和 runtime 生命周期，不来自缺少响应式抽象。
- 不建议把 mirror、SDK stream、Feishu card update 合并成一个“事件总线”。它们的失败模式不同，强行统一会掩盖重要边界。
- 不建议先做大规模目录搬迁。先用小服务抽取和测试固定边界，再移动文件。
- 不建议让 ChannelChat 直接绑定 Codex thread。当前 `ChannelChat -> BridgeSession -> runtime identity` 的间接层是正确的产品边界。

## 一句话结论

CodeLark 当前最需要的不是更强的 stream/signal 抽象，而是更清晰的生命周期视图和更薄的编排层。优先把 `bridge/host/manager.ts` 和 `channels/feishu/adapter.ts` 的职责拆开，同时强化 `UnifiedTurnProgressState` 作为内部语义边界。
