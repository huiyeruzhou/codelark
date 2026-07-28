# 通道

## 通道能力

一个 CodeLark 安装可以配置多个通道实例，例如多个飞书机器人。通道实例负责平台接入，聊天绑定负责某个群聊或单聊当前指向哪个 `BridgeSession`。

| 能力 | 飞书 |
| --- | --- |
| 普通文本收发 | 支持 |
| 多实例配置 | 支持 |
| 群聊绑定 | 支持 |
| 流式富卡片 | 支持 |
| Rich card 表格/按钮/表单 | 支持 |
| 文件/图片发送 | 支持 |
| 新建/重命名群聊 | 支持 |
| 云文档聊天入口 | 支持 |
| `/require-at` | 支持 |

通道能力不是写死在命令层，而是通过 [BaseChannelAdapter](https://github.com/huiyeruzhou/codelark/blob/main/src/channels/contracts.ts) 的可选方法表达。命令层会优先使用平台能力，不支持时给出退化提示。

## 飞书流式卡片和交互卡片

飞书通道可以把模型输出渲染为流式卡片，并在卡片里展示状态、工具调用、任务进度和操作按钮。命令结果也可以使用 rich card、表格、表单和按钮；rich card 标题支持最多数个 text tag 和统一 tag 色，表单支持单列或双列表单布局、额外输入框和静态下拉选择。

当前流式卡片 header 会使用 `bridge_id:<短 ID>` 标识 Bridge 会话来源；`/t` 会话表也显示短 `bridge_id`，卡片首列会标出当前激活的对话和其他人激活的对话。工具调用沿用“历史记录 → 工具调用组 → 单工具”结构。普通工具展开后显示真实参数或命令，但默认隐藏 output 正文；`apply_patch` 继续显示受字符数和行数双上限约束的真实 diff。单工具内部不再为长输出增加折叠。工具面板按运行状态显示边框色。飞书面板边框色会先按 CardKit 支持的枚举和 rgba 格式过滤，避免无效颜色导致整张卡片被拒绝。

如果最终卡片更新在关闭 streaming mode 后失败，但卡片中已经有文本、历史或工具调用内容，adapter 会保留已有卡片并发送终态 reaction，而不是再降级发送重复的纯文本消息。

设计模块：

- rich card 类型：[src/domain/index.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/domain/index.ts)
- 飞书 Markdown / CardKit 渲染：[src/channels/feishu/markdown.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/channels/feishu/markdown.ts)
- 流式反馈控制：[src/channels/delivery/stream-feedback.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/channels/delivery/stream-feedback.ts)
- 工具详情：[src/shared/progress/tool-call-details.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/shared/progress/tool-call-details.ts)
- 飞书 adapter：[src/channels/feishu/adapter.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/channels/feishu/adapter.ts)

## 云文档聊天入口

飞书通道可以接收云文档评论事件。默认模式是 doc-as-chat：用户在云文档评论里 @ 机器人后，Bridge 会为这篇云文档创建一个飞书群聊；如果这篇文档已经有绑定群聊，则不会重复创建。

绑定建立后，云文档后续评论会转发到该群聊。Bridge 会先在群聊里发一条转发通知，再把评论内容作为群聊输入交给当前 runtime；模型回复只在群聊里发送，云文档评论区不承载模型回复。

未建立映射的云文档评论仍需要 @ 机器人，或由评论内容里的机器人 mention 触发，避免机器人订阅整个租户后误接收无关评论。机器人自己写出的云文档评论会被忽略，避免评论回复再次触发自身。

设计模块：

- 云文档地址类型：[src/domain/index.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/domain/index.ts)
- 通道回复抽象：[src/channels/contracts.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/channels/contracts.ts)
- 飞书评论事件和回复：[src/channels/feishu/adapter.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/channels/feishu/adapter.ts)
- 交付管线：[src/bridge/turn/delivery-pipeline.ts](https://github.com/huiyeruzhou/codelark/blob/main/src/bridge/turn/delivery-pipeline.ts)
- 飞书权限说明：[docs/guide/install-and-usage.md](../guide/install-and-usage.md)

## Web 工作台

本地 Web 工作台仍负责管理通道实例和聊天绑定，但它已经不只是“通道配置页”。完整的管理面能力矩阵、信息架构和测试合同见 [Web 工作台](operator-ui.md)。
