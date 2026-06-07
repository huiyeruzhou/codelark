# 手动飞书配置

本文提供飞书 / Lark 平台的逐步配置说明，会被 `setup` 和 `reconfigure` 子命令引用。

## 应用 ID 和应用密钥

**创建飞书/Lark 应用并获取凭据：**

1. 打开飞书开发者后台：`https://open.feishu.cn/app`，或 Lark 后台：`https://open.larksuite.com/app`。
2. 点击 **创建企业自建应用**。
3. 填写应用名称和描述，点击 **创建**。
4. 在应用的 **凭证与基础信息** 页面找到：
   - **App ID**，格式类似 `cli_xxxxxxxxxx`。
   - **App Secret**，点击显示后可看到类似 `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` 的值。

### 阶段 1：权限和机器人能力

> 先完成阶段 1 并发布版本，再进入阶段 2。飞书要求已发布版本后权限才会生效；bridge 服务也需要有效权限才能建立 WebSocket 连接。

**步骤 A：批量添加必需权限**

1. 在应用页面进入 **权限管理**。
2. 使用 **批量配置**（点击 **切换至按依赖批量配置**，或找到 JSON 编辑器）。
3. 粘贴下面的 JSON。这些权限覆盖 IM 收发、流式卡片、群聊生命周期、Pin、附件资源和 doc-to-chat 云文档评论：

```json
{
  "scopes": {
    "tenant": [
      "cardkit:card:read",
      "cardkit:card:write",
      "docs:document.comment:create",
      "docs:document.comment:read",
      "docs:document.comment:write_only",
      "im:chat",
      "im:chat:create",
      "im:chat:create_by_user",
      "im:chat:read",
      "im:chat:update",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message.pins:write_only",
      "im:message.reactions:read",
      "im:message.reactions:write_only",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:message:update",
      "im:resource"
    ],
    "user": []
  }
}
```

4. 点击 **保存** 应用所有权限。

如果后台没有批量导入入口，可以在搜索框里逐个添加上述 scope。

> **重要：** 如果缺少 `cardkit:card:write`，即使在本地工作台开启飞书流式响应卡片，也无法正常工作。bridge 会记录飞书错误 `99991672`，并降级为普通最终结果消息。

> **云文档评论：** `drive.notice.comment_add_v1` 只负责让 bridge 收到评论事件；回复云文档评论和提前添加 `Typing` reaction 还需要文档评论写权限。如果缺少 `docs:document.comment:create` 或 `docs:document.comment:write_only`，飞书会返回 `99991672`。

> **setup 用户授权：** `codelark setup` 只以 `~/.codelark/config.toml` 中的当前 App 为准；旧版 `config.json` / `config.env` 仅作为首次迁移输入。已有 App 配置时直接加载；没有 App 配置时通过开放平台扫码创建，`App ID` / `App Secret` 来自扫码返回结果。保存后，setup 会初始化 `~/.codelark/runtime/lark-cli/`，在这个 CodeLark 专属配置里执行 `auth check --scope "docs:document.comment:create docs:document.comment:read docs:document.comment:write_only im:chat im:chat:delete im:chat:read"`，缺少授权时再发起同 App 的用户 OAuth 扫码。整个过程不会读取或导入用户 HOME 下默认 `~/.lark-cli`。控制台里的 tenant 权限和事件订阅仍需要按本页配置、发布并审批。

**步骤 B：启用机器人**

1. 进入 **添加应用能力**，启用 **机器人**。
2. 设置机器人名称和描述。

**步骤 C：第一次发布，让权限和机器人生效**

1. 进入 **版本管理与发布**，点击 **创建版本**。
2. 填写版本号 `1.0.0` 和描述，点击 **保存**，再点击 **提交审核**。
3. 管理员在 **飞书管理后台** 的 **应用审核** 中审批；如果你是管理员，可以自行审批。

**版本审批通过前，机器人不会工作。**

**步骤 E：配置事件与回调（长连接）**

1. 在左侧边栏进入 **事件与回调**。
2. 在 **事件订阅方式** 中选择 **长连接**（WebSocket 模式）。
3. 点击 **添加事件** 并添加：
   - `im.message.receive_v1`：接收消息。
   - `drive.notice.comment_add_v1`：接收飞书云文档评论。
   - `im.chat.member.bot.deleted_v1`：检测 bot 被移出群聊。
   - `im.chat.disbanded_v1`：检测群聊被解散。
4. 点击 **添加回调** 并添加：
   - `card.action.trigger`：卡片交互回调，用于权限审批按钮。
5. 点击 **保存**。

**步骤 F：第二次发布，让事件订阅生效**

1. 进入 **版本管理与发布**，点击 **创建版本**。
2. 填写版本号 `1.1.0`，点击 **保存**，再点击 **提交审核**，由管理员审批。
3. 审批通过后，bot 即可接收和回复消息。

### 从旧版本升级

如果你已经配置过飞书应用，需要执行以下步骤：

1. **添加新权限**：进入权限管理并添加这些 scope：
   - `cardkit:card:write`、`cardkit:card:read`：流式卡片。
   - `im:message:update`：实时更新卡片内容。
   - `im:message.reactions:read`、`im:message.reactions:write_only`：Typing 指示。
   - `im:message.pins:write_only`：Pin/Unpin 线程表消息。
   - `im:chat`、`im:chat:create`、`im:chat:create_by_user`、`im:chat:read`、`im:chat:update`：创建、读取和重命名 bridge 群聊。
   - `docs:document.comment:read`、`docs:document.comment:create`、`docs:document.comment:write_only`：云文档评论读取、回复和 Typing reaction。
2. **发布新版本**：权限变更只有在新版本审批通过后才会生效。
3. **启动或重启 bridge**：从本地 `codelark` 工作台启动，让 WebSocket 连接处于活跃状态。
4. **添加回调**：进入事件与回调，添加 `card.action.trigger` 回调，用于权限按钮卡片交互。保存时飞书会校验 WebSocket 连接，因此这一步要求 bridge 正在运行。
5. **再次发布**：新增回调也需要发布新版本并由管理员审批。
6. **重启 bridge**：在本地 `codelark` 工作台停止并重新启动 bridge，让新能力生效。

### 域名（可选）

默认值：`https://open.feishu.cn`。

Lark 国际版使用 `https://open.larksuite.com`。

留空则使用默认飞书域名。

### 允许用户 ID（可选）

飞书用户 ID 使用 open_id 格式，例如 `ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`。

可以在飞书管理后台的用户资料中找到。

留空表示允许所有能给 bot 发消息的用户使用。
