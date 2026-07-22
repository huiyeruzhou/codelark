# CodeLark 安装与使用指南

## 安装

CodeLark 不接管 `~/.codex`、`~/.claude-code` 或 `~/.claude-code-router` 的模型供应商配置。Codex CLI、Claude Code、CCR 或 API 登录态仍按你的本机环境自行准备；CodeLark 只保存自己的配置和桥接状态。

```bash
# export OPENAI_API_KEY=sk-xxx
npm install -g codelark
codelark run
```

## 前置条件

- 本机已经可以运行 `codelark`。
- 本机已有可用的 Codex 登录态、Claude Code 登录态或对应 API 凭据。
- 本机 PATH 中已有 `tmux` 命令；如果没有，`codelark setup` 会提示确认并自动安装。Linux 使用 `sudo apt update && sudo apt install -y tmux`，macOS 使用 `brew install tmux`，Windows 使用 `winget install --id marlocarlo.psmux --accept-package-agreements --accept-source-agreements` 安装 psmux（提供 `tmux.exe`）。
- 已创建飞书/Lark 自建应用并拿到 `App ID` / `App Secret`，或允许向导通过开放平台扫码创建机器人配置。
- 飞书应用已启用机器人、权限、事件订阅和长连接。详细步骤见 [平台配置指南](platform-setup.md)。

## 首次配置

推荐先运行交互式向导：

```bash
codelark setup
```

向导会依次完成：

1. 检查 `tmux` 是否可用；缺失时先提示用户确认，再按当前系统自动安装。
2. 选择飞书机器人配置方式。
3. 复用 `~/.codelark` 已有配置、扫码创建新 App，或粘贴 `App ID` / `App Secret`。
4. 按本机环境推荐默认 runtime。
5. 选择默认工作目录。
6. 可选设置飞书用户 open_id 白名单。
7. 可选安装 CodeLark skills 和官方 `lark-doc` skill。本地 CodeLark skills 会先安装；官方 `lark-doc` 通过 `npx skills add ...` 单独安装，失败时不会影响本地 skills 可用。

如果用户拒绝在向导中安装 tmux，向导仍会继续保存配置，但会把默认 provider 改为 SDK：`runtime.codex.provider = "sdk"`，并把 Claude 默认 provider 写为 `runtime.claude.provider = "sdk"`。Kimi Code 当前只有 tmux provider，因此需要安装 tmux 后再使用 Kimi runtime。之后安装 tmux 后，可以在 IM 中使用 `/provider tmux` 切回 tmux provider。

机器人配置方式有两种：

- 使用现有 CodeLark 配置：从 `~/.codelark/config.toml` 加载已有 `App ID` / `App Secret`；首次遇到旧版 `config.json` / `config.env` 时会迁移到 TOML，不会读取用户 HOME 下的 `~/.lark-cli`。
- 扫码创建：通过飞书/Lark 开放平台扫码创建 App，`App ID` / `App Secret` 直接来自扫码返回结果。
- 手动引导：直接粘贴飞书开放平台里的 `App ID` 和 `App Secret`。

保存 App 配置后，向导会基于当前 `~/.codelark` 配置初始化 CodeLark 专属 lark-cli runtime，并对这个 App 发起用户 OAuth 授权扫码。授权状态写入 `~/.codelark/runtime/lark-cli/`，不读取或导入默认 `~/.lark-cli`。

默认 runtime 推荐规则：

- 有 `~/.codex`：推荐 Codex。
- 没有 Codex 但有 `~/.claude-code-router`：推荐 Claude Code Router，并使用 `ccr`。
- 没有前两者但有 `~/.claude-code` 或 `~/.claude`：推荐 Claude Code。
- 都没有：默认 Claude Code，后续可在向导或 IM 命令里切换。

向导会写入：

```text
~/.codelark/config.toml
~/.codelark/config/sessions/<session-id>.toml
~/.codelark/config/channels/<channel-id>.toml
```

`config.toml` 是全局主配置；Session 和 Channel 级持久化覆盖使用同一套 TOML shape 写入 `config/sessions/` 与 `config/channels/`。旧 `config.json` / `config.env` 只作为 v1 迁移输入，迁移成功后会归档，不再作为运行时配置来源。

## 启动

打开本地工作台并启动 bridge：

```bash
codelark run
```

只启动后台 bridge：

```bash
codelark start
```

常用本地命令：

```bash
codelark run
codelark status
codelark url
codelark start
codelark stop
```

`codelark run` 会在启动 bridge 前初始化 CodeLark 专属的 lark-cli 运行环境：

- 从当前启用的飞书/Lark 通道生成 `~/.codelark/runtime/lark-cli-source/config.json`。
- 将 lark-cli 绑定到 `~/.codelark/runtime/lark-cli/`。
- 如果 CodeLark 专属 runtime 已有当前 App 的用户授权，则切换为 user-default；否则保持 bot-only，直到用户在 setup 中完成授权。
- 给 bridge 及其子进程注入 `LARK_CHANNEL_CONFIG` 与 `LARKSUITE_CLI_CONFIG_DIR`，供 setup、诊断和真实 E2E 工具使用。

