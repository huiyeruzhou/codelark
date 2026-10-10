# 图片、文件与合并消息验证

## 可重复运行的完整端到端测试

`npm run real:feishu:attachments` 连接一个专用测试 CodeLark 实例。该实例必须配置独立于正式环境的飞书 App，并已通过 `lark-cli` 完成该 App 的用户授权。测试经产品建群流程创建新的用户所属测试群，保留该群供查看。建群 helper 使用产品 adapter 调用飞书 API；消息收发仅由实际运行的 bridge 监听，不另起 WebSocket、不重放 SDK 事件，也不代替模型发送答案。

```bash
unset NODE_OPTIONS
source ~/.nvm/nvm.sh
nvm use 24
CODELARK_REAL_FEISHU_E2E=1 npm run real:feishu:attachments -- \
  --home ~/.codelark-attachments-e2e --profile <测试App用户profile> --runtime codex

CODELARK_REAL_FEISHU_E2E=1 npm run real:feishu:attachments -- \
  --home ~/.codelark-attachments-e2e --profile <测试App用户profile> --runtime cursor \
  --cursor-thread <Cursor-Desktop测试对话ID>
```

Cursor Desktop 需要一条标题含 `CodeLark` 和 `E2E` 的空闲专用对话。现有 bridge 接口不能新建 Desktop 对话，因此首次由用户在 Desktop 建立；测试只绑定显式传入的 ID。不会自动选择工作对话，也不会为测试修改 Cursor.app。提供方始终称为 `tmux`，Desktop 是其内部 transport。

测试依次覆盖：开启 `/require-at on` 后，带 @bot 和 `width`/`height` 的真实用户富文本图片、用户文件 citation、机器人文件 citation、模型自动发回图片与文件、两层合并引用、执行中带附件 steer。用户先发送不带 @ 的文件，确认没有模型响应，再 @bot 引用这条文件消息提问，并核对实际 `parent_id`。图片随机选择纯色，文件带随机首行，预期值不放入问题；答案必须来自模型对附件的读取。回传只要求“请把刚才收到的图片和文件原样发回来”，不提示目录或链接格式，图片与文件通过用户身份下载并逐字节核验。最终还要求原生 thread 不变、原生执行中的 steer、没有额外 SDK stream、用户身份读回机器人答案，以及合法图片不能触发不支持内容的误报。

报告和原始 API 回读保存于 `work/real-feishu/attachments-<runtime>-<timestamp>/`。`report.json` 只有所有 gate 通过才写 `passed=true`，异常、超时和缺失附件都失败；失败会向本次测试群发送 `/stop`。测试不停止正式 bridge；测试群和测试实例保留，方便复查。普通 `npm test` 只运行验收 gate 的负向测试和 PNG fixture 检查，不能代替此真实端到端入口。

### 2026-10-10 当前主要场景验收

`attachments-codex-20261010-r7` 完整通过，保留用户所属测试群 `oc_baf5bad1a18a701eb7e38f8682271139`。群聊开启 `/require-at on`：图文消息在同一条消息中 @bot；普通文件先发送，再由用户 @bot citation 提问。裸文件被过滤且没有启动模型，citation 的真实 `parent_id` 指向文件消息，随后模型成功读取随机首行。

用户文件引用、机器人文件引用、两层合并引用、自然语言要求自动回传图片及文件、执行中引用新文件 steer 均通过。回传附件逐字节一致，始终同一原生 thread/steer turn，没有额外 SDK stream。带尺寸的图片没有“不支持内容”误报。新版 bridge 的附件补充使用 `<local_attachments>` XML；原生输入与实际本地文件读取已核对。报告和用户 API 读回保存在 `work/real-feishu/attachments-codex-20261010-r7/`。

此前 r6 已验证新版 XML、无尺寸误报及不要求 @ 时的直接文件路径，作为补充场景。r7 才是对应常用 @ + citation 操作的主要验收。Cursor Desktop 的独立实测仍待专用对话，不能用 Codex 实测替代。

### 2026-10-10 早期完整链路实测与漏检

