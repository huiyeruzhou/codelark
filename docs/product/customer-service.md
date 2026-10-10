# 客服模式

在控制台的通道编辑页填写「客服群 ID」和「控制用户白名单」并保存。只在指定群启用；清空客服群列表即可关闭。用户白名单填写同一飞书应用下的 `open_id`（`ou_` 开头），群 ID 不能代替用户 ID。白名单为空时，仍回答普通问题，但拒绝全部群内控制操作。

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
- [获取消息](https://open.feishu.cn/document/server-docs/im-v1/message/get) 与 [接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)：消息元数据和发送者身份。
- [卡片回传交互回调](https://open.feishu.cn/document/feishu-cards/card-callback-communication)：`operator.open_id` 是操作人，`context` 是目标，回调需要在 3 秒内响应。

协议核对日期：2026-10-10。真实群验收需同时读取群主时间线与每个话题的消息，并以用户身份检查最终卡片内容，不能仅以发送 API 返回成功代替验收。
