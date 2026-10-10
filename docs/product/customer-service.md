# 客服模式

在控制台的通道编辑页填写「客服群 ID」并保存。只在指定群启用；清空客服群列表即可关闭。客服管理员可在群内使用 `/whitelist` 管理控制白名单；控制台的「控制用户白名单」保留为本地管理入口，填写同一飞书应用下的 `open_id`（`ou_` 开头），群 ID 不能代替用户 ID。

## 群内管理白名单

在群设置要求 @ 时，先 @ 机器人，再输入以下命令。添加/移除时使用飞书的 @ 选择器选人，不用查用户 ID；普通文本和富文本消息均支持，多人可同时 @。

```text
/whitelist
/whitelist add @张三 @李四
/whitelist remove @张三
/whitelist remove me
```

`/service-admin` 是 `/whitelist` 的别名，`/whitelist list` 等同查看。也支持直接填写 `ou_` 用户 ID；手写 `@姓名` 和 `@所有人` 无效。只有当前有效的客服管理员可以查看或修改名单，不能通过斜杠命令移除最后一位管理员。添加和撤权立即生效并落盘，与控制台修改的是同一字段；所属机器人通道的所有客服群共享这份名单，在话题中执行也不会新建话题独立名单。

**白名单为空时，bot 创始人自动拥有全部客服控制权限。** 无需手填用户 ID，也无需先执行初始化命令；创始人可以直接 `/whitelist add @成员`。第一次添加会把创始人和新增成员一起保存，避免加入他人后自己意外失去权限。名单非空后严格使用显式名单；清空名单恢复创始人的默认权限。

创始人身份来自当前飞书应用的 `creator_id`（`user_id_type=open_id`），通过机器人自身凭据读取 `/application/v6/applications/me` 并核对应用 ID。群主、首个发消息的人和旧 `allowed_users` 都不会被当作 bot 创始人。安装权限清单已包含 `application:application:self_manage`；当前应用缺少该权限或暂时查询失败时不会猜测身份，会记录原因并重试。`/whitelist init` 仅保留为显式保存默认成员的兼容命令，不是使用前置步骤。

## 配置与使用

也可编辑 `~/.codelark/config.toml` 中对应通道的配置：

```toml
[[channels]]
id = "feishu-default"
# 保留已有 alias、provider、enabled 等设置
[channels.config]
# 保留已有 app_id、app_secret 等设置
customer_service_chats = ["oc_yourgroup"]
customer_service_control_users = ["ou_operator"]
```

客服群收到符合群聊现有 @ 规则的普通问题后，自动以话题形式回复。是否需要 @ 完全遵循该群的 `/require-at` 设置，首问和话题追问使用同一规则；客服模式不另设开关，也不绕过群设置。同一话题的追问接续同一模型会话；不同话题分别排队并保存上下文。新话题继承群会话的模型、工作目录、权限和系统提示配置，但不复用群会话的模型线程或终端；没有群会话时使用通道默认值。支持普通对话群，以及 `chat_mode=group, group_message_type=thread` 的话题形式群。

客服模式下，普通问答不受旧 `allowed_users` 的限制，但仍遵守群会话 `/require-at`、禁群和群访问策略。所有斜杠控制指令、卡片按钮与表单，以及清理/接管的文字确认，只允许控制白名单用户执行。白名单用户在群里直接发送控制指令时操作群会话配置；在已有话题内发送时操作该话题会话。`/require-at` 始终查看或修改所属群的规则，立即影响该群全部话题；话题里的 `/current common` 只读显示群的实时 @ 规则，不提供独立话题开关。群级模型配置只供新话题继承，已有话题保留自己的配置。非白名单的控制指令不会被转交模型。`//` 转义的普通提问继续按普通文本处理，已有特殊 `//clear` 仍视为控制指令。

这项白名单保护 CodeLark 控制入口，不是模型工具执行的沙箱。为客服选择合适的工作目录和运行时权限；客服模型仍遵循所配置运行时的工具权限。

飞书应用必须启用机器人、订阅 `im.message.receive_v1` 与 `card.action.trigger`，并取得发送消息和读取消息的权限。如果群设置允许不带 @ 提问，还需接收群内所有消息（`im:message.group_msg`）的权限；只有接收 @ 消息的权限时，无法接收不带 @ 的客户问题。流式卡还需 CardKit 读写权限。

## 会话和回复链

桥接层使用 `feishu-topic:<群ID>:<根消息ID>` 作为逻辑会话地址；平台真实群 ID、根消息 ID 和可用的话题 ID 分别保存。不要把该逻辑地址当成飞书 API 的 `chat_id`。

首问在话题建立前没有 `thread_id`，以根消息 ID 建立稳定绑定；后续收到话题 ID 时不会另建会话。普通多层回复优先沿 `root_id`，缺少根信息时查询 `parent_id` 链；只有话题 ID 时查询话题根消息。缺失、跨群或循环的链路不能猜测绑定。绑定持久化后重启仍可续接。

所有输出共用同一发送入口，以根消息为目标调用 `reply_in_thread=true`，包括流式卡、续页、文本、富卡、附件和审批卡。话题发送失败不会改为向群主时间线发送。卡片回调先校验操作人，立即回执，网络查询在队列中执行，满足飞书 3 秒响应限制。

## 官方协议依据

- [话题概述](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/thread-introduction)：话题 ID、普通群与话题形式群、创建与查询话题。
- [消息管理概述](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/intro)：普通回复链与话题的 `root_id` / `parent_id` 区别。
- [回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply)：`reply_in_thread` 为布尔值；已属话题的消息默认在话题中回复；`uuid` 在一小时内去重。
- [获取会话历史消息](https://open.feishu.cn/document/server-docs/im-v1/message/list)：按 `chat` 只能读话题根消息，完整追问需按 `thread` 分页读取；话题查询不支持时间范围。
- [获取应用信息](https://open.feishu.cn/document/server-docs/application-v6/application/get)：读取当前应用创建者 `creator_id`，使用 `me` 和 `user_id_type=open_id`。
- [获取消息](https://open.feishu.cn/document/server-docs/im-v1/message/get) 与 [接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)：消息元数据和发送者身份。
- [卡片回传交互回调](https://open.feishu.cn/document/feishu-cards/card-callback-communication)：`operator.open_id` 是操作人，`context` 是目标，回调需要在 3 秒内响应。

协议核对日期：2026-10-10。真实群验收需同时读取群主时间线与每个话题的消息，并以用户身份检查最终卡片内容，不能仅以发送 API 返回成功代替验收。
