# macOS Desktop GUI 与登录顺序验收

`scripts/verify-codex-desktop-macos.ts` 在一次性 macOS 26 runner 上启动官方 `~/Applications/Codex.app`，真实 Codex CLI 连接本地 mock 模型。GUI 是验收对象，只有模型响应被替换。不修改或执行解包后的 Desktop 通信模块，不创建假的 `.app`，不调用 renderer 内部状态或发消息接口。

当前实际进度：[CI 37144640293](https://github.com/huiyeruzhou/codelark/actions/runs/37144640293)（`030eca6`）已通过全部当前 GUI 故事：共享 thread 收发、审批、问答、退出重开、重载服务后新 GUI 回合、晚服务启动后重开并完成新 GUI 回合，以及 disable 后默认 stdio GUI 新回合。官方 App 为 `26.930.31730`，CLI 为 `0.160.0`；两处新增恢复回合均经原始 CDP、模型请求与同 thread/turn 原生事件复核，非仅凭历史可见或 observer resume 判定。实际 OS 登录以及无需重开 Desktop 的恢复仍未验证。

## 执行与判断

Node.js 24、`npm ci`、Codex CLI `0.160.0`、官方 App 和 Xcode Command Line Tools（使用 clang 编译 CoreGraphics 查询器）安装完成后运行：

```bash
CODELARK_DESKTOP_CI=1 \
CODELARK_DESKTOP_CI_EVIDENCE=/tmp/codelark-desktop-gui-acceptance \
node --import tsx scripts/verify-codex-desktop-macos.ts
```

此命令只适用于一次性测试 macOS 用户。它要求没有既有 CodeLark Desktop LaunchAgent 或 Desktop 连接环境，创建自己的 backend 后在结束时禁用和清理。Desktop 使用独立 `CODEX_HOME` 和 Electron 用户目录，模型 key 是无效的 fixture 标记，模型请求只到本次 mock。不要在日常用户机器直接运行。

Desktop 专用 `config.toml` 使用 `approval_policy="on-request"`、`sandbox_mode="read-only"` 和原 fixture 模型 `gpt-5.4`，与共享线程初始设置保持一致。通用 CLI fixture 的 `never` 默认值仅在本次独占目录中替换，其他原生验收和生产配置不受影响。配置副本保存在 `desktop-fixture-config.toml`。命令工具和 Plan 问答仍必须实际出现在 `body.tools`；等待审批/问答时若对应 turn 已结束却没有真实请求，立即记录实际工具输出并失败。

驱动通过 `/usr/bin/open -n -W` 启动 App，只传隔离目录与 Electron CDP 参数；不传 `CODEX_APP_SERVER_WS_URL`，该地址必须由 LaunchServices 从当前用户 launchd 环境继承。CDP 必须返回可见 renderer 和属于指定 App 的 Electron PID，macOS CoreGraphics 必须报告该 PID 的实际 onscreen 窗口。截图、DOM、Accessibility tree、CDP 操作日志、模型请求、Bridge 收到的协议、App 版本、签名检查和 `app.asar` SHA-256 一起保存。鼠标点击和键盘输入走 CDP Input 域，读取 DOM 只用于定位和断言。

CoreGraphics 查询器在启动 GUI 前用 clang 编译一次，之后每次重开都复用同一可执行文件，仅输出该次 Electron PID 的普通可见窗口；窗口至少为 500×400。源码保存为 `desktop-gui-window-query.c`，二进制摘要写入结果。`commands.jsonl` 保存命令耗时和失败时的退出码、signal、killed、stdout/stderr，便于区分查询工具失败和 App 未显示窗口。

隔离 Electron profile 首次运行会显示向导。驱动在真实角色页选择 `Engineering`，取消 `Suggest personalized tasks` 并确认选中状态，然后点击 `Continue`；后续只使用公开的 `Not now`、`Skip` 或 `Get Started`，若出现跳过确认框则在框内点击 `Go to ChatGPT`（有奖励提示的版本为 `Skip`）。不会导入凭据、启用可选系统权限或写入应用内部状态。每次操作记录 `onboarding.jsonl` 并保存页面截图、DOM 和 Accessibility tree。向导消失且主界面输入框可见后，用系统 `open -a` 重新发送 `codex://threads/<id>?hostId=local`，断言原 thread 的 seed 回复可见；初始深链接可能已被向导消费。

该发行版在向导后还可能显示 `Introducing GPT-6.1 Sol` 模型介绍弹窗。驱动仅在匹配该标题和公开按钮时，点击 `Continue with current model` 保留当前模型；不会选择 `Try GPT-6.1 Sol now`，未知对话框仍按失败处理。被弹窗遮挡的输入框不能作为向导结束条件。

官方发行版不是固定 DOM 合同。发行版禁用 CDP、出现登录页或控件发生变化时，测试失败并保留证据；不能改成通信模块验收后宣布 GUI 通过。需要真实账号或 macOS 权限时，以失败截图和界面文本指出具体缺项，不自动打开登录浏览器、导入用户凭据或修改 TCC 数据库。若改用 Accessibility 驱动，需在专用测试 Mac 上给实际驱动进程授予辅助功能权限，再保留真实点击证据。

## 覆盖的用户故事

| 场景 | 必须观察到的结果 |
| --- | --- |
| backend 先启动，准备 Bridge 的进程退出 | launchd 仍持有同一 backend；再次准备不创建第二个服务 |
| 隔离 profile 的首次向导 | 真实点击完成必填角色并跳过可选设置；重新打开原 thread 后可见 seed 回复 |
| Desktop 打开共享 thread | 官方 App 的窗口显示 Bridge 预先生成的回复 |
| Bridge 提交新消息 | 同一 GUI 窗口出现新回复，不要求 TUI 存在 |
| Desktop 输入框发送 | 模型只收到一次新请求；Bridge 在原 thread 收到用户消息和助手回复 |
| GUI 点击命令审批 | Bridge 先收到真实待审批请求；GUI 点 `Allow once` 后只运行受控 `printf`，Bridge 旧请求失效，GUI 显示完成 |
| GUI 回答问题 | Plan 模式调用真实 `request_user_input`；单题 GUI 点击 `GUI_BLUE` 即提交，本次请求的实际工具结果严格匹配该答案，Bridge 旧请求失效 |
| Desktop 退出重开 | backend PID 不变；原 thread 历史和后续 Bridge 回复可见 |
| 保存的 LaunchAgent 重新加载后再开 Desktop | 不运行 Bridge prepare，新的 backend 恢复环境；真实 GUI 恢复原 thread |
| 重载后继续对话 | GUI 发送新的 `DESKTOP_RESTORED_GUI_INPUT` 并显示回复；默认连接在原 thread 观察同一 turn 的唯一输入、回复和成功终态，模型请求只增加一次 |
| Desktop 先开，后启动服务，再重开 Desktop | 记录启动时环境为空；服务启动后重开 GUI 恢复原 thread，再发送新的 `DESKTOP_LATE_SERVICE_GUI_INPUT`，通过相同的唯一回合断言。尚未证明不重开也可恢复 |
| 显式关闭共享配置 | LaunchAgent 与环境被清除；原版 Desktop 再次独立启动、恢复原 thread 并经输入框完成新的收发 |

`result.json` 的 `fullDesktopGuiTested` 只在双向 GUI 收发通过后置真；审批、问答分别记录 `guiApprovalTested`、`guiQuestionTested`。任一后续场景失败，整体 `success=false`，不得仅看某一个已通过的布尔值。`disabledDesktopDefaultGui` 只有在关闭共享配置后，真实 App 独立打开原 thread 并完成新一轮 GUI 收发才置真。

两个恢复场景也必须完成新 GUI 回合，才设置原有恢复成功标记。`backendRestartGuiTurn` 与 `lateServiceGuiTurn` 保存对应 thread/turn ID、精确输入与回复、模型请求索引和数量；旧历史、不同 thread 或 turn、重复输入/回复、缺少完成事件和失败终态都不能通过。驱动输入文字后等待真实 `Send` 按钮可用，再点击一次；输入框可见不代表线程已完成恢复。每个新回合分别保存 `restored-gui-sent-and-received.*`、`late-service-gui-sent-and-received.*`。

`37144640293` 的两个恢复回合都发生在原 thread `01a1030c-5bdc-77f3-a0d7-655dc2335b0e`。每个回合均恰好一次 CDP 输入、一次模型请求、一个原生用户完成项、一个助手完成项和一个无错误的成功终态：

| 场景 | 实际 turn ID | 模型请求索引（从 0 开始） | artifact 中的截图 |
| --- | --- | --- | --- |
| 03 服务重载后新 GUI 回合 | `01a1030e-10c4-7a52-9256-2c3ba65fe2d4` | `8` | `03-persisted-service-before-desktop/restored-gui-sent-and-received.png` |
| 05 晚服务启动、重开后新 GUI 回合 | `01a1030f-140f-72e0-9eb6-e605b7e23388` | `9` | `05-reopen-after-late-service/late-service-gui-sent-and-received.png` |

同一 artifact 的 `result.json`、`protocol.jsonl`、`model-requests.json` 和各场景 `cdp.jsonl` 可交叉核对上述记录。`06-disabled-default-desktop/default-gui-after-disable.png` 同时显示最新晚服务回复、`DESKTOP_DEFAULT_GUI_INPUT` 和 `DESKTOP_DEFAULT_GUI_REPLY`，默认 stdio 新回合为模型请求索引 `10`。六次启动都通过官方二进制 PID 与 CoreGraphics 实窗检查，App 前后签名校验通过且 `app.asar` 摘要不变。

## 完整 App 首次验收暴露的连接地址问题

CI `37139317117`（`f5bda77`）已实际打开官方 `26.930.31730` 的窗口，但截图显示 `ChatGPT failed to start` 和 `connect ECONNREFUSED 127.0.0.1:1080`。App 自己的 stderr 同时记录 WebSocket 建连失败；随后原生对话框阻塞了 `Runtime.enable`、截图所需的 `Runtime.evaluate` 和 `Browser.close`。因此不能把首次失败只归因于 CDP 超时，也不能认为窗口打开就代表共享线程成功。

该版本完整 App 的 `O5 → sqe` 会用 URL 的 hostname 判断是否为本机；`ws+unix:///…` 的 hostname 为空，意外进入内置 SOCKS 路径。此前单独实例化通信模块 `E` 绕过了这层地址选择，不能覆盖完整 GUI 的行为。

生产修复使用 `ws+unix://localhost/…/app-server.sock:/`：ws 仍从 pathname 提取同一个 Unix socket，hostname 则命中完整 App 的本机分支。生产实现已兼容新旧 URL 的逆转换/本机校验及已安装服务脚本迁移。CI `37139666898`（`9f665ae`）中官方同版 App 已报告 `hostId=local` 连接成功，CDP 和 CoreGraphics 确认真实可见窗口，`transportErrors=[]`；前轮原生连接错误消失。

该轮在 `Which best describes your work?` 角色页等待 seed 回复失败，证明原验收器遗漏了首次向导。该轮尚未执行向导操作；当时只证实完整 App 的本机连接和窗口，未通过共享 thread 的 GUI 收发、审批、问答与重开故事。向导驱动单测仅验证操作选择和未知弹窗边界，不能代替这些 GUI 结果。

加入向导后的 `37140286597`（`be15652`）在进入向导操作前因 `swift -e` 窗口查询命令失败。可见 renderer、官方二进制和本机连接均正常；两次截图相隔约 42.5 秒，与原命令的 40 秒预算吻合，而前轮相同窗口检查约 29 秒完成。旧失败记录没有保存 signal/killed，因此只能判断时间线支持查询工具超时，不能声称已取得终止信号。查询已改为启动前一次编译的纯 C CoreGraphics 程序。`37140825456`（`073bc20`）中编译耗时 7008ms、原生窗口查询 335ms，原 onscreen/PID/layer/尺寸断言全部通过。

该轮的下一处失败发生在向导点击前：读取 `document.body.innerText` 的单次 CDP 请求达到硬编码的 10 秒期限；失败取证立即重新读取同一页面，在约 147ms 内成功，截图仍为角色页。期间主 frame/context 保持不变；出现的 context 销毁属于新建的可视化 iframe，不能解释成主页面跳转。启动期停顿的 App 内部原因尚未确认。

驱动现在让 DOM 读取、Accessibility tree 和页面截图使用与 UI 等待相同的 45 秒预算，保留原请求等待响应；输入与退出操作仍为 10 秒且从不重发。每条 CDP 响应记录耗时，超时和迟到响应也落盘，以便区分暂时无响应与持续失败。协议 mock 的虚拟时间回归验证 11 秒后回复仍可接受、45 秒无回复必须失败、输入超时不重放；该回归不代表真实向导已通过；后续真实 GUI 结果见下文。

`37141337674`（`38aa060`）已经真实执行上述五次向导点击并进入主界面，侧栏出现 `DESKTOP_GUI_SEED`；每次选中/取消状态和跳过确认都有截图、DOM 与 CDP Input 记录。该轮一个截图请求耗时 11678ms 后成功，未出现 CDP 超时。下一处失败是主界面的模型介绍弹窗不在原有识别范围，等待可操作页面超时。该轮尚未关闭模型介绍或打开共享 thread 正文，不能把侧栏标题或向导完成记为 GUI 收发通过。

`37141789810`（`a320083`）已完成模型介绍关闭和共享线程双向收发，`gui-sent-and-received.png` 同时显示 `BRIDGE_VISIBLE_IN_DESKTOP_GUI`、真实输入 `DESKTOP_GUI_INPUT` 和回复 `DESKTOP_GUI_REPLY`；Bridge 协议记录同一 thread 的用户/助手消息及 turn 完成，GUI 发送只增加一次模型请求。

该轮审批失败是配置不一致：通用 CLI fixture 写入 `approval_policy="never"`，但脚本只在 `thread/start` 指定 `on-request`。Desktop 发送时采用配置默认值，`thread/settings/updated` 明确将线程改为 `never`，随后真实 `exec_command` 返回 `approval policy is Never; reject command`。工具本身存在于 `body.tools`，不能用切换模型解释此失败。原生 verifier 的成功审批线程使用 `on-request`；因此修复是对齐 Desktop 独占配置，继续要求真实审批请求和 GUI 点击。Linux 真实 CLI `0.160.0` 已验证从修正后的配置读取 `on-request`、按该配置发送后再产生原生命令审批；该辅助检查明确 `guiTested=false`，本身不证明 GUI 审批已通过。

`37142369652`（`5139e90`）已通过修正配置后的真实 GUI 审批：`Allow once` 点击后受控命令输出正确、退出码为 0、Bridge 原审批失效。该轮真实 Plan 请求包含 `request_user_input`；点击单选项 `GUI_BLUE` 后，原生 `serverRequest/resolved`、匹配本次 `itemId/call_id` 的答案 `{"answers":{"desktop_color":{"answers":["GUI_BLUE"]}}}` 和同一 turn 的完成事件均已出现。实际 Accessibility tree 没有 `Submit` 按钮；脚本等它 45 秒才失败。现已移除这一步，保留真实点击、请求失效、turn 完成和精确答案断言，继续执行尚未运行的重开故事。

`37142941126`（`25d110b`）中，问答完整断言通过；Desktop 退出重开后，backend PID 仍为 `5367`，新窗口显示原问答以及新的 Bridge 回复 `DESKTOP_REOPEN_SHARED_REPLY`。随后重新加载保存的 LaunchAgent，backend PID 变为 `6930`，原版 Desktop 新 PID `6939` 的窗口显示同一 thread 历史，App 日志也记录自身 `thread/resume` 在 `13179ms` 后成功。

该轮失败来自验收脚本继续使用 `connect(endpoint, 500)` 返回的就绪探测连接执行 Bridge `thread/resume`；此参数同时控制后续每次 RPC，而非仅控制握手。原生日志中该请求从 `18:09:17.266858Z` 处理到 `18:09:23.000026Z`，已超过 500ms 及当时普通连接默认的 5 秒。脚本现在关闭短探测连接，再用普通 `connect(endpoint)` 的产品默认连接保留原恢复断言，记录 `backend-resume-start/complete/failed` 和耗时，不重发 `thread/resume`。协议回归要求产品默认连接接受六秒响应、30 秒持续无响应仍失败；这不替代真实 GUI 验收。该轮没有晚启动服务或关闭共享配置后的 GUI 结果。

生产预算核对：该轮 `app-server-registry.ts` 和 `app-server-lifecycle.ts` 的连接均使用客户端默认 5000ms，`resume` 未单独指定期限；超时会丢弃该请求后来的响应。上述 5.73 秒服务端处理跨度超过当时产品默认预算，存在冷恢复时误判超时的实际风险；13.18 秒是官方 Desktop 自身请求的成功耗时，不能当成生产 Bridge 已失败的记录。该轮没有用默认 5 秒生产连接复现该故障，不能据此断言所有恢复都会失败。主线提交 `33d18c2` 分离默认握手 5 秒与请求 30 秒，并保留显式数字调用的兼容行为。GUI 夹具关闭显式 500ms 探测连接后使用普通默认连接，不设置验收专用期限，后续直接验证产品参数。生产变更由主线提交，本 GUI 修改不包含客户端代码。

`37143837340` 首次全绿：`startup-sequence.jsonl` 记录 backend 从 PID `3555` 重载为 `4605`，默认连接 resume 成功耗时 `6607ms`；`03-persisted-service-before-desktop/app-stdout.log` 记录官方 GUI resume 成功耗时 `16134ms`，线程均为 `01a10301-1265-73f2-a25e-897a46ef7e28`。这直接验证了超过旧 5 秒的恢复请求可在新产品预算内完成，但该轮 03 还没有新的 GUI 回合。

该轮 04 在空 launchd 地址下实际选择 `stdio`；服务 PID `5622` 后启动，05 重开选择 `websocket`，`thread/read` 在 `1816ms` 后成功并显示旧历史。然而 05 截图仍在恢复中，没有 `thread/resume` 成功记录便被脚本关闭，不能把读取历史写成“已经恢复完整对话”。因此追加上述两处 GUI 新回合门槛；这是验收覆盖缺口，尚无产品失败证据。06 则已有完整新回合：共享服务和环境清除后，官方 PID `5942` 使用 `stdio`，发送 `DESKTOP_DEFAULT_GUI_INPUT`、显示 `DESKTOP_DEFAULT_GUI_REPLY`，模型只增加一次请求，launchd 回读确认服务不存在。其补充 OS 全屏截图失败已记录；CDP 截图和 CoreGraphics 原版 PID/实窗断言通过，App 前后签名检查及 asar 摘要也保持一致。

强化后的 `37144640293` 通过了两处真实 GUI 新回合，关闭了这项验收缺口。本轮普通默认连接的 Bridge resume 在 `21182ms` 后成功；03 与 05 官方 GUI 自身 resume 分别耗时 `21075ms`、`20587ms`，之后均实际发送并收到新的回复。生产请求使用默认 30 秒预算，GUI 未另设恢复 RPC 特例。04/05/06 的原 App 日志分别确认 `stdio`、`websocket`、`stdio`，但这个受控重开顺序仍不能证明 OS 登录竞态已解决。

后续失败报告同时保存 `desktopConnectionUrl`、`desktopConnectionHostname` 和来自本次 App stderr 的 `desktopStartupDiagnostics.transportErrors`。CDP 不可用时，先结合这些字段和 `failure-macos-display.png` 检查原生对话框。

## 实际 OS 登录尚未由 hosted CI 验证

`actualOsLoginTested` 固定为 `false`。当前脚本记录 `who`、控制台用户、系统版本、GUI launchd 域摘要及启动事件时间，测试动作没有注销、重新登录或创建新的登录会话。`bootout/bootstrap` 只在当前会话重载自己的服务。

生产服务脚本在启动时运行 `launchctl setenv CODEX_APP_SERVER_WS_URL …`，plist 的 `RunAtLoad` 和 `KeepAlive` 负责启动/保活，未声明相对于 Desktop 登录项的顺序。Desktop 在变量设置前先启动，就可能继续走默认 stdio 后端。脚本中的“先开 Desktop，再启动服务，然后重开”验证已知恢复路径，不能证明登录竞态已解决，也不能证明两个登录项天然有序。

发行包 `26.930.31730` 的源码把两种“Desktop 先启动”分开处理：

- 启动时已有 `CODEX_APP_SERVER_WS_URL`，只有 socket 尚未可用：Desktop 构造 WebSocket transport，重连仍使用同一地址。这条路径具备等待后端的机制，但需要真实 GUI 验证。
- 启动时没有地址：本机 host 固定为 `{id:"local", display_name:"Local", kind:"local"}`，没有持久的 `websocket_url` 字段；Desktop 选择 stdio transport。后续 `launchctl setenv` 不会更新已经运行的进程环境，WebSocket 重连逻辑也不会替它重新选择 transport。原版源码中尚未发现可用的运行中切换入口。

对应源码在发行包 `.vite/build/application-network-startup-*.js` 的 `Jo`（选择地址）、`qo`（连接固定 WebSocket 地址）和 stdio `supportsReconnect`；`.vite/build/main-*.js` 的 `E5/O5` 构造 transport；`startup-requirements-*.js` 的 `Jr` 定义本机 host。标识仅用于该发行版取证，不是稳定 API。

启动阶段还有一个候选入口：`startup-requirements` 的 `oa → Bi → Hi` 会先以 `-ilc` 加载用户 shell 环境，再执行 `Object.assign(process.env, userEnv)`。因此，受管理的 shell 启动配置有可能在 Finder 打开 App 时提供持久的连接地址。但它只有约 5 秒加载预算，且首次应用网络策略读取有独立的有限重试/原生错误对话框；不能仅凭后续 WebSocket 会重连就断言服务晚启动一定无感恢复。这个方案会涉及用户 shell 配置，当前没有修改或验证，需单独权衡侵入范围并做真实 GUI 冷启动测试。

生产方案建议由主 agent 决定：提供由 CodeLark 管理的启动入口，先准备共享服务，再以 `open --env CODEX_APP_SERVER_WS_URL=…` 启动原版 App，建立明确的启动顺序。对于已经按 stdio 启动的 Desktop，继续提示用户退出重开；不要擅自终止用户 App。单独增加 launchd 重试或改启动优先级不能保证任意 Finder/系统登录项的顺序；修改原版 App 的 `Info.plist` 也会触及签名，不能作为保持原版的解决方式。当前交付不改生产行为。

GitHub hosted macOS job 开始时已拥有可用 GUI 域，但 workflow 没有登录凭据、重连登录会话的控制通道或会话外监督器。直接注销可能终止 runner 及同会话 mock；job 断开并不构成“下一次登录正常”的证据。这里没有尝试注销，不能把上述风险写成“实测 GitHub 禁止重新登录”。

实际登录验收的可执行路径是专用 Mac/持久 VM：

1. 使用独立测试用户安装同版签名 App 和 CLI。将隔离 mock、代码和证据放到不会随重启消失的目录，例如 `/Users/Shared/codelark-desktop-login-acceptance/`。由另一个管理员/SSH 会话或 LaunchDaemon 运行并监督 mock，监听本机地址；不要依赖即将注销的交互终端。
2. 在测试用户会话内，以固定 `CODEX_HOME` 和 mock provider 配置准备共享服务，创建 seed thread，记录 thread ID、服务 plist、Desktop 启动参数、`who` 和 GUI 域 session 信息。当前 CI 脚本结束会清理，不能直接拿一次运行替代这一持久准备步骤。
3. 分别测试“只有共享服务为登录项，用户随后打开 Desktop”和“Desktop 与服务同时为登录项”。同时启动这一组不能加人为等待来让服务抢先；多次登录记录真实顺序。Desktop 登录项需启动原 App，并保持同一隔离用户目录。
4. 在会话外监督器已能持续写日志、且测试用户有可用登录方式后，由控制台真正注销并重新登录。保存登录前后会话标识、launchd 服务启动日志、首次 Desktop PID/窗口及线程证据；不能只记录一个新的 backend PID。
5. 登录后不先运行 Bridge、不手工 `setenv`，在 Desktop 打开原 thread 并双向收发；记录首次启动是否成功、是否需要退出重开。再测试 Bridge 晚启动后是否复用同一服务。全部证据来自新登录会话才可改写实际登录结论。

实际登录仍未测试；GUI 各故事以完整 artifact 为准。独立分支提交不会自行触发 CI，也不涉及飞书测试账号。
