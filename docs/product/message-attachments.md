# 图片、文件与合并消息

图片和文件是 CodeLark 的通用消息能力，适用于私聊、普通群和客服话题。群里是否需要 @ 机器人仍由原有 `/require-at` 设置决定。

## 发给模型

群聊要求 @ 机器人时，图片可在同一条图文消息中 @bot 并发送；文件通常先发到群里，再引用（citation）该文件消息、@bot 并说明要做什么。关闭 @ 要求时也支持直接发送文件。CodeLark 会读取被引用消息的实际类型、文件名和资源，把下载后的附件交给当前会话，不再要求模型自行运行 `lark-cli` 查找文件。

Codex 原生会话使用同一 thread 提交图片输入，文件则保存到工作目录后附上本地路径。图片、文件追问沿用同一输入和输出链路，不会因为有附件额外创建 SDK 执行卡。对于 tmux 文字输入和 Cursor，CodeLark 提供图片及文件的可读本地路径，模型使用自己的文件或看图工具读取；不会为了附件切换 provider。

下载的附件保存在当前会话工作目录的 `.codepilot-uploads/`，以随机 ID 加安全文件名命名。CodeLark 在发给模型的文本中追加 `<local_attachments>` XML 块，每个 `<file>` 元素包含文件名、类型、字节数和绝对路径，`<instruction>` 说明如何读取；用户只需发送或引用附件。Codex 图片通过原生 `localImage` 字段提交，由原生客户端加载图片内容。

直接发送或引用合并转发消息时，CodeLark 读取整包子消息，按飞书 `upper_message_id` 保留嵌套关系，提供文字、原始交互卡内容和附件信息。飞书资源接口不支持直接下载合并转发子消息中的图片、文件（文档错误码 `234043`）。如果当前群里仍能读取未修改的原消息，CodeLark 会重新获取原资源并自动下载；否则保留文件名、类型和资源标识，明确提示需要直接发送附件或引用非合并的原始附件消息。读取失败、删除、重复、超限的内容同样会明确标注。

一次引用最多展开 50 条消息、8 层合并关系和约 64,000 字符；最多附加 20 个引用资源，总大小不超过 20 MiB。直接上传仍沿用现有单附件大小限制。

## 模型发回图片或文件

模型可以输出本机绝对路径的 Markdown 图片或附件链接。CodeLark 将它们上传为飞书图片消息或文件消息，正文不会只留下无法在飞书打开的本地路径。带空格的路径可用尖括号，也支持转义括号、百分号编码和本地 `file:` URL。

```markdown
![结果图](</absolute/path/result image.png>)
[下载报告](</absolute/path/result report.pdf>)
```

也可通过 CodeLark skill 的发送指令明确区分图片和文件：

```text
<clk-send>{"msg_type":"image","local_path":"/absolute/path/result.png"}</clk-send>
<clk-send>{"msg_type":"file","local_path":"/absolute/path/report.pdf"}</clk-send>
```

路径须是模型运行机器上实际存在的文件。代码块中的示例不会触发 Markdown 附件上传。普通远程网址仍按链接处理。文件权限、上传错误等会沿用附件发送的错误反馈；客服话题中的附件留在原话题。

## 协议依据

- [获取指定消息的内容](https://open.feishu.cn/document/server-docs/im-v1/message/get)：合并转发返回根消息及 N 条子消息；`upper_message_id` 表示上一层合并消息；`card_msg_content_type=user_card_content` 读取原始卡片内容。
- [接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)：用 `parent_id` 定位引用消息，结合消息类型解析资源。
- [获取消息中的资源文件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-resource/get)：资源 Key 必须匹配消息 ID；错误码 `234043` 明确排除合并转发及子消息。