独立测试 App 的 `attachments-codex-20261010-r4` 原测试断言通过。测试群 `oc_45da3245d17789075f9348bfc4773665` 保留当前用户；原生线程 `01a12654-6b0e-72a2-8f5d-1af70b30e8b0` 从头到尾一致。真实 WebSocket 入站、模型自动识图/读文件、引用未见文件、嵌套合并图片与文件、自动回传附件字节核对、同一 turn 的附件 steer 均通过，未新增 SDK stream。证据位于本地 `work/real-feishu/attachments-codex-20261010-r4/report.json` 及同目录用户 API 读回。该轮回传曾明确提示输出 Markdown 链接；后续 r5 移除这些提示，自然语言回传也通过。

用户随后指出图片误报。回查 r5 真实用户读回，机器人确实额外发送了 `width, height` 不支持的通知；飞书会自动补充这些尺寸字段。原断言只检查成功答案，漏查额外告警，因此 r4/r5 不能算最终用户体验验收。当前脚本已补无误报断言，原报告与错误消息保留作为诊断证据。

实际平台差异也已纳入测试：消息列表对 CardKit 2.0 返回兼容占位，需逐条以 `user_card_content` 获取内容；paginated Codex app-server 不支持 `includeTurns=true`，活动状态从原生 RPC 读取，turn ID 从该线程 JSONL 读取。前面失败的运行保留记录，未计为通过。产品状态刷新同时兼容明确的 `list_turns is not supported yet` 错误，避免 `/stop` 因读取历史失败。

Cursor Desktop 的真实运行仍等待专用空白测试对话，不能以 Codex 的通过结果替代。

## 早期分段验证记录

2026-10-10 使用 `lark-cli` 在保留的「客服测试-白名单与回归-1010」群验证通用附件能力。当前用户在群中，本次运行的隔离配置未开启客服模式。产品行为见 [图片、文件与合并消息](../../product/message-attachments.md)。

## 已验证

- 读取用户提供的引用文件：识别 `file` 和文件名 `bridge.log`，实际下载 5,507,064 字节，并将附件与引用上下文关联。
- 读取用户提供的合并转发：接口返回根消息及 3 条子消息；按 `upper_message_id` 展开，保留文字和原始交互卡内容，共 28,971 字符，不再只有 CLI 读取提示。
- 将模型输出形式的本地 Markdown 图片、文件链接交给出站解析器和真实 FeishuAdapter。用户身份读取确认消息类型分别为 `image`、`file`；下载结果与原始 PNG、文本文件逐字节一致，路径包含空格。
- 用户回复图片，询问底色：真实 Codex 原生 thread 接收 `localImage`，回答 `red`。
- 用户继续回复文件，要求读取第一行：同一原生 thread 通过本地工具读取文件，回答 `ATTACHMENT-3941`。
- 两次附件追问均未进入 SDK 执行分支，CardKit SDK 卡片创建数为 0；答案发回原引用目标，用户身份读取内容一致。
- 将同群的测试图片和文件真实合并转发，用户读取确认根消息与两条带 `upper_message_id` 的子消息。直接使用合并包里的资源 Key 下载失败（实测 `234003 File not in msg`；文档另明确列出 `234043` 不支持合并子消息）。重新读取当前群中的原消息后，adapter 用原 Key 下载成功，两份附件均与原文件逐字节一致。跨群、已编辑或无法读取原消息时不会假称附件已下载。

## 验证边界

测试使用独立 bridge home 和专用模型 thread。生产测试群已有 `require_mention=true`，测试消息不 @ 机器人；未热更新生产 bridge，也未新增生产 WebSocket 连接。

入站消息由真实 API 发送和读取，再映射为 SDK 事件调用 adapter/manager；模型确实通过原生生命周期执行。模型答案由测试 harness 调用 adapter 发送，未覆盖生产 mirror 自动输出。因此这份结果是**真实飞书收发与原生模型验证**，不计作生产 WebSocket/mirror canonical E2E，也不宣称 Cursor Desktop 已经实机验收。

自动化补充覆盖嵌套合并及附件不可下载提示、普通文件与富文本图片、跨群引用拒绝、资源下载失败、消息条数/字符/下载次数上限，以及本地路径解析、同名附件保存、原生会话无额外 SDK 执行卡和 Cursor 执行中无正文附件 steer。原始请求响应、消息 ID、模型线程和字节摘要保存在功能 worktree 的 `work/image-messages/real/verified.json`，不入库。
