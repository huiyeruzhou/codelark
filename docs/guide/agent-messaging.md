# Agent 消息与自动化

CodeLark 的统一 `codelark` skill 让模型使用 Bridge 已有能力发送飞书消息、创建自动化卡片，并在不同群聊的 Agent 之间传递普通输入。它不会用 Bot 发言回投来冒充 Agent 通讯。

## 发送飞书消息

`<clk-send>` 采用[飞书官方 `im.v1.message.create`](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create) 的 `msg_type + content` 结构，对应 `POST /open-apis/im/v1/messages`。`content` 在控制块中写为 JSON 对象，CodeLark 发送时转换为飞书要求的 JSON 字符串。

Bridge 不硬编码一份容易过期的 `msg_type` 白名单：任意飞书官方消息类型都会原样交给 OpenAPI 校验。模型仍必须按当前飞书文档提供对应的 `content`，不得自创类型。

普通文本与 @ 文本都是官方 `text` 消息；@ 标签直接写在 `content.text`：

```xml
<clk-send>{"msg_type":"text","content":{"text":"<at user_id=\"ou_xxx\">名字</at> 请查看结果"}}</clk-send>
```

这条 text 会作为独立飞书消息发送；Codex、Claude、Kimi、Cursor 的 SDK 与 tmux/mirror 路径使用同一交付语义，不会在解析控制块后静默丢弃正文。

富文本和卡片直接使用官方结构：

```xml
<clk-send>{"msg_type":"post","content":{"zh_cn":{"title":"进度","content":[[{"tag":"text","text":"已完成"}]]}}}</clk-send>
<clk-send>{"msg_type":"interactive","content":{"header":{"template":"blue","title":{"tag":"plain_text","content":"状态"}},"elements":[{"tag":"markdown","content":"已完成"}]}}</clk-send>
```

上传本地图片或文件时，`local_path` 是 CodeLark 唯一增加的本地扩展。Bridge 先调用飞书 image/file 上传接口，再按官方 `image_key`/`file_key` 消息发送：

```xml
<clk-send>{"msg_type":"image","local_path":"/absolute/result.png"}</clk-send>
<clk-send>{"msg_type":"file","local_path":"/absolute/report.pdf"}</clk-send>
```

旧版 `{"type":"image|file","path":"..."}` 仍可使用。路径必须是已存在的绝对路径。

用户要求“把图片/文件发给我”时，只有 `<clk-send>` 被 CodeLark 接受才算真正交付；模型本地调用 `view_image`、渲染 Markdown 图片或展示路径都只是检查。默认只确认路径存在，不必在每次发送前预览图片；如果用户反馈图片错误、损坏、过期或视觉内容不对，后续修正版再先检查后发送。

## 创建自动化卡片

模型可以把命令作为普通输入送回当前聊天的 lane：

```xml
<clk-input>{"target":"current","text":"/every-form"}</clk-input>
<clk-input>{"target":"current","text":"/then-form"}</clk-input>
```

如果间隔和 prompt 已明确，也可以直接创建：

```xml
<clk-input>{"target":"current","text":"/every 20m 检查实验进度"}</clk-input>
<clk-input>{"target":"current","text":"/then 总结当前任务结果"}</clk-input>
```

这些输入仍由现有命令 lane 处理，因此表单、取消、停止和 session 串行语义都与用户手工发送命令一致。

## 群聊发现

每个运行中的 Bridge 在当前操作系统用户的全局 discovery 目录注册自己的 `CODELARK_HOME`、loopback 控制端点和运行实例。注册目录不位于任何一个 `CODELARK_HOME` 中，因此同一用户启动的多个 Home 可以互相发现。

Bridge 不会把全量群聊目录注入模型 prompt。用户或 skill 真正需要寻找目标时，才调用 CodeLark CLI：

```bash
codelark sessions --query diffusion
codelark sessions --home /home/user/.codelark --chat-name "项目群" --bot-name "reviewer" --runtime codex --json
```

`--target`、`--chat-name`、`--bot-name`、`--home`、`--runtime`、`--status` 是精确筛选，多个条件按 AND 组合；`--query` 才是跨字段模糊匹配。默认输出可读表格，`--json` 供 skill 和自动化消费。每项结果只给一个可回填的 opaque `target`；列表顺序不是身份。

`bot_name` 来自运行中通道解析出的真实 Bot 名称，可以与群聊名等条件组合筛选。

发送由 Agent 的 `<clk-input>` 完成，因此 Bridge 能自动绑定真实来源群。零匹配会报未找到；多匹配会列出候选并拒绝猜测；只有唯一匹配才发送。

## Agent 之间发送普通输入

模型先用 `codelark sessions` 找到唯一结果，再把其中的 `target` 原样回填：

```xml
<clk-input>{"target":"target-from-codelark-sessions","text":"请检查训练状态并回复我"}</clk-input>
```

复合筛选只用于 CLI 发现阶段；发送阶段只使用唯一结果的 `target`，不再要求模型理解或拼接内部 binding、平台群 ID 和 CodeLark Home。目标 Bridge 明确接受后，源群当前对话卡的历史区追加一条 `✉️ 已发送 · <目标群聊> — <正文摘要>` 事件；默认收起，展开后只显示未截断的完整正文，不重复目标群聊或 Bot 名。目标群直接在接收 Agent 的常规对话卡中看到输入，不再额外插入一张“收到 Agent 消息”卡。若源群没有可合并的活动对话卡，则发送紧凑的独立成功回执，避免后台发送静默无记录。离线、无匹配或多匹配仍在源群显示独立失败卡，不会假报成功。

输出保持单一：discovery 只展示 canonical Bridge/session UUID。输入保持兼容：如果调用方已有 binding UUID、飞书 `oc_...` 群 ID 或 Bridge/session UUID，三者都可以原样作为同一个字符串 `target`；resolver 在内部统一收敛到当前 binding。

目标 lane 收到的正文完全不变，因此普通 prompt 和 `/stop`、`/model` 等命令继续使用原分类。来源信息只用单层 XML 外壳划定边界，内部是易读文字；整段与用户多行正文一样作为一次输入提交：

```xml
<codelark_source>
来源群聊："来源群"
来源 Bot："qaq"
来源会话 ID："source-session"
当前会话 ID："current-session"
</codelark_source>
```

字段值使用 JSON 字符串转义，并保护 XML 外壳终止符。“来源会话 ID”标识发送方，目标模型向来源回复时把它原样放入字符串 `target`；“当前会话 ID”标识正在阅读消息的接收方，可直接作为后续 `codelark send agent --source`。模型不会看到或使用 binding、platform 或 Home 辅助字段。
这里的“来源 Bot”和 discovery 的 `bot_name` 都来自发送通道解析出的真实 Bot 名称，不会用群聊名冒充。

## 安全边界

- 控制服务只监听 `127.0.0.1`，每次 Bridge 启动生成随机 bearer token；descriptor 仅写入当前用户的临时目录。
- discovery 只定位在线 Bridge；session 真相仍由各自 Home 的 store 提供，不复制到全局数据库。
- 飞书 Bot 可见发言与 Agent 后端通讯是两条链路。即使飞书不把 Bot 发言重新投递给另一个 Bot，Bridge 手动 ingress 仍可工作。
