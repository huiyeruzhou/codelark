# 云文档 doc-as-chat from-scratch E2E 示例

这个示例验证云文档评论入口的真实端到端路径。它不是“先在 IM 里跑 `/new`”的替代写法；合格报告必须从一份新建云文档开始，经过 Drive 评论事件进入 bridge，再落到新群里的后续对话。

## 验收链路

1. E2E harness 以用户身份创建一份测试云文档，正文包含本轮唯一 marker。
2. E2E harness 给文档添加全局评论，评论内容包含结构化 `mention_user` 指向 bot；不需要手写 `/new`、群名或工作目录。
3. 等待 bridge 收到 `drive.notice.comment_add_v1`，从云文档评论自动创建飞书群聊，并在 `CODELARK_HOME/data/channel-chats.json` 写入文档级 `cloudDocumentChat` 绑定。
4. 在新群聊里发一条普通消息，不再通过云文档评论继续对话。
5. 验证 bot 回复符合预期上下文：至少证明它知道本群绑定的 `file_type`、`file_token`，并能读取或引用文档里的本轮 marker。只检查“群里有回复”不算通过。
6. 清理阶段删除测试群聊和测试云文档；失败时可以保留资源用于诊断，但报告必须标记 retained 资源。

## 前置条件

真实运行必须满足：

- `CODELARK_REAL_FEISHU_E2E=1`，避免误向真实飞书发消息。
- 测试身份具备创建测试文档、创建评论、发送测试群消息、读取测试群消息、删除测试资源所需权限。生产 bridge 的云文档建群路径不依赖用户身份 CLI。
- 被测 bridge 使用同一个 Feishu/Lark App，并已订阅 `drive.notice.comment_add_v1`、`im.message.receive_v1`、`im.chat.disbanded_v1`。
- 已知 bot 的 open_id，传给评论里的 `mention_user`。如果不知道，先用测试群成员接口或应用后台查出，不要用普通文本 `@bot` 代替结构化 mention。

## 自动化入口

这个场景已经接入真实飞书 E2E harness：

```bash
CODELARK_REAL_FEISHU_E2E=1 npm run real:feishu:e2e -- \
  --test-env-file ~/.codelark/test/real-feishu-e2e.test.env \
  --launch-bridge \
  --scenario doc-as-chat-from-scratch \
  --runtime codex \
  --provider tmux \
  --run-id doc-chat-$(date +%Y%m%d%H%M%S) \
  --timeout-ms 240000
```

如果 harness 不能从测试 App 查询 bot open_id，可以额外传 `--test-bot-open-id ou_xxx`，或在测试 env 文件中写 `CODELARK_REAL_FEISHU_TEST_BOT_OPEN_ID=ou_xxx`。

通过 gate 包括：

- `doc_as_chat_context_assertion`：群聊后续 bot 回复必须包含 `docx`、测试文档 `file_token` 和正文 marker。
- `doc_as_chat_user_group_read`：必须以用户视角成功读取新群信息，证明当前用户在群里。
- `doc_as_chat_document_binding`：`cloudDocumentChat` 绑定必须匹配 `file_token`，同一云文档后续评论复用同一个群聊。
- `scenario_created_chat_cleanup_completed` 和 `created_document_cleanup_completed`：成功运行必须删除测试群和测试云文档。

## 失败诊断

如果自动化 gate 没有命中，本轮必须失败。失败报告需要附上：

- `DOC_URL`、`DOC_TOKEN`、`GROUP_CHAT_ID`。
- `CODELARK_HOME/logs/bridge.log` 中 `drive.notice.comment_add_v1` 附近的结构化 JSONL 日志，优先保留 `time`、`level`、`event`、`msg`、`chat`、`message` 字段。
- `CODELARK_HOME/data/channel-chats.json` 中对应 `cloudDocumentChat` 绑定。
- 群消息 transcript，尤其是用户消息和 bot `reply_to`。

## 清理

harness 负责清理测试群聊和测试云文档。如果清理失败，报告不能标为完全通过；应把 retained 群聊和文档 token 写入报告，并给出后续清理 owner。

## 通过报告最小字段

报告中至少保留：

- `run_id`
- `document.url`
- `document.token`
- `comment.comment_id`
- `comment.reply_id`
- `created_group.chat_id`
- `created_group.name`
- `user_message.message_id`
- `context_assertion.expected_file_type`
- `context_assertion.expected_file_token`
- `context_assertion.expected_marker`
- `context_assertion.passed`
- `cleanup.group_deleted`
- `cleanup.document_deleted`

只有 `context_assertion.passed=true` 且两个清理字段都为 `true`，才算这条 from-scratch 云文档 E2E 通过。