生产 bridge 的云文档评论建群路径直接走机器人 OpenAPI，不要求模型或用户手动执行 `lark-cli`；保留的私有 runtime 只服务 setup、诊断和真实 E2E 工具，不会误读默认用户 HOME 下的其他 lark-cli 配置。旧版 `codelark open` 仍作为兼容别名可用，但文档和脚本统一使用 `run`。

默认工作台地址：

```text
http://127.0.0.1:4781
```

## 飞书应用配置

飞书侧至少需要完成：

1. 在飞书开放平台创建自建应用，记录 `App ID` 和 `App Secret`。
2. 启用 Bot 能力。
3. 添加消息发送、消息读取、卡片读写、消息更新、云文档评论写入等权限。
4. 发布版本并由管理员审批。
5. 启动 CodeLark bridge。
6. 在事件订阅里选择长连接。
7. 添加 `im.message.receive_v1`、`drive.notice.comment_add_v1`、`im.chat.member.bot.deleted_v1`、`im.chat.disbanded_v1` 事件和 `card.action.trigger` 回调。
8. 再次发布版本并审批。

如果 `CODELARK_FEISHU_ALLOWED_USERS` 为空，所有能给机器人发消息的人都可以使用该 bot。需要收紧访问时，填写飞书用户 open_id 列表。

云文档评论能力除事件订阅外，还需要文档评论写入权限。缺少 `docs:document.comment:create` 或 `docs:document.comment:write_only` 时，bridge 可以收到评论事件，但无法写回评论或添加 `Typing` 表情。

## 本地工作台

工作台主要用于：

- 查看 UI 和 bridge 是否运行。
- 配置飞书通道实例。
- 测试飞书凭据和连通性。
- 查看本地 Codex / Claude Code / Kimi Code 会话。
- 查看 CodeLark Bridge 会话和聊天绑定。
- 查看会话历史。
- 给通道设置默认目标会话。
- 查看日志和诊断信息。

![CodeLark 工作台](../assets/readme/showcase-workbench-card.png)

## Windows bridge 自启动

Windows 主机可以把 bridge 注册为开机启动任务。UI 仍然按需通过 `codelark` 或 `codelark run` 打开。

```powershell
codelark autostart status
codelark autostart install
codelark autostart uninstall
```

`install` 和 `uninstall` 需要在管理员 PowerShell / 终端中执行。安装时会要求输入当前 Windows 登录密码，用于创建系统任务计划程序任务。自动启动只拉起 bridge，不会自动打开 Web 工作台；手动再次运行 `codelark` 只会补启动 UI，不会重复启动 bridge。

## 凭据快速验证

写入配置或在 setup 中粘贴飞书凭据后，可以用下面的请求快速确认 App ID、App Secret 和站点域名是否匹配：

```bash
curl -s -X POST "${DOMAIN}/open-apis/auth/v3/tenant_access_token/internal" \
  -H "Content-Type: application/json" \
  -d '{"app_id":"...","app_secret":"..."}'
```

`DOMAIN` 飞书版通常是 `https://open.feishu.cn`，Lark 国际版通常是 `https://open.larksuite.com`。预期响应包含 `"code":0`；如果不是，先检查 App ID、App Secret、站点和应用是否已创建完成。

## IM 中的基础使用

把机器人拉进飞书会话或直接私聊机器人后，可以使用以下最小流程：

1. 发送 `/status` 检查 bridge 和通道状态。
2. 发送 `/t` 查看当前 runtime 最近 20 条本地会话。
3. 在 `/t` 卡片里切换 runtime 或结果数量。
4. 发送 `/t 1` 切换当前 IM 会话到第 1 条线程。
5. 之后直接发送普通消息，即可继续该线程。

会话 attach/detach、`/current` 和 `/set` 卡片、tmux pane 查看、agent/provider 切换以及 home/chat 配置层级，见 [会话、Provider 与配置工作流](session-workflows.md)。完整命令索引见 [命令体系](../product/commands.md)，provider 能力矩阵见 [运行时与提供方](../product/runtime-providers.md)。

## 数据和日志

CodeLark 自有数据位于：

```text
~/.codelark
```

常见文件：

- `config.toml`：全局主配置。
- `config/sessions/`：当前会话级持久化覆盖，例如工作目录、模型、provider、sandbox、reasoning、tmux 显式绑定。
- `config/channels/`：Channel 级持久化覆盖。
- `data/sessions.json`：Bridge 会话。
- `data/channel-chats.json`：IM chat 到 Bridge 会话的绑定。
- `data/messages/`：Bridge 消息缓存。
- `logs/`：bridge、UI 和启动器日志。
- `runtime/`：运行状态、PID、端口等临时状态。

Codex 自己的会话数据仍由 Codex 管理，CodeLark 只读取必要的 session index 和 JSONL：

```text
~/.codex/sessions/**/*.jsonl
```

遇到启动、消息收发、权限或卡片问题时，见 [排障指南](troubleshooting.md)。
