# Web 工作台

Web 工作台是 CodeLark 的本地管理面。它不复制 IM 聊天，也不直接绕过 Bridge 修改底层 runtime 文件；它负责让用户看清服务、会话、通道、配置和故障状态，并通过共享应用层执行管理动作。

## 当前能力差距

以下矩阵以当前 `main` 源码为准。“完整”表示前后端语义和测试已经接通；“部分”表示有入口但缺少关键状态或操作；“缺失”表示网页没有对应管理能力。

| 领域 | 当前网页 | 结论 | 主要缺口 |
| --- | --- | --- | --- |
| Bridge / UI 服务 | 启动、停止、重启、刷新状态；读取开机自启动状态 | 部分 | 没有长操作进度、失败阶段、更新状态和可执行的自启动管理 |
| Runtime | 配置 Codex、Claude Code、Kimi Code、Cursor 默认值 | 部分 | 看不到当前活动 turn、provider 进程、tmux 状态、最近错误和 reconnect 状态 |
| Session | 四种 runtime 的本地发现、materialize、历史、重命名、可继承配置、绑定和归档 | 接近完整 | 大量 session 缺少搜索/过滤；运行中操作的风险提示不足 |
| 全局配置 | 覆盖 runtime、tmux 默认值、Bridge 和 Web 访问配置 | 接近完整 | 单页过长；缺少配置来源/继承说明；保存反馈不能清楚指出需重启项 |
| 通道与绑定 | 飞书多实例 CRUD、凭据检查、连接测试、聊天绑定和默认目标 | 完整 | 编辑器与列表信息密度和移动端布局仍需整理 |
| 日志与诊断 | 读取 bridge 最后若干行日志 | 部分 | 没有 level/event/bridge/chat 过滤、搜索、暂停、结构化详情和诊断入口 |
| 更新 | 侧边栏显示当前版本 | 缺失 | 没有 latest/ignored/checking/updating/restart-required 状态和升级进度 |
| 自动化 | 命令说明列出 `/every`、`/then` | 缺失 | 看不到已有计划和 pending follow-up；网页是否允许写入尚未接共享 use case |
| 命令说明 | 手写静态命令页面 | 部分 | 与 `/h` 双写，新增命令容易漂移；没有搜索和按任务过滤 |
| 可访问性 | 基础 label、按钮 title、部分 aria-live | 部分 | modal 无完整焦点管理，状态对比度/键盘路径未形成测试，窄屏导航仍像桌面缩放 |

“网页没有某个 IM 命令”不等于缺陷。普通 prompt、文件发送、tmux 按键等聊天动作继续留在 IM；网页应展示其状态和诊断证据。只有当管理动作已经有共享 use case 时，网页才提供写入口，不能直接写 JSON/TOML 模拟命令。

## 现有结构问题

`src/operator-ui/shell.ts` 同时包含全部页面 HTML、全局状态、DOM renderer、API client、事件绑定和轮询；`src/operator-ui/assets.ts` 同时包含登录页与工作台全部 CSS。功能继续增加时，任何小改动都要跨一个数千行模板字符串，命令说明和配置控件也只能手工同步。

重构按页面工作流聚合，不按按钮拆文件：

- `shell.ts`：文档骨架、导航和页面装配；
- `overview-view.ts`：服务拓扑、版本、健康和更新；
- `session-view.ts`：session ledger、历史、绑定和 session 配置；
- `config-view.ts`：通用配置与四个 runtime 分栏；
- `channel-view.ts`：通道实例、凭据测试和绑定；
- `log-view.ts`：结构化日志、过滤和诊断；
- `ui-api.ts`：唯一 fetch wrapper、错误模型和 payload 类型。

文件边界以“修改一个用户故事时只需进入一个功能包”为准。禁止把每个 modal、按钮或 SVG 拆成独立文件，也不引入只转发一次的 facade。

## 信息架构

一级导航按用户任务组织：

