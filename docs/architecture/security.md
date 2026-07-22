# CodeLark 桥接安全模型

## 威胁模型

bridge 会把 IM 平台消息暴露给 LLM。主要风险包括：

1. **未授权访问**：任何能给 bot 发消息的人都可能获得 LLM 访问能力。
2. **提示词注入**：恶意内容可以通过 IM 消息进入模型上下文。
3. **命令注入**：`/cwd` 等命令中的路径穿越或 shell 元字符可能造成风险。
4. **拒绝服务**：高频消息可能造成资源耗尽。
5. **权限绕过**：伪造回调请求或重复点击按钮可能绕过审批语义。

## 缓解措施

### 身份认证与授权

每个 adapter 都实现 `isAuthorized(userId, chatId)`：

- **飞书**：使用已配置的用户白名单、群策略和 mention 检查。

未授权消息会被静默丢弃，不返回响应，避免泄漏信息。

### 输入校验（`security/validators.ts`）

- `validateWorkingDirectory()`：拒绝相对路径、`..` 路径穿越和 shell 元字符（`|;&$`）。
- `validateSessionId()`：只接受 32-64 字符的 hex/UUID 格式。
- `isDangerousInput()`：检测路径穿越、命令注入、null byte 和控制字符。
- `sanitizeInput()`：移除控制字符（保留 `\n`、`\t`），并限制最大长度为 10,000 字符。
- `validateMode()`：使用白名单（`normal`、`yolo`）。

### 限流（`security/rate-limiter.ts`）

采用 per-chat 滑动窗口限流：默认每个 chat ID 每分钟最多 30 条普通出站消息。空闲 bucket 会定期清理。

交互消息不进入普通出站限流队列，包括权限按钮、富卡片和富卡片更新，避免确认卡被长文本、mirror 输出或诊断回复压住。普通消息如果预计因为本地限流等待超过 3 秒，会先旁路发送一条高优先级提示，告知当前聊天普通回复已进入队列且确认卡仍会优先发送；同一 chat 的提示有 60 秒冷却，避免刷屏。限流等待前后都会输出 `[delivery] Outbound rate limiter ...` 日志，包含 chat、消息类型、chunk index 和等待时间。

`CODELARK_DISABLE_OUTBOUND_RATE_LIMIT=1` 可关闭普通出站限流，主要用于测试或紧急排障。

如果平台返回远端 429/rate-limit，delivery 层会记录 `[delivery] Remote rate-limit response; not retrying locally` 并直接返回失败，不再循环睡眠重试，避免进一步放大拥塞。

### 权限安全

- **来源校验**：回调必须来自原始权限提示所在的同一聊天和同一消息 ID。
- **原子去重**：`markPermissionLinkResolved()` 使用原子 check-and-set，防止并发按钮点击造成竞态。
- **内存去重**：`recentPermissionForwards` map 防止 30 秒窗口内重复转发。

### 审计日志

所有入站和出站消息都会通过 `store.insertAuditLog()` 记录：

- 通道类型、chat ID、方向、message ID 和截断后的摘要。
- 被拦截的危险输入会带 `[BLOCKED]` 前缀。
- 被截断的输入会带 `[TRUNCATED]` 前缀。
- 也可以用于后台任务分析

### 传输安全

- 所有平台 API 都使用 HTTPS。
- Bot token 存放在宿主机配置存储中，不写入 bridge 代码。
- UI 中会对 token 做脱敏，降低意外泄漏风险。

## 部署建议

1. 始终配置 `allowed_users`，不要开放给所有人使用。
2. bridge 和通知用途使用不同 bot token。
3. 监控审计日志中的异常模式。
4. 在运维手册中保留 bot token 轮换流程。
5. 根据部署环境考虑对宿主应用增加网络层限制，例如防火墙或 VPN。
