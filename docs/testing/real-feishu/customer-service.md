# 客服模式：真实群协议与模型验证

2026-10-10 使用 `lark-cli` 创建并保留三个私有群，当前登录用户在群中：

| 群 | 用途 |
| --- | --- |
| 客服测试-普通群回复链-1010 | 首问转话题、普通三级回复链、同群并发话题、白名单控制 |
| 客服测试-话题形式群-1010 | 原生 `group_message_type=thread` 首问及追问 |
| 客服测试-白名单与回归-1010 | 普通群 `/require-at` 行为回归 |

产品行为及官方协议来源见 [客服模式](../../product/customer-service.md)。

## 验证方式与边界

实际用户通过飞书 API 发送根消息、回复模型卡片、回复普通消息的回复；真实 `CodexProvider` 运行模型，真实 FeishuAdapter 创建并流式更新 CardKit 卡片。用户身份读取每个最终卡片的 `user_card_content`，并同时查询群时间线和话题历史。

测试使用独立 bridge home，未重启或重新部署生产 bridge。因为现有 App 已由生产 WebSocket 使用，先在这三个新建群的生产会话上启用 `/require-at on`，使生产端忽略不带 @ 的测试问题。隔离实例将相应群会话设置为 `/require-at off`，从 API 读取真实消息，转换为官方 SDK 入站结构后调用同一 adapter/manager 链路。

因此本记录属于**真实群协议与模型验证**，不计作生产 WebSocket 的 canonical E2E。卡片按钮已真实发送并由用户身份读取；白名单允许/拒绝和话题定位通过重放实际卡片的回调上下文验证，未执行飞书客户端按钮点击。没有使用 Computer Use。

## 通过的用户故事

- 普通群首问：机器人以 `reply_in_thread=true` 回答，用户读到 `ORDER-7139`。
- 话题形式群首问：用户读到 `ORDER-8246`；两个问题对应不同 BridgeSession 和原生模型线程。
- 重载 adapter/store/provider 后回复机器人卡片：仍使用原 `thread_id`、BridgeSession、原生线程，模型准确复述 `ORDER-7139`。
- 在后续独立测试进程中继续话题形式群的追问：仍记得 `ORDER-8246`。
- 普通三级链：根消息 → 第一层普通回复 → 第二层普通回复，真实返回的 `root_id` 与 `parent_id` 不同；机器人最终回复归入原根话题，答复 `CHAIN-35`。
- 同一物理群内两个模型 turn 并发：分别答复 `PARALLEL-ALPHA` 与 `PARALLEL-BETA`，话题、会话与最终卡片互不混淆。
- 将实际登录用户排除出控制名单时，其 `/stop` 不进入模型或控制队列，拒绝提示在原话题可见；加入名单后 `/current` 生效。
- 顶层 `/model gpt-6-astra` 修改隔离群会话的默认模型，真实反馈卡及其回调保留群级作用域。
- 普通非客服群继续执行会话 `/require-at` 规则；清空客服群列表后恢复普通群地址。
- 客服普通群也遵守同一规则：开启群 @ 要求后，未 @ 的首问和已有话题追问均被过滤；关闭后真实模型答复 `MENTION-FOLLOW-271`，追问仍在同一话题中。
- 话题内 `/require-at on` 确实修改所属群；用户身份读取 `/current common` 卡片，显示由 `off（跟随所属群）` 变为 `on（跟随所属群）`，没有独立 @ 选择框。刷新使用实际卡片的刷新动作回放，未执行客户端点击。
- 最终复读全部 7 张模型答复卡：内容完整、已退出流式状态，归属正确话题，未作为独立答复泛洪到群时间线。

同一登录用户通过切换隔离实例的白名单测试两种权限状态；未冒充第二个飞书用户。

客服模式基础版本验证：`npm test` 共 2054 项，2047 通过、7 跳过、0 失败；`npm run typecheck`、`npm run build`、`npm run docs:build` 均通过。

## 自动化覆盖与复查

```bash
unset NODE_OPTIONS
source ~/.nvm/nvm.sh
nvm use 24
node --import tsx --test \
  src/__tests__/unit/channels/feishu/customer-service.test.ts \
  src/__tests__/unit/configuration/customer-service-config.test.ts \
  src/__tests__/workflow/bridge/command/session-require-at.test.ts
```

