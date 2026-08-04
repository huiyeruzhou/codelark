# CodeLark 产品文档

这是 CodeLark 的产品功能文档入口。文档按网页目录组织：每页聚焦一个主题，既面向用户理解功能，也为开发者提供源码入口。

如果要快速完成一次任务，先看 [5 分钟上手：日常工作流](../guide/daily-workflow.md)；安装配置见 [用户文档](../guide/)。如果要理解底层身份链路，再看 [当前架构](../architecture/current.md)。

## 阅读路径

1. [命令体系](commands.md)：IM 命令如何按用户任务分组。
2. [运行时与提供方](runtime-providers.md)：Codex / Claude Code / Kimi Code 与 sdk / pty / tmux 的能力边界。
3. [通道](channels-ui.md)：飞书、多实例配置、流式卡片和云文档入口。
4. [Web 工作台](operator-ui.md)：本地管理面的能力矩阵、信息架构、视觉方向和测试合同。
5. [数据、可观测性与验证](data-observability.md)：本地文件、日志、状态、真实飞书 E2E。
6. [开发者源码地图](developer-map.md)：按功能查源码和测试。

## 产品主线

CodeLark 是一个运行在本机的桥接应用，把本机 Codex、Claude Code 和 Kimi Code 会话接入飞书 IM 通道，让用户可以在聊天软件里继续本地 AI coding session、切换线程、查看状态、处理权限、接收流式卡片、回传文件，并用 Web 工作台管理通道和会话。

核心链路是：

```mermaid
flowchart LR
  im[IM 消息]
  adapter[通道 Adapter]
  chat[ChannelChat]
  session[BridgeSession]
  runtime[Codex / Claude Code / Kimi Code Runtime]
  response[IM 回复 / 流式卡片]

  im --> adapter
  adapter --> chat
  chat --> session
  session --> runtime
  runtime --> response
```

CodeLark 自己拥有的是 `BridgeSession`、`ChannelChat`、通道配置、消息缓存和审计日志；Codex / Claude Code / Kimi Code 自己的会话文件仍由对应工具生成和维护。

## 代码入口

| 主题 | 入口 |
| --- | --- |
| CLI 和本地服务 | [src/entrypoints/cli.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/entrypoints/cli.ts)、[src/local-service/manager.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/local-service/manager.ts) |
| Bridge 主循环 | [src/entrypoints/daemon.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/entrypoints/daemon.ts)、[src/bridge/host/manager.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/host/manager.ts) |
| Web 工作台 | [src/operator-ui/server.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/operator-ui/server.ts)、[src/operator-ui/shell.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/operator-ui/shell.ts) |
| IM 通道抽象 | [src/channels/contracts.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/channels/contracts.ts) |
| 命令分发 | [src/bridge/command/dispatch.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/dispatch.ts) |
| 运行时提供方路由 | [src/runtime/codex/routing-provider.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/runtime/codex/routing-provider.ts) |
| 本地 JSON 存储 | [src/storage/json-store.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/storage/json-store.ts) |
| 配置 schema | [schemas/config.v2.schema.json](https://github.com/huiyeruzhou/codelark/blob/main/schemas/config.v2.schema.json) |

## 维护原则

- 功能说明先写“用户能做什么、为什么需要、什么时候用”，再写设计模块和源码入口。
- 不把实现细节写成产品承诺。
- 不把废弃字段当成运行时概念，例如旧 `sdk_session_id`、`desktop_thread_id`、`thread_origin`。
- 涉及真实飞书行为时，同步检查 [真实飞书 E2E](../testing/real-feishu/) 和 [覆盖审计](../testing/coverage-audit.md)。
