# CodeLark

<p align="center">
  <img src="docs/assets/readme/codelark-logo.png" alt="CodeLark logo" width="280">
</p>

> 你的下一次Vibe Coding，何必从终端开始？以一流的 UI 界面和智能体协作，work ALL in 飞书。

- 代码仓库：https://github.com/huiyeruzhou/codelark
- 文档站：https://huiyeruzhou.github.io/site/codelark/
- 当前 npm 版本：`codelark@0.3.0`

## 核心能力

| 能力 | 怎么用 | 入口 |
| --- | --- | --- |
| 共享本地 runtime 会话 | 在飞书上继续本地 Codex / Claude Code / Kimi Code / Cursor Agent / ZCode 对话，用可视化面板选择要接管的线程。 | `/t` |
| 流式卡片输出 | 将模型思考、工具调用、长任务进度和最终结果渲染成飞书卡片，对话留痕且可追踪。 | 普通消息 |
| 群聊 = Session | 一个群聊对应一个 session，用群聊名称管理任务；多线并行时一键拉起新群。 | `/new`、`/t rename <名称>` |
| Multi-Agent 协作 | Agent 可以发现其他 CodeLark 群聊、创建专用任务群，并把普通输入或 slash 命令交给另一个 Agent；两端都会显示可核对的收发卡片。 | 自然语言委派、`codelark sessions` |
| 云文档驱动开发 | 模型可以生成云文档；在云文档评论中 `@bot` 会直接按文档创建长线群聊，后续评论转发到群内处理。 | 云文档评论 |

## Showcase

