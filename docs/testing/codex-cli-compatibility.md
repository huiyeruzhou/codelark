# Codex CLI 0.163.0 兼容性验收

2026-10-16，在 macOS arm64、Node.js 24 上将全局 npm Codex CLI 从 0.153.4 更新为 npm `latest` 稳定版 0.163.0。使用真实 CLI、隔离 HOME/CODEX_HOME/工作目录和本地 Responses 模型 fixture；请求不会发往真实模型服务。Desktop App 与生产 Bridge 没有重启。

## 按上游源码确认执行边界

检查官方 `rust-v0.163.0` tag，commit `129b8ec7ee6f4511557a4856279f529025c25af4`。对外仍使用 `tmux` provider，内部区分执行所有权：

| 入口 | 执行与状态来源 | 升级和关闭含义 |
| --- | --- | --- |
| app-server 绑定 + tmux `--remote` | 绑定 endpoint 的后端执行；tmux 查看同一 thread | 关闭查看窗口不应停止任务；磁盘 CLI 更新不会替换已运行后端 |
| legacy tmux | 当前启动参数带 reasoning/base URL 等 `-c`，0.163 使用内嵌后端 | 已有 TUI 保持当前进程和参数；重建后才采用新版 CLI/新配置 |
| 原生 TUI 自动 daemon | 满足原生启动条件时连接或启动 managed daemon | 可能独立于 TUI 存活，需核对 CODEX_HOME 和实际 daemon 版本 |
| 旧 SDK exec | 使用项目 SDK 所安装的 CLI | 本次未升级 SDK，不能把其结果算作全局 0.163 验收 |

源码依据：