1. **运行**：Bridge/UI/通道/runtime 路径、版本、健康和需要处理的异常；
2. **会话**：所有 BridgeSession 和本地 runtime session；
3. **通道**：飞书实例、聊天绑定和默认目标；
4. **设置**：通用、Codex、Claude、Kimi、Cursor、Web 访问；
5. **日志**：结构化筛选、原始详情和诊断；
6. **命令**：由共享命令目录生成的可搜索参考。

设置页中的“通用”只出现一次，顺序固定为默认工作目录、tmux 截屏行数、tmux 输入回显；`tmuxAutoEnter` 不提供用户配置入口。Runtime 分栏只展示自己的 provider/model/mode/reasoning 等字段，不复制通用配置。

通道的历史条数、响应计时显示延迟和运行状态刷新间隔属于单个通道实例，不属于全局 Bridge 表单。它们只在通道编辑器中保存；全局配置保存必须原样保留所有通道。Session 中可继承的布尔项使用“跟随全局 / 启用 / 关闭”三态控件，选择“跟随全局”会删除 session override，而不是把当前有效值固化到 session。

## 视觉方向

使用克制的工程控制面，而不是营销 dashboard：

- 场景：开发者在桌面端把工作台放在终端旁边，快速判断“消息从哪个通道进入、Bridge 是否工作、哪个 runtime/session 正在运行、错误在哪一层”；
- 色彩：`#F6F7F9` 页面、`#FFFFFF` 内容、`#182230` 主文字、`#667085` 次文字、`#D0D5DD` 分隔、`#3370FF` 选择/主操作；runtime 色只用于小型身份标记；
- 字体：系统 sans 负责界面，`ui-monospace` 只用于 ID、路径、命令和日志；使用固定字号阶梯，不使用流式大标题；
- 形状：8–12px 圆角、单层 surface、清晰分隔；取消 glass blur、渐变文字、宽阴影、侧边彩条和嵌套卡片；
- 动效：150–200ms，只表达展开、保存、刷新和状态切换；支持 `prefers-reduced-motion`。

工作台的识别元素是“Bridge 路径条”，它编码真实拓扑而不是装饰指标：

```text
┌──────────┐   ┌──────────────┐   ┌────────────┐   ┌────────────────────┐
│ Web UI   │ → │ Bridge daemon│ → │ Feishu × N │ → │ Active sessions × N│
│ running  │   │ pid / uptime │   │ connected  │   │ Codex · Kimi · …   │
└──────────┘   └──────────────┘   └────────────┘   └────────────────────┘
```

这取代当前三个孤立的大数字卡。其余页面保持安静，让 session、配置和日志本身成为主内容。

## 测试合同

一个热点用户故事覆盖核心管理生命周期：用户打开工作台，看到真实服务状态和四 runtime session；筛选并打开一条会话，修改可继承配置，保存后刷新仍保持正确来源；切到通道并绑定该会话；最后在日志页按 bridge/session 过滤到对应事件。测试分层如下：

- 纯函数/DOM 合同：导航、过滤、空态、三态继承、错误文案和响应式结构；
- route/application：配置校验、session materialize/归档、binding/default target、日志过滤和服务状态；
- 本地浏览器故事：真实启动 UI server，操作关键页面并校验 API 与持久化状态；
- 视觉门禁：桌面与窄屏截图、键盘焦点、loading/empty/error/disabled 状态、reduced motion。

不能用“HTML 字符串包含某个 id”替代用户故事，也不能只凭 API `200` 证明页面交互正确。

## 源码入口

- UI server：`src/operator-ui/server.ts`
- 当前页面 shell：`src/operator-ui/shell.ts`
- 样式：`src/operator-ui/assets.ts`
- Session 应用层：`src/operator-ui/application/session.ts`
- Config 应用层：`src/operator-ui/application/config.ts`
- Channel 应用层：`src/operator-ui/application/channel.ts`
- HTTP routes：`src/operator-ui/routes/`