> 第一次使用请看 [5 分钟日常工作流](https://huiyeruzhou.github.io/site/codelark/guide/daily-workflow)；设计模块和源码入口见 [CodeLark 设计文档](https://huiyeruzhou.github.io/site/codelark/product/)。


<table>
  <tr>
    <td width="50%" align="center">
      <img src="docs/assets/readme/showcase-cloud-document-chat.png" alt="CodeLark 云文档评论入口与群聊协作" style="width: 100%; max-width: 420px;">
    </td>
    <td width="50%" align="center">
      <img src="docs/assets/readme/showcase-workbench-card.png" alt="CodeLark 飞书工作台与流式卡片" style="width: 100%; max-width: 420px;">
    </td>
  </tr>
  <tr>
    <td colspan="2" align="center">
      <img src="docs/assets/readme/showcase-session-management.jpg" alt="CodeLark 会话管理" style="width: 100%; max-width: 840px;">
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="docs/assets/readme/showcase-session-control.png" alt="CodeLark Session 控制面板" style="width: 100%; max-width: 420px;">
    </td>
    <td width="50%" align="center">
      <img src="docs/assets/readme/shocase-runtime-control.png" alt="CodeLark Runtime 控制面板" style="width: 100%; max-width: 420px;">
    </td>
  </tr>
</table>


## 快速开始

### 依赖

- Node.js 24+
- 全局环境中已有 `codex` / `claude-code-router` / `claude-code` / `kimi` 其中之一，或当前系统用户已有对应登录态/API 凭据。

### 安装

- CodeLark 默认使用 tmux 驱动本地 agent
  - macOS
  ```sh
  # 安装Homebrew
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # 安装 tmux
  brew install tmux
  ```
  - Linux
  ```sh
  sudo apt install tmux
  ```
  - Windows
  ```sh
  winget install psmux
  ```
  psmux 是原生 Windows tmux 兼容实现，会提供 `tmux.exe`，不需要 WSL。安装后请重新打开终端，并用 `tmux -V` 验证 PATH。

> 如果你通过环境变量配置模型、代理或 API Key，需要在启动 `codelark` 前 export。

```bash
npx -y codelark@latest run
```

```bash
# export OPENAI_API_KEY=sk-xxx
npm install -g codelark
codelark run
```

## v0.3.0

`0.3.0` 新增 Multi-Agent 协作：不同 CodeLark 群聊中的 Agent 可以按真实群名和 Bot 名发现彼此、创建专用任务群并传递普通输入或 slash 命令。源群和目标群都会显示包含路由与正文的收发卡片。这个版本还新增一次性条件监控、统一飞书消息与附件协议，并改进 Codex 非致命诊断、更新恢复和群头像缓存。

完整发布说明见 [Release Notes](docs/guide/release-notes.md)。

## 常用命令
- `/`：查看或修改当前群的会话配置。
- `/set`：修改全局默认配置；新建群会继承这些默认值。
- `//...`：向模型发送以 `/` 开头的文本，例如 `//status` 会作为 `/status` 发给模型。
  - 特别常用：`//goal`！
- `/tmux-screen`：显示本地 agent 的 TUI 界面，遇到卡住不动的问题排查用。
- `<enter>`、`<C-c>`、`<esc>`：向当前 tmux 会话发送控制键。
- `/p tmux`：当前本地 TUI 已退出时重新启动。
- `/runtime cursor`：切换到 Cursor Agent；原生 Cursor slash 命令使用 `/tmux /<command>`，例如 `/tmux /mcp list`。
- `/runtime zcode`：切换到 ZCode；普通消息进入受 CodeLark 管理的 ZCode tmux TUI，原生 slash 命令使用 `//`，例如 `//goal`。
- `/reasoning`：查看或修改当前 runtime 的思考设置；Codex 支持 `max/ultra`，Kimi 使用 `on/off`，Cursor 使用模型 effort；ZCode 保留自身原生命令，不由 CodeLark 硬映射。
- `/stop`：停止当前任务
- `/t`：查看最近本地 Codex / Claude Code / Kimi Code / Cursor Agent / ZCode 会话。
- `/t rename <名称>`：重命名当前线程；群聊通道会同步修改群聊名称，真实群名会自动带 `[botname]` 前缀。
- `/new`：发送创建表单，填写名称和工作目录后创建新的 IM 群聊会话。
- `/clear [名称] [路径]`：在当前聊天上下文创建新的对话并绑定过去，之后仍可用 `/t` 找回旧对话。
- `/every 10m <prompt>`：按固定间隔复用当前会话发送 prompt；`/every` 查看和取消。
- `/then <prompt>`：当前会话 completed/interrupted 后发送一次后续 prompt；`/then` 卡片可查看、新建、修改和取消。


## 典型使用方式

### 1. 接管本地会话

在 Web 工作台里新增好飞书通道实例后，启动 bridge。
然后在 IM 中发送：

```text
/t
```

### 2. 继续对话

绑定成功后，直接发送普通消息即可继续当前线程。

- tmux 会解释 `<enter>`、`<C-c>`、`<esc>` 等控制键；卡权限或需要中断时很有用。
- Codex CLI/Desktop、Claude Code、Kimi Code、Cursor Agent 或 ZCode 继续操作这条共享会话时，结果也会通过对应本地 transcript/SQLite mirror 同步到 IM。

> 也就是说，你可以回到电脑继续在 TUI 中和 Agent 协作，再回到飞书时依旧能看到完整对话记录。

### 3. 新建群聊任务

```text
/new
```

会发送创建表单，让你填写群聊名称和工作目录。表单会默认带出当前会话的工作目录也可以用纯文本直接指定名称，或同时指定名称和目录：

```text
/new my-thread
/new my-thread ./my-project
/new my-thread D:\work\my-project
```

名称或路径包含空格时，请使用英文双引号 `"` 或英文单引号 `'`，例如 `/new "my thread" ./my-project`。

`/clear [名称] [路径]` 会在当前聊天上下文创建一个新的对话，并把当前聊天绑定过去；名称或路径包含空格时，请使用英文双引号 `"` 或英文单引号 `'`。之后可用 `/t` 重新附加到之前的对话。若当前 SDK 任务、共享镜像状态或 tmux TUI 追加输入仍显示运行中，会先询问是否终止旧对话；确认后再切换。群聊通道会同步重命名群聊，真实群名会自动带 `[botname]` 前缀。



## 社区

| 微信 | 飞书 |
| --- | --- |
| <img src="docs/assets/community/wechat-qr.png" alt="微信群二维码" width="180"> | <img src="docs/assets/community/feishu-qr.png" alt="飞书群二维码" width="180"> |

## 致谢

深受以下项目的启发，并感谢作者们的开源
- codex-to-im
- lark-coding-agent-bridge