- [daemon 启动排除条件](https://github.com/openai/codex/blob/129b8ec7ee6f4511557a4856279f529025c25af4/codex-rs/tui/src/daemon_startup.rs)：`--no-daemon`、profile 和大多数配置覆盖使用内嵌路径。没有 `-c` 的专门实验确实启动了隔离 managed daemon，已核实 PID 与安装目录后用原生 daemon stop 清理。
- [turn 请求处理](https://github.com/openai/codex/blob/129b8ec7ee6f4511557a4856279f529025c25af4/codex-rs/app-server/src/request_processors/turn_processor.rs)：steer 要求实际 `expectedTurnId`；interrupt 校验活动 turn，终态由原生事件确认。CodeLark 不应以请求成功、tmux 存在或关闭窗口替代 turn 状态。
- [官方 app-server 文档](https://learn.chatgpt.com/docs/app-server)与 [CLI 文档](https://learn.chatgpt.com/docs/codex/cli)同时核对；旧 developers.openai.com 路径当前跳转到这些官方页面。

还有一个容易误判的附加请求：[TUI 自动标题生成](https://github.com/openai/codex/blob/129b8ec7ee6f4511557a4856279f529025c25af4/codex-rs/tui/src/app/thread_title.rs)会为未命名聊天启动 `thread_title` 来源的临时隐藏线程。它可能调用另一个模型；看到额外 Responses 请求时必须核对 thread/turn/source，不能直接判定用户输入被重复执行。原生交叉验收先给线程命名；真实飞书入口验收允许实际生成标题，用严格的原生 title schema 与指令识别辅助请求，单独记录 `auxiliaryModelRequests`，不消耗用户 turn 的预编排响应。普通用户引用该文案仍走严格队列。

## 修复一：默认 app-server socket 发布

首次升级验收初始化成功后报“app-server 未创建预期的 Unix socket”。0.163 将 `--listen unix://…/rpc.sock` 发布为符号链接，目标才是原生管理的 socket；旧实现只接受 `lstat().isSocket()`。

修复在协议和 CODEX_HOME 验证后接受普通 socket 或指向 socket 的符号链接。记录入口自身类型及 dev/ino，退出清理只删除本次拥有、未被替换且无监听者的入口，不删除链接目标。29 项 workflow 覆盖并发准备、外部复用、正常退出、崩溃恢复和路径替换。

依据：[原生 Unix socket 发布和清理](https://github.com/openai/codex/blob/129b8ec7ee6f4511557a4856279f529025c25af4/codex-rs/app-server-transport/src/transport/unix_socket.rs)。生命周期验收另将 macOS `/var` 与 `/private/var` 按 realpath 比较，仍要求服务端 codexHome 非空且指向同目录。

## 修复二：三个 legacy TUI 兼容问题

升级后首次真实 TUI 验收为 4/7 通过。换用当前模型只使结果变为 5/7，不能归因于测试模型过期。三项现已适配：

1. **停用模型通知卡住首条输入。** 新版不再显示编号选项，而是完整迁移说明和 `enter/esc continue`。严格匹配原生通知后转成“继续”选择，等用户确认后继续原输入；不自动更改用户模型配置。退出键同时识别 macOS 的 `⌃c`、Linux 的 `^c` 和 `ctrl+c`；首轮 Linux CI 的实际屏幕暴露了仅覆盖 macOS 写法的问题。拒绝已进入 scrollback 的旧通知。依据：[model_migration.rs](https://github.com/openai/codex/blob/129b8ec7ee6f4511557a4856279f529025c25af4/codex-rs/tui/src/model_migration.rs)。
2. **goal 浮层被底层 composer 游标遮蔽。** 按标题、选中项和 footer 提取浮层，排除左侧活动历史及下方输入框。支持高亮 Cancel 时正确执行选择，同时保留其他弹窗原来的保守识别条件。依据：[thread_goal_actions.rs](https://github.com/openai/codex/blob/129b8ec7ee6f4511557a4856279f529025c25af4/codex-rs/tui/src/app/thread_goal_actions.rs)。
3. **模型恢复警告藏入 F2 导致漏报。** 原生恢复会比较上一轮 `turn_context` 模型，发送 Warning，再写入并 flush 本次 `thread_settings_applied`。CodeLark 捕获本次自己启动的 resume 前后检查点，核对线程、文件 identity 和追加 offset，读取实际生效模型；复用原警告卡和去重。保留旧屏幕检测，不操作 F2、不根据请求参数推测实际模型、不改写 rollout。依据：[session/mod.rs](https://github.com/openai/codex/blob/129b8ec7ee6f4511557a4856279f529025c25af4/codex-rs/core/src/session/mod.rs)、[rollout_reconstruction.rs](https://github.com/openai/codex/blob/129b8ec7ee6f4511557a4856279f529025c25af4/codex-rs/core/src/session/rollout_reconstruction.rs)。

恢复警告的追加检测仅用于本次自己启动的 legacy resume；文件替换、截断或跨 rollback/compaction 的不确定状态不会生成推测警告。新轮次开始前的实际模型展示也读取同线程原生 settings checkpoint。

## 原生验收

真实飞书入口补测发现旧 tmux 的本地 bootstrap 只设置了 `openai_base_url`。当 `config.toml` 选择自定义 provider 时，占位请求实际到达该服务，可能污染首轮输出。现在短命 bootstrap exec 同时指定内建 OpenAI provider 和 loopback；0.163.0、0.153.4 均验证 bootstrap 的模型请求数为零、占位内容被清理、配置字节不变，随后恢复同一线程仍向原自定义服务发送真实输入。此验证覆盖普通配置，不代表管理员强制 provider 路由已被覆盖。

- **0.163.0 legacy TUI：7/7；0.153.4 对照：7/7。** 同一测试文件覆盖恢复线程与警告去重、生成结束前发送文件且不重复、429 错误滚屏后保留、全新 YOLO 首条输入、`/new` 首条输入、中英文多行和数千字输入、活动 goal 替换选择。未删除原失败断言。
- **0.163.0 app-server：协议生命周期、默认 OpenAI provider、自定义 provider 均通过。** 包括同轮 steer、并发 start 的实际 turn 身份、interrupt、断线/丢失响应后不重复提交、审批与动态请求、线程工具环境、跨进程复用、拥有者退出、SIGKILL 后同地址恢复。原 auth.json 字节不变。
- **0.163.0 remote tmux 与 app-server 交叉验收通过。** `--tmux-view` 验证显示已有线程历史、打开窗口不发用户 turn、steer 进入同一 turn 且实际抵达模型、关闭窗口后任务仍 active、协议 stop 产生 interrupted 终态，以及随后新线程、拥有者关闭和崩溃恢复仍正常。原生 TUI 的隔离模型迁移由测试明确确认；测试线程提前命名，排除自动标题请求。
- **0.153.4 app-server 对照通过。** 使用临时 global npm prefix 的 `bin/codex`，未回滚全局 CLI。最初误用 `node_modules/.bin` 被正确拒绝的尝试不计入版本兼容结论。

重跑协议与默认后端：

```bash
nvm use 24
node --import tsx scripts/verify-codex-app-server-lifecycle.ts --cli "$(command -v codex)" --expect-version 0.163.0 --evidence /tmp/codex-protocol-fresh
node --import tsx scripts/verify-codex-default-app-server.ts --cli "$(command -v codex)" --evidence /tmp/codex-default-fresh
node --import tsx scripts/verify-codex-default-app-server.ts --cli "$(command -v codex)" --custom-provider --evidence /tmp/codex-custom-fresh
node --import tsx scripts/verify-codex-local-bootstrap.ts --cli "$(command -v codex)" --evidence /tmp/codex-bootstrap-fresh
# macOS/Linux，需安装原生 tmux；内部自行建立并核验独占 socket
node --import tsx scripts/verify-codex-default-app-server.ts --cli "$(command -v codex)" --tmux-view --evidence /tmp/codex-remote-view-fresh
```

每次使用新的 evidence 目录。完整 `npm test` 自带每组 tmux 隔离；不要再套一个强制固定 socket 的 tmux wrapper，否则会覆盖测试组隔离。单独手工实验使用已验证的独占 socket、去掉继承 TMUX/TMUX_PANE，并仅清理确切 session。

## 全量检查

包含真实飞书补测修复后的 `npm test`：2093 项，2086 通过、7 跳过、0 失败。`npm run typecheck`、`npm run build`、原生验收脚本严格类型检查和 `npm run docs:build` 均通过。0.163.0 新增专门的 legacy TUI 和 remote tmux 交叉 CI gate；协议矩阵保留 0.145.0、0.153.4、0.160.0，并新增 0.163.0。bootstrap 自定义模型回归加入 0.153.4/0.163.0 两个 CI 分支。远端 CI 尚未执行，本机结果不替代 Linux/Windows/Desktop GUI 验收。

## 真实飞书验证与限制

创建并保留隔离群“CodeLark Codex 0.163 兼容验证 1016”，包含当前登录用户。真实 CLI/Bridge 产生的三张卡通过生产 Feishu renderer、真实 CardKit/IM 和 lark-cli 发出，再用用户身份读取 `user_card_content` 核对标题、实际模型和选择项：

| 原生触发 | 用户身份读回的消息 |
| --- | --- |
| 恢复模型警告 | `om_x100b622974418c80cfdaa68144888fb` |
| 停用模型“继续” | `om_x100b622974070484cefefc9f00752ed` |
| goal 替换/取消 | `om_x100b6229758ef0b0b096baa95445768` |

三项原生场景通过。这一批选择回调由测试驱动调用真实 Bridge 处理路径，未覆盖用户入站 WebSocket，也未验证真人点击；证据在任务 worktree 的 `work/real-feishu-codex163/report.json` 与 `work/tui-feishu.log`。

随后补充完整入口测试：飞书用户 API 发送 → 真实 WebSocket Bridge → 全局 Codex 0.163.0 → 飞书用户身份读回。只有模型 SSE 输出由本地 fixture 控制，未调用真实云模型。

- **legacy tmux：5/5 通过。** 首条输入、160 行中文完整性、同轮 steer 的原生 turnId、`/stop` 原生 abort、停止后同线程继续。6 条用户模型请求、1 条辅助标题请求、0 条非预期请求。证据 `work/feishu163-legacy-r2/report.json`。
- **app-server：31/31 自动检查通过。** 包含运行中配置保存/下轮应用、@ 过滤、同轮 steer、stop 原生与卡片终态、运行中 clear 真实文字确认、新群继承与隔离、Bridge 重启同线程续用且无额外卡片、原生问答的真实文字回答、原生审批卡用户读回。78 条真实用户输入完整回读；主群 119 条消息/3 页，新群 48 条/1 页。17 条用户模型请求、2 条辅助标题请求、0 条非预期请求。证据 `work/feishu163-e2e-r5.json`，`automaticPassed=true`。

首次完整功能执行后，最终全输入读回发现默认场景遗漏分页：只读取最近 50 条，较早的用户输入被误判为丢失。所有 lifecycle 场景现均使用已有的严格分页读取，保留用户身份、游标、去重与页数限制；上述 31/31 是修复后的新群完整重跑结果，失败的 r4 报告保留。

重跑真实飞书 app-server 自动部分（使用已授权的专用测试 app，环境文件应包含实际 app secret，不能是 keychain 引用）：

```bash
CODELARK_REAL_FEISHU_E2E=1 CODELARK_CODEX_CLI_PATH="$(command -v codex)" \
  node --import tsx scripts/real-feishu-e2e.ts \
  --launch-bridge --codex-app-server --scenario app-server-lifecycle \
  --runtime codex --provider tmux --lark-profile codelark-attachments-e2e \
  --test-env-file /path/to/private-test.env --run-id codex-compat-unique \
  --run-root /tmp/clk-real-feishu-fresh --output /tmp/codex-feishu-result.json
```

默认清理新建测试群；本轮曾为用户查看临时保留，随后按用户指令解散共 22 个已完成的测试群，并复查群列表确认删除，消息内容与协议证据保存在本地报告中。自定义 run-root 应保留 `clk-real-feishu-` 前缀，自动 tmux 清理会验证该前缀。本轮短路径不符合此保护条件，因此额外核验三个独占 socket，并逐个清理了 7 个残留的测试查看窗口。

真实飞书测试依然**不包含真人客户端按钮点击验收**。审批卡可以由用户身份读回；没有实际点击时，测试通过真实 `/stop` 取消审批并把 `acceptanceComplete` 保持为 false。凭据预检拒绝误传 lark-cli keychain 引用，避免把引用文本写成测试 app 的密钥。

官方 Desktop GUI、本机生产 Bridge 热更新、远端平台 CI 未执行。生产进程保持原状；全局 CLI 当前为 0.163.0。
