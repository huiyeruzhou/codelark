# 飞书功能：云文档与交互卡片

## doc-as-chat

云文档评论里 @ 机器人后发送 `/new [群名] [目录]` 会启用显式 doc-as-chat 模式。Bridge 会创建飞书群聊，并获得这份云文档和触发评论的相关信息；后续长线任务在群聊里推进，文档评论只保留入口提示。

普通云文档评论也可以作为一次 bot 对话入口：用户在评论里 @bot 后，Bridge 会把评论内容交给当前 runtime，并把回复写回同一个评论线程。为了避免误接管整份文档的无关评论，未建立映射前仍需要 @bot 或评论富文本里包含机器人 mention。

如果 `lark-cli` 或机器人权限不可用，模型会在云文档评论里明确说明需要补 CLI 绑定或 Drive 权限。云文档评论还会在 turn 开始前给目标 reply 添加 `Typing` reaction，回复完成后删除。

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
