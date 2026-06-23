# 飞书功能：云文档与交互卡片

## doc-as-chat

云文档评论里 @ 机器人后会默认启用 doc-as-chat 模式。Bridge 会直接为这篇云文档创建一个飞书群聊，并把文档映射到该群聊；如果这篇文档已经有绑定群聊，则不会重复创建。默认工作目录使用全局默认工作目录，默认群名为 `doc:<文档标题前缀>`，标题不可用时使用文档 token 前缀兜底。后续长线任务在群聊里推进。

绑定建立后，这篇云文档里的后续评论会转发到绑定群聊。Bridge 会先在群聊里发送一条“收到云文档评论，已转发到本群处理”的通知，再把评论内容作为群聊输入交给当前 runtime。云文档评论区不承载模型回复。

如果 `lark-cli` 或机器人权限不可用，Bridge 会在云文档评论里明确说明需要补 CLI 绑定或 Drive/IM 权限。未建立映射前仍需要 @bot 或评论富文本里包含机器人 mention，避免机器人订阅整个租户后误接收无关评论。

## 表单

通过 `codelark-question` skill，模型可以让 Bridge 生成飞书 CardKit 2.0 表单，而不只是按钮卡片。协议示例：

```xml
<clk-ask>{"question":"请选择发布策略","options":["灰度","全量"],"input":{"label":"补充说明","placeholder":"可留空"},"submitText":"提交","allowTextReply":true}</clk-ask>
```

新提示和新文档使用 `<clk-ask>`。

渲染规则：

- `options` 会渲染为一个 `select_static`。
- `input` 会渲染为可为空的文本框。
- 提交按钮使用 `form_action_type: "submit"`。
- CardKit 2.0 提交值会出现在 raw event 的 `action.form_value`，key 是控件 `name`。因此表单控件使用固定 name：`clk_choice` 与 `clk_input`。

用户提交后，Bridge 会把回调转成同一会话里的下一条消息：

```text
[用户回答了问题卡片]
问题：请选择发布策略
回答：选择：灰度
补充：可以先给 10% 用户
```

如果补充输入框为空，会显式回传 `补充：（空）`，让模型知道用户是自由提交而不是消息丢失。
