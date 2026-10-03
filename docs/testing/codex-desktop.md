# macOS Desktop GUI 与登录顺序验收

`scripts/verify-codex-desktop-macos.ts` 在一次性 macOS 26 runner 上启动官方 `~/Applications/Codex.app`，真实 Codex CLI 连接本地 mock 模型。GUI 是验收对象，只有模型响应被替换。不修改或执行解包后的 Desktop 通信模块，不创建假的 `.app`，不调用 renderer 内部状态或发消息接口。

## 执行与判断

Node.js 24、`npm ci`、Codex CLI `0.160.0`、官方 App 和 Xcode Command Line Tools（使用 Swift 读取 CoreGraphics）安装完成后运行：

```bash
CODELARK_DESKTOP_CI=1 \
CODELARK_DESKTOP_CI_EVIDENCE=/tmp/codelark-desktop-gui-acceptance \
node --import tsx scripts/verify-codex-desktop-macos.ts
```

此命令只适用于一次性测试 macOS 用户。它要求没有既有 CodeLark Desktop LaunchAgent 或 Desktop 连接环境，创建自己的 backend 后在结束时禁用和清理。Desktop 使用独立 `CODEX_HOME` 和 Electron 用户目录，模型 key 是无效的 fixture 标记，模型请求只到本次 mock。不要在日常用户机器直接运行。

驱动通过 `/usr/bin/open -n -W` 启动 App，只传隔离目录与 Electron CDP 参数；不传 `CODEX_APP_SERVER_WS_URL`，该地址必须由 LaunchServices 从当前用户 launchd 环境继承。CDP 必须返回可见 renderer 和属于指定 App 的 Electron PID，macOS CoreGraphics 必须报告该 PID 的实际 onscreen 窗口。截图、DOM、Accessibility tree、CDP 操作日志、模型请求、Bridge 收到的协议、App 版本、签名检查和 `app.asar` SHA-256 一起保存。鼠标点击和键盘输入走 CDP Input 域，读取 DOM 只用于定位和断言。

官方发行版不是固定 DOM 合同。发行版禁用 CDP、出现登录页或控件发生变化时，测试失败并保留证据；不能改成通信模块验收后宣布 GUI 通过。需要真实账号或 macOS 权限时，以失败截图和界面文本指出具体缺项，不自动打开登录浏览器、导入用户凭据或修改 TCC 数据库。若改用 Accessibility 驱动，需在专用测试 Mac 上给实际驱动进程授予辅助功能权限，再保留真实点击证据。

## 覆盖的用户故事

| 场景 | 必须观察到的结果 |
| --- | --- |
| backend 先启动，准备 Bridge 的进程退出 | launchd 仍持有同一 backend；再次准备不创建第二个服务 |
| Desktop 打开共享 thread | 官方 App 的窗口显示 Bridge 预先生成的回复 |
| Bridge 提交新消息 | 同一 GUI 窗口出现新回复，不要求 TUI 存在 |
| Desktop 输入框发送 | 模型只收到一次新请求；Bridge 在原 thread 收到用户消息和助手回复 |
| GUI 点击命令审批 | Bridge 先收到真实待审批请求；GUI 点 `Allow once` 后只运行受控 `printf`，Bridge 旧请求失效，GUI 显示完成 |
| GUI 回答问题 | Plan 模式调用真实 `request_user_input`；GUI 选 `GUI_BLUE` 并提交，模型实际工具结果含该值，Bridge 旧请求失效 |
| Desktop 退出重开 | backend PID 不变；原 thread 历史和后续 Bridge 回复可见 |
| 保存的 LaunchAgent 重新加载后再开 Desktop | 不运行 Bridge prepare，新的 backend 恢复环境；真实 GUI 恢复原 thread |
| Desktop 先开，后启动服务，再重开 Desktop | 记录启动时环境为空；服务启动后重开 GUI 能恢复原 thread。尚未证明不重开也可恢复 |
| 显式关闭共享配置 | LaunchAgent 与环境被清除；原版 Desktop 再次独立启动、恢复原 thread 并经输入框完成新的收发 |

`result.json` 的 `fullDesktopGuiTested` 只在双向 GUI 收发通过后置真；审批、问答分别记录 `guiApprovalTested`、`guiQuestionTested`。任一后续场景失败，整体 `success=false`，不得仅看某一个已通过的布尔值。`disabledDesktopDefaultGui` 只有在关闭共享配置后，真实 App 独立打开原 thread 并完成新一轮 GUI 收发才置真。

## 实际 OS 登录尚未由 hosted CI 验证

`actualOsLoginTested` 固定为 `false`。当前脚本记录 `who`、控制台用户、系统版本、GUI launchd 域摘要及启动事件时间，测试动作没有注销、重新登录或创建新的登录会话。`bootout/bootstrap` 只在当前会话重载自己的服务。

生产服务脚本在启动时运行 `launchctl setenv CODEX_APP_SERVER_WS_URL …`，plist 的 `RunAtLoad` 和 `KeepAlive` 负责启动/保活，未声明相对于 Desktop 登录项的顺序。Desktop 在变量设置前先启动，就可能继续走默认 stdio 后端。脚本中的“先开 Desktop，再启动服务，然后重开”验证已知恢复路径，不能证明登录竞态已解决，也不能证明两个登录项天然有序。

GitHub hosted macOS job 开始时已拥有可用 GUI 域，但 workflow 没有登录凭据、重连登录会话的控制通道或会话外监督器。直接注销可能终止 runner 及同会话 mock；job 断开并不构成“下一次登录正常”的证据。这里没有尝试注销，不能把上述风险写成“实测 GitHub 禁止重新登录”。

实际登录验收的可执行路径是专用 Mac/持久 VM：

1. 使用独立测试用户安装同版签名 App 和 CLI。将隔离 mock、代码和证据放到不会随重启消失的目录，例如 `/Users/Shared/codelark-desktop-login-acceptance/`。由另一个管理员/SSH 会话或 LaunchDaemon 运行并监督 mock，监听本机地址；不要依赖即将注销的交互终端。
2. 在测试用户会话内，以固定 `CODEX_HOME` 和 mock provider 配置准备共享服务，创建 seed thread，记录 thread ID、服务 plist、Desktop 启动参数、`who` 和 GUI 域 session 信息。当前 CI 脚本结束会清理，不能直接拿一次运行替代这一持久准备步骤。
3. 分别测试“只有共享服务为登录项，用户随后打开 Desktop”和“Desktop 与服务同时为登录项”。同时启动这一组不能加人为等待来让服务抢先；多次登录记录真实顺序。Desktop 登录项需启动原 App，并保持同一隔离用户目录。
4. 在会话外监督器已能持续写日志、且测试用户有可用登录方式后，由控制台真正注销并重新登录。保存登录前后会话标识、launchd 服务启动日志、首次 Desktop PID/窗口及线程证据；不能只记录一个新的 backend PID。
5. 登录后不先运行 Bridge、不手工 `setenv`，在 Desktop 打开原 thread 并双向收发；记录首次启动是否成功、是否需要退出重开。再测试 Bridge 晚启动后是否复用同一服务。全部证据来自新登录会话才可改写实际登录结论。

当前交付只包含自动化与 Linux 静态/协议夹具检查；官方 macOS GUI 与实际登录结果以主 agent 后续整合运行的 artifact 为准。独立分支提交不会自行触发 CI，也不涉及飞书测试账号。
