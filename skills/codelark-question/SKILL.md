---
name: codelark-question
description: 在 CodeLark 中需要向 IM 用户发起结构化确认、选择或批准时使用；用户说“找我确认”“问我 xxx”“请我批准”“让我选择”“需要我确认/批准”时必须触发。
---

# CodeLark 问题卡片

当当前会话通过 CodeLark 连接到 IM，并且你需要用户做选择、确认、批准或补充一个很短的信息后才能继续时，使用这个 skill。

## 触发条件

只要用户表达了下面任一意图，就应该触发这个 skill：

- “找我确认”“让我确认”“需要我确认”。
- “问我 xxx”“向我提问”“让我选择 xxx”。
- “请我批准”“需要我批准”“找我审批”。
- 需要用户在继续执行前从几个互斥选项中选择一个。
- 需要用户批准高影响操作，例如合并、删除、部署、发布、改配置或执行不可逆动作。

不要只因为普通聊天里出现问号就触发；只有你确实需要用户输入来推进任务时才使用。

## 这个 skill 做什么

CodeLark 会把最终回复里的 `<clk-ask>` 块转换成飞书/Lark 问题卡片。用户提交后的结果会作为下一条用户消息回到同一个 bridge session。

## 生效时机

`<clk-ask>` 必须放在 assistant 的 completed/final 回复里，CodeLark 才会解析成问题卡片。不要把 `<clk-ask>` 放在工作过程消息、commentary/intermediate update、流式状态更新或工具调用说明里；这些路径只会进入 streaming card，不会生成弹窗。

## 输出格式

在一个 `<clk-ask>` 块里输出合法 JSON。不要把 JSON 放进 markdown 代码块。

简单选择：


```text
<clk-ask>
{"question":"请选择发布策略","options":["灰度","全量"],"allowTextReply":true}
</clk-ask>
```

选择加可选文本：

```text
<clk-ask>
{"question":"是否继续执行部署？","options":["继续","取消"],"input":{"label":"补充说明","placeholder":"可留空"},"submitText":"提交","allowTextReply":true}
</clk-ask>
```

## 规则

- 只有在确实需要用户输入才能继续时才使用。
- 必须把 `<clk-ask>` 放在 completed/final 回复中；不要放在工作过程消息或流式更新中。
- 普通说明放在 `<clk-ask>` 块外。
- 只是在总结、写代码、汇报已完成工作时，不要发问题卡片。
- `options` 要短，并且互斥；最多展示 8 个选项。
- 如果普通文本问题已经足够，不要创建问题卡片。
- 除非用户询问桥接协议，否则不要向用户解释 `<clk-ask>` 协议本身。
