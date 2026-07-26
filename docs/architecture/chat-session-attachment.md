# Chat 与 Session 接管契约

本文定义 `/t`、卡片“接管”和 Web 工作台切换 binding 共用的语义。这里的 attach 是“把一个 IM chat 接到一个 BridgeSession”；`/tmux-attach` 只改变当前 BridgeSession 使用的终端 pane，二者不是同一层操作。

## 第一性原理

一次普通消息必须能唯一回答三个问题：消息来自哪个 chat、这个 chat 已提交的 BridgeSession 是哪一个、该 BridgeSession 的 runtime identity 是哪一个。任何 fallback、半提交状态或跨 chat 复用都会让回复地址和模型上下文分叉。

因此必须满足这些不变量：

1. `ChannelAddress(channelType, chatId)` 是 binding 的完整主键。群聊、私聊、不同机器人实例和不同平台不得按 `userId`、显示名或 runtime id 互相 fallback。
2. runtime/数量下拉只是本地列表 query，不启动或停止 tmux，不修改 binding，也不触发运行中确认。
3. attach 是显式 mutation。只有选择具体 session 并点击“接管”，或发送 `/t <target>`，才允许修改 binding。
4. 如果当前 session 正在运行，先展示确认；取消时状态完全不变。确认后先停止并等待旧任务收口，再提交新 binding。
5. 提交时同时确定 `bridgeSessionId` 和该 runtime 的 `runtimeBridgeSessionIds[runtime]`；其他 runtime 的映射保留。后续普通消息只能读取已提交的新 binding。
6. 目标被其他 chat 占用且正在运行时拒绝接管；目标空闲时必须再次取得用户同意，解绑旧 chat 后才能迁移 ownership。
7. stale confirmation 必须 fail closed：确认期间 current binding 已变化时，不停止任何任务，也不继续切换。
8. 飞书 card callback 只负责把 action 入内部队列并立即 ACK；停止、session materialize、binding 提交和卡片更新均在 ACK 后执行。

## 用户故事矩阵

| 场景 | 必须观察到的结果 |
| --- | --- |
| 同一用户先后在私聊和群聊发第一句话 | 两个 chat 创建不同 draft BridgeSession；消息历史、runtime 和回复地址互不共享。 |
| 在 `/t` 卡片切换 Codex/Claude/Kimi 列表 | 只更新该卡片的候选列表；active binding/runtime/tmux 均不变化。 |
| 当前空闲，从 Codex 接管已有 Kimi session | binding 原子切到 Kimi BridgeSession；保留原 Codex mapping；下一句话进入选中的真实 Kimi session。 |
| 当前任务运行中，用户取消 | 旧任务继续，binding/runtime/mapping 不变化。 |
| 当前任务运行中，用户确认 | 先停止旧任务并记录终态，再切 binding；接管提交前到达的下一句话等待 routing barrier，最终按新 runtime 路由。 |
| 目标在另一个 chat 运行 | 拒绝，不改变两边 binding。 |
| 目标在另一个 chat 空闲 | 明确确认后迁移 ownership；旧 chat 不再持有目标 session。 |
| callback 对应大卡片或慢启动 | HTTP callback 在 2 秒内 ACK；后台完成后更新卡片或发送结果。 |
| 接管后在 Codex、Claude、Kimi 间往返 | 每个 runtime 恢复各自 `runtimeBridgeSessionIds` 指向的 BridgeSession，不新建、不串到其他 chat。 |

## 代码边界

- `src/bridge/session/channel-router.ts` 暴露平台无关的 `attachToSession` / `attachToCodexThread`；调用者必须传完整 `ChannelAddress`。
- `src/bridge/session/registry.ts` 与 `registry/bindings.ts` 负责 ownership 校验、materialize 和持久化。
- `src/bridge/session/command-use-cases/attachment-lifecycle.ts` 只处理当前 session 的确认、stale guard、停止和收口；成功返回前不改变 binding。
- `src/bridge/session/stop-running-session.ts` 是 `/stop` 与 `/t` 共用的停止 owner，统一 active task、tmux `C-c` 和健康终态。
- `src/channels/adapter-runtime/runtime.ts` 的 routing barrier 保证 attach 尚未提交时，后续普通消息不会提前解析旧 session。
- `src/channels/feishu/adapter.ts` 的 card action handler 只入队并返回 toast，不等待上述生命周期。

## 禁止模式

- 禁止按 `userId` 或草稿名称复用另一个 chat 的 draft session。
- 禁止先写新 binding，再停止旧 session；`/stop` 会因此误伤新目标。
- 禁止把 runtime 列表筛选实现成 `/runtime` 或 attach。
- 禁止由卡片入口和纯文本入口各维护一套 ownership/停止逻辑。
- 禁止把 callback 的 HTTP ACK 与内部 update offset ACK 混为一谈。
