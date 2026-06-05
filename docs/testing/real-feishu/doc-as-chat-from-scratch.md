# 云文档 doc-as-chat from-scratch E2E 示例

这个示例验证云文档评论入口的真实端到端路径。它不是“先在 IM 里跑 `/new`”的替代写法；合格报告必须从一份新建云文档开始，经过 Drive 评论事件进入 bridge，再落到新群里的后续对话。

## 验收链路

1. 使用 `lark-cli docs +create` 以用户身份创建一份测试云文档，正文包含本轮唯一 marker。
2. 使用 `lark-cli drive file.comments create_v2` 以用户身份给文档添加全局评论，评论内容包含 `mention_user` 指向 bot，并发送 `/new <群名> <workdir>`。
3. 等待 bridge 收到 `drive.notice.comment_add_v1`，从云文档评论命令创建飞书群聊，并在 `CODELARK_HOME/data/channel-chats.json` 写入 `cloudDocumentChat` 绑定。
4. 在新群聊里发一条普通消息，不再通过云文档评论继续对话。
5. 验证 bot 回复符合预期上下文：至少证明它知道本群绑定的 `file_type`、`file_token`，并能读取或引用文档里的本轮 marker。只检查“群里有回复”不算通过。
6. 清理阶段删除测试群聊和测试云文档；失败时可以保留资源用于诊断，但报告必须标记 retained 资源。

## 前置条件

真实运行必须满足：

- `CODELARK_REAL_FEISHU_E2E=1`，避免误向真实飞书发消息。
- 当前 `lark-cli auth status` 的 user 身份可用，并具备 `docs:document.comment:create`、`docs:document.comment:read`、`docx:document:create`、`space:document:delete`、`im:message.send_as_user`、`im:message.group_msg:get_as_user`、`im:chat:delete`。
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
- `doc_as_chat_user_group_read`：必须用 `lark-cli --as user` 成功读取新群信息，证明当前用户在群里。
- `doc_as_chat_comment_granularity_binding`：`cloudDocumentChat` 绑定必须同时匹配 `file_token` 和 `comment_id`。
- `scenario_created_chat_cleanup_completed` 和 `created_document_cleanup_completed`：成功运行必须删除测试群和测试云文档。

## 手工等价步骤

下面的命令按一轮 `run_id` 串起来。示例用 `docx`，因为当前 docs v2 创建入口会返回 docx 文档。

```bash
export RUN_ID="doc-chat-$(date +%Y%m%d%H%M%S)"
export CODELARK_HOME="${CODELARK_HOME:-$HOME/.codelark}"
export BOT_OPEN_ID="ou_xxx"
export WORKDIR="/data00/home/hongli.fish/Codex/codelark"
export GROUP_NAME="clk-doc-chat-${RUN_ID}"
export DOC_MARKER="CODELARK_DOC_AS_CHAT_${RUN_ID}"

DOC_CREATE_JSON="$(npx lark-cli docs +create \
  --api-version v2 \
  --as user \
  --title "CodeLark doc-as-chat E2E ${RUN_ID}" \
  --markdown "# CodeLark doc-as-chat E2E

marker: ${DOC_MARKER}

请验证 bot 能在群聊里拿到这份云文档的上下文。")"

DOC_TOKEN="$(printf '%s' "$DOC_CREATE_JSON" | jq -r '.data.document.document_id')"
DOC_URL="$(printf '%s' "$DOC_CREATE_JSON" | jq -r '.data.document.url')"

COMMENT_JSON="$(jq -nc \
  --arg bot "$BOT_OPEN_ID" \
  --arg group "$GROUP_NAME" \
  --arg workdir "$WORKDIR" \
  '{
    file_type: "docx",
    reply_elements: [
      {type: "mention_user", mention_user: $bot},
      {type: "text", text: (" /new " + $group + " " + $workdir)}
    ]
  }')"

COMMENT_CREATE_JSON="$(npx lark-cli drive file.comments create_v2 \
  --as user \
  --params "{\"file_token\":\"${DOC_TOKEN}\"}" \
  --data "$COMMENT_JSON")"

COMMENT_ID="$(printf '%s' "$COMMENT_CREATE_JSON" | jq -r '.. | objects | .comment_id? // empty' | head -1)"
COMMENT_REPLY_ID="$(printf '%s' "$COMMENT_CREATE_JSON" | jq -r '.. | objects | .reply_id? // empty' | head -1)"
test -n "$COMMENT_ID"
```

等待群绑定出现：

```bash
GROUP_CHAT_ID=""
deadline=$((SECONDS + 120))
while [ "$SECONDS" -lt "$deadline" ]; do
  GROUP_CHAT_ID="$(jq -r \
    --arg token "$DOC_TOKEN" \
    --arg comment "$COMMENT_ID" \
    '.[] | select(.cloudDocumentChat.provider == "feishu" and .cloudDocumentChat.fileType == "docx" and .cloudDocumentChat.fileToken == $token and .cloudDocumentChat.commentId == $comment) | .chatId' \
    "$CODELARK_HOME/data/channel-chats.json" 2>/dev/null | head -1)"
  [ -n "$GROUP_CHAT_ID" ] && [ "$GROUP_CHAT_ID" != "null" ] && break
  sleep 2
done
test -n "$GROUP_CHAT_ID"
```

在新群里验证上下文。这里刻意不把 `DOC_TOKEN` 或 `DOC_MARKER` 放进用户消息；否则模型即使没有云文档上下文也能照抄，断言会失效。

```bash
USER_MSG_JSON="$(npx lark-cli im +messages-send \
  --as user \
  --chat-id "$GROUP_CHAT_ID" \
  --text "请只回复本群绑定云文档的 file_type、file_token，以及文档正文里的 marker。")"
USER_MESSAGE_ID="$(printf '%s' "$USER_MSG_JSON" | jq -r '.data.message_id // .message_id')"

deadline=$((SECONDS + 180))
while [ "$SECONDS" -lt "$deadline" ]; do
  npx lark-cli im +chat-messages-list \
    --as user \
    --chat-id "$GROUP_CHAT_ID" \
    --page-size 20 \
    --format json >"/tmp/${RUN_ID}-messages.json"
  if jq -e \
    --arg reply_to "$USER_MESSAGE_ID" \
    --arg token "$DOC_TOKEN" \
    --arg marker "$DOC_MARKER" \
    '.data.messages[]? | select(.reply_to == $reply_to) | tostring | contains("docx") and contains($token) and contains($marker)' \
    "/tmp/${RUN_ID}-messages.json" >/dev/null; then
    break
  fi
  sleep 3
done
```

如果最后一个 `jq` 条件没有命中，本轮必须失败。失败报告需要附上：

- `DOC_URL`、`DOC_TOKEN`、`GROUP_CHAT_ID`。
- `CODELARK_HOME/logs/bridge.log` 中 `drive.notice.comment_add_v1` 附近的结构化 JSONL 日志，优先保留 `time`、`level`、`event`、`msg`、`chat`、`message` 字段。
- `CODELARK_HOME/data/channel-chats.json` 中对应 `cloudDocumentChat` 绑定。
- 群消息 transcript，尤其是用户消息和 bot `reply_to`。

## 清理

成功后清理群聊和云文档：

```bash
npx lark-cli api DELETE "/open-apis/im/v1/chats/${GROUP_CHAT_ID}" --as user --format json
npx lark-cli drive +delete --as user --file-token "$DOC_TOKEN" --type docx --yes
```

如果清理失败，报告不能标为完全通过；应把 retained 群聊和文档 token 写入报告，并给出后续手动删除命令。

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
