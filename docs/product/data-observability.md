# 数据、可观测性与验证

## 本地数据

默认数据目录是 `~/.codelark`。

| 文件 | 用途 | 代码入口 |
| --- | --- | --- |
| `config.toml` | 全局主配置，使用 v2 TOML shape | [src/configuration/service.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/configuration/service.ts)、[src/configuration/schema.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/configuration/schema.ts) |
| `config/sessions/<session-id>.toml` | Session 级持久化覆盖，例如 cwd、模型、provider、sandbox、reasoning、tmux 显式绑定 | [src/configuration/service.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/configuration/service.ts)、[src/domain/session-runtime.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/domain/session-runtime.ts) |
| `config/channels/<channel-id>.toml` | Channel 级持久化覆盖，复用同一套 TOML shape | [src/configuration/service.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/configuration/service.ts) |
| `config.json` / `config.env` | v1 迁移输入；迁移成功后归档为 `.migrated-v1*`，不再作为运行时配置来源 | [src/configuration/migrations/v1.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/configuration/migrations/v1.ts) |
| `data/sessions.json` | BridgeSession | [src/storage/json-store.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/storage/json-store.ts)、[schemas/data/sessions.v1.schema.json](https://github.com/huiyeruzhou/codelark/blob/master/schemas/data/sessions.v1.schema.json) |
| `data/channel-chats.json` | ChannelChat 绑定 | [src/storage/json-store.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/storage/json-store.ts)、[schemas/data/channel-chats.v1.schema.json](https://github.com/huiyeruzhou/codelark/blob/master/schemas/data/channel-chats.v1.schema.json) |
| `data/messages/<sessionId>.json` | Bridge 消息缓存 | [src/storage/json-store.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/storage/json-store.ts)、[schemas/data/messages.v1.schema.json](https://github.com/huiyeruzhou/codelark/blob/master/schemas/data/messages.v1.schema.json) |
| `data/audit.jsonl` | 审计日志，当前新记录按 JSONL 追加；旧 `data/audit.json` 仍会被读取 | [src/storage/json-store.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/storage/json-store.ts)、[schemas/data/audit.v1.schema.json](https://github.com/huiyeruzhou/codelark/blob/master/schemas/data/audit.v1.schema.json) |
| `runtime/status.json` | Bridge 运行状态 | [src/entrypoints/daemon.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/entrypoints/daemon.ts)、[src/local-service/manager.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/local-service/manager.ts) |
| `runtime/ui-server.json` | UI 运行状态 | [src/operator-ui/server.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/operator-ui/server.ts)、[src/local-service/manager.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/local-service/manager.ts) |

Codex 自有数据仍在 `~/.codex`；CodeLark 只读索引和镜像。Claude Code 自有 JSONL 也由 Claude Code 生成；bridge 只保存可继续定位它的 runtime 身份。

## 可观测性

CodeLark 的可观测性来自四层：

- IM 内状态命令：`/status`、`/check`、`/his`、`/doctor`。
- 本地日志：`~/.codelark/logs/bridge.log`、hot update log。`bridge.log` 是结构化 JSONL；常用字段包括 `time`、`level`、`msg`、`name`、`event`、`duration_ms`、`lane`、`channel`、`chat`、`category`。
- 本地 JSON/JSONL 数据：sessions、channel-chats、messages、audit。
- 真实 E2E 报告：real Feishu harness 输出的成功或失败 JSON report。

关键性能事件：

- `perf.feishu.request`：飞书 API 请求耗时，常用字段包括 `target`、`operation`、`status`、`duration_ms`、`chat`、`message_id`、`stream_key`。
- `perf.delivery.send`：delivery pipeline 发送耗时，常用字段包括 `channel`、`chat`、`status`、`duration_ms`、`kind`。
- `perf.card.sync_plan`：CardKit streaming card 同步计划，常用字段包括 `stream_key`、`operation`、`reason`、`full_refresh_reason`、`action_count`、`shadow_trust`。
- `perf.card.full_refresh_payload`：整卡刷新 payload 规模，常用字段包括 `stream_key`、`component_count`、`payload_bytes`、`markdownCount`、`buttonCount`。
- `perf.card.lifecycle`：单张流式卡片生命周期汇总，常用字段包括 `terminal_status`、`elapsed_ms`、`flush_attempts`、`flush_failures`、`full_refresh_count`、`api_top`。
- `perf.mirror.batch` / `perf.mirror.subscription`：mirror reconcile 批次和慢 subscription，常用字段包括 `runtime`、`duration_ms`、`concurrency`、`binding_id`、`status`。
- `perf.mirror.subscription_stage`：慢 mirror subscription 的子阶段耗时，当前覆盖 `route_records` 和 `deliver_turns`，用于区分本地 JSONL 读取与下游 runtime/飞书投递等待。
- `perf.thread_table_pin`：线程表置顶后台任务耗时，常用字段包括 `channel`、`chat`、`scope`、`status`、`duration_ms`、`message_id`、`previous_pinned_message_id`。
- `adapter.message.scheduled` / `adapter.message.started` / `adapter.message.finished`：adapter 入口生成的消息 span timeline；普通 command/callback 使用 chat job 并发执行，只在同 chat 存在 active conversation barrier 时等待；regular prompt 使用 `session:<session_id>` lane；`/runtime`、`/provider`、`/clear`、`/cd`、`/model`、`/mode`、`/sandbox`、`/network`、`/reasoning`、`/current-config`、session-mutating `/t` 等命令会进入 session queue 并声明 `conversation_barrier=true`，阻塞同一对话后续非 control command/job；`/stop`/permission/screen-stop 等高优先级控制消息使用 control lane；`/tmux-screen`、`/pty-screen`、`/shell` 使用 job lane，其中 screen monitor job 不等待 conversation barrier，`/shell` 等普通 job 仍等待。可直接按 `span_id`、`parent_span_id`、`lane`、`lane_kind`、`job_kind`、`conversation_barrier`、`message_id`、`session_id`、`started_at_ms`、`ended_at_ms`、`duration_ms` 聚合。
- `adapter.message.wait` / `adapter.message.handler`：adapter 队列等待和 handler 慢路径告警，复用同一 span 字段；排队阻塞关系写入 `blocked_by_span_id`、`blocked_by_message_id`、`blocked_by_session_id`、`blocked_by_category`、`blocked_by_started_at_ms`、`blocked_by_age_ms`。
- `session.executor.scheduled` / `session.executor.started` / `session.executor.finished`：BridgeSession 串行执行队列的结构化事件，常用字段包括 `session_id`、`job_kind`、`queued_before`、`queued_after`、`wait_ms`、`raw_wait_ms`、`run_ms`、`status`。
- `perf.startup.channel_chat_check`：启动期 ChannelChat 存活检查耗时；`status=deferred` 表示启动通知已先发，检查会继续在后台完成。

设计模块：

- 状态命令：[src/bridge/command/status.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/bridge/command/status.ts)
- 诊断命令：[src/bridge/command/diagnostics.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/bridge/command/diagnostics.ts)
- 健康检查：[src/bridge/health/runtime.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/bridge/health/runtime.ts)
- transcript source：[src/bridge/session/transcript-source.ts](https://github.com/huiyeruzhou/codelark/blob/master/src/bridge/session/transcript-source.ts)
- Doctor 脚本：[scripts/doctor.sh](https://github.com/huiyeruzhou/codelark/blob/master/scripts/doctor.sh)、[scripts/doctor.ps1](https://github.com/huiyeruzhou/codelark/blob/master/scripts/doctor.ps1)

## 验证入口

- 普通单元/集成测试：[scripts/run-tests.js](https://github.com/huiyeruzhou/codelark/blob/master/scripts/run-tests.js)
- 类型检查：`npm run typecheck`
- 真实飞书 E2E harness：[scripts/real-feishu-e2e.ts](https://github.com/huiyeruzhou/codelark/blob/master/scripts/real-feishu-e2e.ts)
- 覆盖审计文档：[docs/testing/coverage-audit.md](../testing/coverage-audit.md)
- 真实飞书 E2E：[docs/testing/real-feishu/index.md](../testing/real-feishu/)

真实飞书 E2E 的目标不是替代所有单元测试，而是证明关键用户场景确实能经过飞书客户端、真实 bridge、真实 runtime provider 和真实回复链路。