自动化覆盖群级 @ 规则的开启/关闭及已有话题跟随、话题命令修改所属群及设置卡实时读取、旧话题配置不覆盖群规则、稳定根身份、缺失根信息时查询父链或话题、跨群/循环链拒绝、配置继承且不复用父线程、持久化恢复、入站文字/富文本控制、回调立即回执、manager 侧权限兜底、群移除清理所有话题、各消息格式及 Drive 群权限使用真实物理目标、配置开启/关闭和输入校验。发布还需运行完整 `npm test`、`npm run typecheck`、`npm run build`、`npm run docs:build`。

本次原始请求响应、用户读取结果和模型线程标识保存在开发 worktree 的 `work/customer-service/real/`，主要结果为 `verified.json`，@ 规则与卡片补验见 `mention-policy.json`、`mention-card.json`。该目录不入库，不包含在发布包中。

## 白名单命令补验（初版，默认管理员规则已由下节取代）

2026-10-10 在「客服测试-普通群回复链-1010」复用同一机器人，以独立 bridge home 验证 `/whitelist`。生产群仍要求 @ 机器人，测试消息不 @ 机器人，避免生产端执行；入站采用官方 API 读取的真实消息和真实 `mentions` 数据映射回 SDK 事件，没有启动第二条 WebSocket。

以下真实发送与用户身份读取均通过：已有明确允许用户发送 `/whitelist init`；查看名单和帮助；在话题内实际 @ 自己进行重复添加；添加隔离配置中的占位管理员 ID 后，实际 @ 自己移除；撤权后立即拒绝再次添加自己；本地恢复测试权限后，拒绝移除最后一位管理员。各反馈始终位于原话题，其他通道名单未变。占位 ID 仅用于隔离权限状态，不表示邀请或验证了第二名真人；多人 @ 和富文本 @ 另由自动化测试覆盖。

自动化同时覆盖普通文本与富文本事件、排除机器人 @、非法目标、空名单初始化限制、通道隔离、已排队控制和旧适配器的即时撤权，以及卡片回调拒绝。此次未新增交互按钮；不宣称客户端按钮点击或生产 WebSocket E2E。原始证据保存在白名单功能 worktree 的 `work/customer-service-admin/real/verified.json`。

白名单命令版本最终验证：`npm test` 共 2059 项，2052 通过、7 跳过、0 失败；`typecheck`、`build` 和 `docs:build` 均通过。


## 空名单默认 bot 创始人补验

2026-10-10 使用同一隔离群和真实机器人，在 `allowed_users` 与 `customer_service_control_users` 都为空的独立配置下验证。适配器实际调用飞书 `/application/v6/applications/me`，取得并核对当前应用的 `creator_id`；没有注入创始人身份，也没有预先添加用户或执行 `/whitelist init`。

以下真实发送与用户身份读取均通过：

- 创始人直接 `/whitelist`，显示默认 bot 创始人，持久化名单仍为空。
- 创始人直接 `/require-at off`，普通客服控制指令生效。
- 首次 `/whitelist add` 将创始人和新增成员一起保存。
- 在话题内真实 @ 自己重复添加、移除；显式名单排除创始人后，立即拒绝其重新添加自己。
- 清空隔离配置的名单后，恢复创始人的默认控制权限；拒绝移除最后一位有效管理员。
- 回复仍在原话题，其他通道的名单未改变。

第二个管理员仍为隔离占位 ID，不表示第二名真人验证；真实 @ 操作使用当前用户。入站仍采用实际消息的 SDK 结构回放，没有第二条 WebSocket，也未执行客户端卡片按钮点击。用户身份已读取全部最终反馈。原始证据在 `work/customer-service-admin/real/creator-verified.json`。

自动化额外覆盖错误应用 ID、缺失创建者字段、查询失败、并发身份查询去重、显式名单覆盖默认身份、清空恢复默认，以及卡片使用预取身份立即鉴权。最终 `npm test` 共 2061 项，2054 通过、7 跳过、0 失败；`typecheck`、`build` 和 `docs:build` 均通过。
