# 排障指南

本文合并排障步骤和常见问题。遇到问题时，先确认本地 bridge 是否运行，再区分是飞书长连接收不到事件、runtime 没有输出，还是 CardKit 刷新失败。

## 桥接服务无法启动

**现象**：从本地工作台启动 bridge 失败，或者 daemon 启动后立即退出。

**排查步骤**：

1. 运行本地 doctor 脚本，或查看工作台日志定位问题。
2. 确认已安装 Node.js 24+：`node --version`。
3. 确认 Codex CLI 可用：`codex --version`。
4. 确认配置文件存在：`ls -la ~/.codelark/config.json ~/.codelark/config.env`。
5. 查看 `~/.codelark/logs/` 下的启动错误日志。

**常见原因**：

- `config.env` 缺失或内容无效。打开本地工作台并保存一份有效配置。
- Node.js 未安装或版本不正确。安装 Node.js 24+。
- 端口或资源冲突。检查是否已有另一个 bridge 实例正在运行。
- bridge 实例已经死亡，但是 PID 文件仍然存在。可以先尝试 `codelark stop`，仍失败时手动删除 `~/.codelark/runtime/bridge.pid` 后重新启动。

### `codelark run` 后 bridge 启动失败

先查看：

```bash
codelark status
```

再打开工作台日志页，确认飞书凭据、Codex / Claude Code 登录态和本机 Node.js 版本。日志目录通常在：

```text
~/.codelark/logs/
```

## 收不到消息

**现象**：bot 在线，但不会回复消息。

**排查步骤**：

1. 查看 `~/.codelark/logs/bridge.log` 中最近的 JSONL 日志；优先筛选 `level` 为 `ERROR` 或 `WARN`，再看 `msg` 里是否有 `ws client` 或 WebSocket 连接错误。如果有，说明 bridge 没有连上飞书长连接服务器。
2. 查看 `~/.codelark/logs/bridge.log` 中是否有 bot OpenID 相关日志；如果没有获取到，通常是 bot 配置有误，可以用 `codelark setup` 重新配置。
3. 查看 `~/.codelark/logs/bridge.log` 中是否有消息事件日志；结构化日志可重点看 `event`、`channel`、`chat`、`message`、`msg` 字段。如果没有，很可能是飞书 bot 没有添加对应事件回调，或当前应用版本还未发布/审批生效。到飞书开发者后台添加事件与回调后重新发布应用。
4. 如果是在群聊中，尝试 @bot 发送消息，确认是否可以正常回复。`@bot /require-at off` 之后就不必须 @bot。
5. 检查配置中的 allowed user IDs。如果已设置，只有列表中的用户可以交互。

### 飞书配置检查清单

- 飞书应用是否已发布并审批。
- Bot 能力是否已启用。
- 长连接事件订阅是否保存成功。
- `im.message.receive_v1`、`drive.notice.comment_add_v1`、`im.chat.member.bot.deleted_v1`、`im.chat.disbanded_v1` 是否已添加。
- `card.action.trigger` 回调是否已添加。
- 云文档评论回复是否缺少 `docs:document.comment:create` 或 `docs:document.comment:write_only` 权限。
- bridge 是否正在运行。

## 权限或用户限制不符合预期

默认 `CODELARK_FEISHU_ALLOWED_USERS=` 为空，表示不做用户白名单限制。要限制用户，设置为飞书 open_id 列表：

```bash
CODELARK_FEISHU_ALLOWED_USERS=ou_xxx,ou_yyy
```

修改后重启 bridge：

```bash
codelark stop
codelark run
```

如果用户在白名单内仍无法交互，优先检查日志里识别到的 open_id 是否和配置一致。飞书 user id、union id、open_id 不是同一个值。

## 很久没有回复/流式卡片很久没有更新

- 群聊如果太多，先尝试解散不再使用的群聊并重启 bridge。
- 如果不是 `yolo` mode，可能是 agent 卡在权限确认上。可以先用 `/` 查看当前 mode，再按任务风险决定是否用 `/mode yolo` 或 `/m yolo` 切换。
- 如果当前是 tmux/pty provider 路径，可以使用 `/tmux-screen` 或 `/pty-screen` 查看终端状态；Claude Code 默认 tmux 路径用 `/tmux-screen`。
- 如果卡片已经进入终态但没有追加新的纯文本消息，先看卡片上是否已有最终内容和终态 reaction；当前实现会在最终更新失败但已有卡片内容时保留卡片，避免重复发送 fallback 文本。

## 飞书流式卡片不可用

**现象**：飞书只收到最终普通消息，或者已经开启流式卡片但卡片没有出现。

**排查步骤**：

1. 查看 `~/.codelark/logs/bridge.log`；日志是一行一条 JSON 的结构化 JSONL。
2. 搜索飞书错误 `99991672`，或筛选 `level=ERROR/WARN` 后查看 `msg` 和飞书响应字段。
3. 如果错误提到 `cardkit:card:write`、`cardkit:card:read` 或 `im:message:update`，补充对应权限并发布新版本。
4. 新版本审批通过后，重启 bridge。

即使权限正确，Codex SDK 也通常不是逐字 token 流；飞书流式卡片主要展示 thinking、工具进度和最终答案更新。

### 流式卡片没有逐字输出

这是当前预期行为。飞书卡片的 `streaming_mode` 控制 CardKit 打字机展示效果，但 CodeLark 的主要投递机制是本地 desired state 合并、投递计划和 CardKit 刷新。当前 Codex SDK 事件通常在 assistant 消息完成时给出最终文本，所以用户更常看到 thinking、工具进度、状态和最终答案阶段性更新，而不是 token-by-token 输出。

如果卡片完全不更新，再看 `~/.codelark/logs/bridge.log` 中这些日志：

- `Streaming sync plan`
- `cardElement.content:*`
- `card.batchUpdate:*`
- `card.update:streaming_refresh`
- `Streaming card perf summary`

## 命令被当成 slash 命令

发送以 `/` 开头的普通文本时，在前面多加一个 `/`：

```text
//status
```

这会把 `/status` 作为普通消息发给 Codex / Claude Code，而不是执行 CodeLark 命令。

## 本地会话找不到

`/t` 依赖本机 runtime 会话索引。排查顺序：

1. 确认当前 runtime 是否正确：`/runtime codex` 或 `/runtime claude`。
2. 确认 provider 是否符合预期：`/provider sdk`、`/provider pty` 或 `/provider tmux`。
3. 在本机确认 Codex / Claude Code 已经产生过会话。
4. 在工作台查看本地会话列表和 bridge 日志。

如果本机路径是符号链接，CodeLark 会尽量同时识别原始路径和 realpath；仍找不到时，把 `/status` 和相关日志一起用于排查。

## 云文档评论无法回复

能收到 `drive.notice.comment_add_v1` 事件但不能写回评论时，通常是权限问题。检查：

- 飞书控制台是否添加 `docs:document.comment:read`。
- 是否添加 `docs:document.comment:create`。
- 是否添加 `docs:document.comment:write_only`。
- 新权限是否已经重新发布并审批。
- bridge 是否在审批后重启。

云文档转群聊还可能依赖 user auth scope。使用工作台或 setup 重新检查 `lark-cli` 登录和授权状态。

## 卸载和清理

停止 bridge：

```bash
codelark stop
```

如需清理 CodeLark 本地数据，再删除：

```bash
rm -rf ~/.codelark
```

删除 `~/.codelark` 会移除配置、聊天绑定、会话缓存、日志和运行状态；不会删除 Codex / Claude Code 自己的会话数据。
