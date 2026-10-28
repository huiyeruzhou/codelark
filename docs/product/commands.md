# 命令体系

IM 命令从用户视角分为五组。命令入口是 [src/bridge/command/dispatch.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/dispatch.ts)，具体处理按工作流拆在 [src/bridge/command/](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/) 下；会话、绑定、线程接管和归档的业务规则归 [src/bridge/session/](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/session/) 所有，command 层主要负责 slash 解析、用户文案、卡片和 delivery。

| 分组 | 典型命令 | 功能 |
| --- | --- | --- |
| 会话和线程 | `/t`、`/new`、`/fork`、`/clear`、`/t rename`、`/t unbind` | 接管、新建、分叉、云文档群聊模式、切换、归档、重命名、解绑会话 |
| runtime 设置 | `/runtime`、`/provider`、`/model`、`/mode`、`/reasoning`、`/sandbox`、`/network`、`/cd` | 修改当前会话的运行参数 |
| 状态和诊断 | `/`、`/status`、`/check`、`/doctor`、`/his` | 查看状态、健康检查、历史和排障 |
| 终端和文件 | `/shell`、`/tmux-*`、`/pty-screen`、`/cat`、`/file` | 执行命令、观察终端、发送文件（图片直接发为图片） |
| 自动化和管理 | `/every`、`/then`、`/require-at`、`/customer`、`/whitelist`、`/ui`、`/set`、`/hot-update` | 定时输入、后续输入、会话触发策略、客服群与管理员、显示和全局设置 |

从本机 `audit.jsonl` 的匿名聚合看，普通消息占绝大多数；命令使用主要集中在 `/tmux-screen`、`/p tmux`、`/new`，随后是 `/clear`、`/every`、`/runtime`、`/t` 和 `/set`。用户教程据此优先讲“新建任务—直接对话—观察 tmux—继续或切换会话”，详见 [5 分钟上手：日常工作流](../guide/daily-workflow.md)。

## 用户使用原则

- 直接发送普通文本：继续当前绑定会话。
- 直接发送 `/fork [新群名]`：默认从当前会话最近一张已完成的 Codex 对话卡片分叉；运行中、失败和中断卡片不会被默认选中。回复已结束或已续接的卡片发送同一命令则精确选择该卡片。省略名称时使用原会话名加 `fork`。
- 分叉创建独立 Agent 会话和飞书群，并把操作者加入新群；默认仅将所选卡片及之前最近 10 条有效消息按时间顺序逐条转发到新群，最多 11 条，不足则全部转发，系统提示与已删除消息不计数。直接 `/fork` 和回复卡片均遵循此限制。按卡片创建时间倒序分页获取，凑齐后停止，不扫描全群历史。消息读取失败时不创建分支；部分转发失败时明确返回新群链接及已转发数量，不报全部成功。Agent 仍继承截至所选卡片的完整原生对话历史，转发范围不影响记忆，也不会把转发记录再次输入模型。
- 默认选择需要卡片记录已完成状态；升级前仅记录了历史边界的卡片仍可通过“回复”分叉。转发后的有效 Codex 卡片保留边界，可继续从它们分叉。
- 分支沿用工作目录及会话设置，但只复制对话历史，不复制或回退文件。原会话可继续运行。当前仅支持本机 Codex；旧版本卡片、活动卡片、单条原生记录的中间分页、外部 app-server 和其他 runtime 会明确拒绝，不会用最新历史替代卡片边界。
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

Codex thread 模式中，单独发送 `<C-c>`（也支持 `<Ctrl+C>`、`<Cmd+C>`）等同 `/stop`，请求中断当前轮次；没有运行中的轮次时只返回空闲提示。其他终端按键及组合序列（例如 `<Enter>`、`<Esc>`、`<C-c><Enter>`）直接返回不支持，不会提交给模型。`/tmux` 和 `/tmux-key` 使用同样规则；正文或代码块中的按键示例仍按普通消息发送。

IM 内 `/h` 的文案由 [src/bridge/command/help.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/command/help.ts) 生成。Web 工作台“命令说明”页面在 [src/operator-ui/shell.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/operator-ui/shell.ts) 中渲染。新增命令时需要同步这两处用户入口。

模块边界：生产代码中只有 `bridge/host` 直接调用 `bridge/command`；通道、turn、runtime 等横向 owner 不直接 import command，command 也不反向 import `bridge/host/*`。跨 turn 和 command 共用的 agent question 回调协议位于 [src/bridge/callbacks/agent-question.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/callbacks/agent-question.ts)。命令需要的聊天绑定和 startup target 共享入口分别是 [src/bridge/session/channel-router.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/session/channel-router.ts) 和 [src/bridge/startup-notice-target.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/startup-notice-target.ts)。

`/require-at on|off|status`（别名 `/require_at`）只控制当前绑定会话的群聊 @bot 要求，也可在 `/current common` 修改。私聊不受影响；`/clear`、`/new` 和首次切换到新 runtime 会话会继承设置，切回已有会话保留其自身设置。

`/customer` 查看当前群客服模式，`/customer on|off` 开启或关闭；已有话题内执行也修改所属群。`/whitelist` 查看客服管理员，`/whitelist add|remove @成员` 管理名单。两者均要求客服控制权限，空名单默认 bot 创始人，是否需要 @ 仍遵循群设置。详见 [客服模式](./customer-service.md)。

飞书附件在对应消息或富文本图片位置显示本地路径。合并转发会按子消息的原始 message_id 自动读取有权限访问的原消息，取得可下载的 key；无法读取时保留资源标识、限制原因和 lark-cli 恢复步骤。自动下载预算为每条消息累计 20 MiB、最多 20 个附件；已知大小或响应 Content-Length 超限时不读取正文，大小未知时有界读取并及时停止。未下载的附件保留 message_id、file_key、类型、名称、已知大小与按需下载命令。
