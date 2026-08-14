# 命令体系

IM 命令从用户视角分为五组。命令入口是 [src/bridge/command/dispatch.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/dispatch.ts)，具体处理按工作流拆在 [src/bridge/command/](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/) 下；会话、绑定、线程接管和归档的业务规则归 [src/bridge/session/](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/session/) 所有，command 层主要负责 slash 解析、用户文案、卡片和 delivery。

| 分组 | 典型命令 | 功能 |
| --- | --- | --- |
| 会话和线程 | `/t`、`/new`、`/clear`、`/t rename`、`/t unbind` | 接管、新建、云文档群聊模式、切换、归档、重命名、解绑会话 |
| runtime 设置 | `/runtime`、`/provider`、`/model`、`/mode`、`/reasoning`、`/sandbox`、`/network`、`/cd` | 修改当前会话的运行参数 |
| 状态和诊断 | `/`、`/status`、`/check`、`/doctor`、`/his` | 查看状态、健康检查、历史和排障 |
| 终端和文件 | `/shell`、`/tmux-*`、`/pty-screen`、`/cat`、`/file` | 执行命令、观察终端、发送文件 |
| 自动化和管理 | `/every`、`/then`、`/require-at`、`/ui`、`/set`、`/hot-update` | 定时输入、后续输入、通道策略、显示和全局设置 |

从本机 `audit.jsonl` 的匿名聚合看，普通消息占绝大多数；命令使用主要集中在 `/tmux-screen`、`/p tmux`、`/new`，随后是 `/clear`、`/every`、`/runtime`、`/t` 和 `/set`。用户教程据此优先讲“新建任务—直接对话—观察 tmux—继续或切换会话”，详见 [5 分钟上手：日常工作流](../guide/daily-workflow.md)。

## 用户使用原则

- 直接发送普通文本：继续当前绑定会话。
- 发送 `//...`：把以 `/` 开头的内容作为模型 prompt，而不是 bridge 命令。
- 新聊天收到普通文本或 slash 命令时，都会先按当前默认 runtime 建立隐藏的临时 BridgeSession；正式接管用 `/t`。
- 修改当前会话参数优先用 `/runtime`、`/provider`、`/model`、`/cd` 等会话级命令。
- 修改全局默认值用 `/set`；卡片按 TOML section 写入 `~/.codelark/config.toml`。
- `/reasoning` 会按当前 runtime 展示有效选项：Codex 到 `ultra`、Claude 到 `max`、Kimi 为 on/off、Cursor 为模型 effort；ZCode 不映射该命令，使用 ZCode 自己的原生命令。
- `/every` 用于按固定间隔重复发送 prompt；`/then` 用于在当前会话 completed/interrupted 后发送一次后续 prompt。两者都支持列表卡片和卡片操作，`/then` 还支持通过卡片新建、修改和取消。
- `/doctor` 可不带参数；也可使用 `/doctor bridge_id:d3c20e05 2026-06-04 17:48` 或 `/doctor d3c20e05 2026-06-04 17:48`，让当前会话读取结构化 JSONL `bridge.log` 时优先用目标 id 和时间点搜索，并优先检查 `level=ERROR/WARN`、`event`、`msg`、`chat`、`lane` 等字段。

## 设计模块

| 命令主题 | 模块 |
| --- | --- |
| 帮助 | [src/bridge/command/help.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/help.ts) |
| 会话和线程 | [src/bridge/session/](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/session/)；slash 聚合入口在 [src/bridge/command/session-thread.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/session-thread.ts) |
| runtime 设置 | [src/bridge/command/runtime-settings.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/runtime-settings.ts)、[src/bridge/command/provider-settings.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/provider-settings.ts)、[src/bridge/command/runtime-bootstrap.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/runtime-bootstrap.ts)、[src/bridge/command/runtime-session.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/runtime-session.ts) |
| 全局设置 | [src/bridge/command/global-settings.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/global-settings.ts) |
| 状态 | [src/bridge/command/status.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/status.ts) |
| 诊断和历史 | [src/bridge/command/diagnostics.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/diagnostics.ts) |
| 控制和权限 | [src/bridge/command/control.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/control.ts) |
| tmux | [src/bridge/command/tmux.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/tmux.ts)、[src/bridge/command/tmux-args.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/tmux-args.ts) |
| pty 屏幕 | [src/bridge/command/pty.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/pty.ts) |
| shell | [src/bridge/command/shell.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/shell.ts) |
| 定时/后续输入 | [src/bridge/command/every.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/every.ts)、[src/bridge/command/then.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/then.ts) |
| 热更新 | [src/bridge/command/hot-update.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/hot-update.ts) |
| 展示格式 | [src/bridge/command/presentation/](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/presentation/) |

## 命令展示

IM 内 `/h` 的文案由 [src/bridge/command/help.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/help.ts) 生成。Web 工作台“命令说明”页面在 [src/operator-ui/shell.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/operator-ui/shell.ts) 中渲染。新增命令时需要同步这两处用户入口。

模块边界：生产代码中只有 `bridge/host` 直接调用 `bridge/command`；通道、turn、runtime 等横向 owner 不直接 import command，command 也不反向 import `bridge/host/*`。跨 turn 和 command 共用的 agent question 回调协议位于 [src/bridge/callbacks/agent-question.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/callbacks/agent-question.ts)。命令需要的聊天绑定和 startup target 共享入口分别是 [src/bridge/session/channel-router.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/session/channel-router.ts) 和 [src/bridge/startup-notice-target.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/startup-notice-target.ts)。
