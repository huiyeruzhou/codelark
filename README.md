# CodeLark

<p align="center">
  <img src="docs/assets/readme/codelark-logo.png" alt="CodeLark logo" width="280">
</p>

> 你的下一次Vibe Coding，何必从终端开始？以一流的 UI 界面和智能体协作，work ALL in 飞书。

- 代码仓库：https://github.com/huiyeruzhou/codelark
- 文档站：https://huiyeruzhou.github.io/site/codelark/

## 核心能力

| 能力 | 怎么用 | 入口 |
| --- | --- | --- |
| 共享本地 runtime 会话 | 在飞书上继续本地 Codex / Claude Code 对话，用可视化面板选择要接管的线程。 | `/t` |
| 流式卡片输出 | 将模型思考、工具调用、长任务进度和最终结果渲染成飞书卡片，对话留痕且可追踪。 | 普通消息 |
| 群聊 = Session | 一个群聊对应一个 session，用群聊名称管理任务；多线并行时一键拉起新群。 | `/new`、`/t rename <名称>` |
| 云文档驱动开发 | 模型可以生成云文档；在云文档评论中 `@bot` 在线对话，也可以 `@bot /new` 发起长线群聊任务，结束后再更新云文档。 | 云文档评论 |

## Showcase

> 更完整的产品功能、使用场景、设计模块和源码入口说明见 [CodeLark 产品文档](https://huiyeruzhou.github.io/site/codelark/product/)。


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
- 全局环境中已有 `codex` / `claude-code-router` / `claude-code` 其中之一，或当前系统用户已有对应登录态/API 凭据。

### 安装

> 如果你通过环境变量配置模型、代理或 API Key，需要在启动 `codelark` 前 export。

```bash
npx -y codelark@latest run
```

```bash
# export OPENAI_API_KEY=sk-xxx
npm install -g codelark
codelark run
```

`codelark run` 会在启动 bridge 前为当前 CodeLark 配置初始化专属 lark-cli 运行环境：把飞书/Lark App 配置投影到 `~/.codelark/runtime/lark-cli-source/config.json`，绑定到 `~/.codelark/runtime/lark-cli/`，并把 `LARK_CHANNEL_CONFIG` 与 `LARKSUITE_CLI_CONFIG_DIR` 注入 bridge/agent 进程。如果默认 lark-cli 配置里已有同 App 的用户授权，启动时会复制到专属目录并切换为 user-default。这样 bridge 内部和 agent 调用 `lark-cli` 时会使用 CodeLark 当前配置，而不是误读默认用户 HOME 下的其他 lark-cli 配置。

默认工作台地址是 `http://127.0.0.1:4781`，端口被占用时会自动切到可用端口。查看当前状态和地址：

```bash
codelark status
codelark url
```

`setup` 向导的主要工作是：

- 飞书鉴权：
  - 默认引导：使用 `lark-cli` 扫码创建或导入机器人配置。
  - 手动引导：直接粘贴飞书 `App ID` 和 `App Secret`。
- 配置：
  - 选择默认 runtime：优先使用 `~/.codex`；检测到 `~/.claude-code-router` 会推荐 Claude Code Router；都没有时默认 Claude Code。
  - 之后选择默认工作目录，默认是运行 `codelark setup` 时的当前目录。
  - 以上内容会保存到 `~/.codelark/config.json`，并更新 `config.env`。`config.json` 是系统实际使用的配置文件；`config.env` 方便人工配置，也可通过环境变量覆盖，系统启动时会用 env 覆盖 json。`codelark run` / `codelark start` 会再把当前配置绑定到 CodeLark 专属 lark-cli 运行目录。

- 安装 skills：安装向导会说明并默认勾选这些 skill，也可以逐个关闭或全部取消。手动安装可运行：

```bash
codelark install-skills
```

## 典型使用方式

### 1. 接管本地会话

在 Web 工作台里新增好飞书通道实例后，启动 bridge。
然后在 IM 中发送：

```text
/t
```

`/t` 默认显示最近 20 条本地 Codex / Claude Code 会话。需要更多时发送：

```text
/t all
```

查看最多 100 条本地 Codex / Claude Code 会话。
再通过：

```text
/t 1
```

切到对应线程。

### 2. 继续对话

绑定成功后，直接发送普通消息即可继续当前线程。

- Codex 的默认后端是 tmux，所以你可以发送 `<enter>` 或 `<C-c>`，CodeLark 会解释为控制键；卡权限时很有用。
- Codex CLI/Desktop 或 Claude Code 继续操作这条共享会话时，结果也会通过对应 JSONL mirror 同步到 IM。

> 也就是说，你可以回到电脑继续在 TUI 中和 Agent 协作，再回到飞书时依旧能看到完整对话记录。

### 3. 新建群聊任务

```text
/new
```

会发送创建表单，让你填写群聊名称和工作目录。表单会默认带出当前会话的工作目录；临时草稿线程也有自己的工作目录，可以直接作为默认目录。当前聊天还没有绑定会话时，会使用全局默认工作目录。

也可以用纯文本直接指定名称，或同时指定名称和目录：

```text
/new my-thread
/new my-thread ./my-project
/new my-thread D:\work\my-project
```

名称或路径包含空格时，请使用英文双引号 `"` 或英文单引号 `'`，例如 `/new "my thread" ./my-project`。

`/clear [名称] [路径]` 会在当前聊天上下文创建一个新的对话，并把当前聊天绑定过去；名称或路径包含空格时，请使用英文双引号 `"` 或英文单引号 `'`。之后可用 `/t` 重新附加到之前的对话。若当前 SDK 任务、共享镜像状态或 tmux TUI 追加输入仍显示运行中，会先询问是否终止旧对话；确认后再切换。群聊通道会同步重命名群聊，真实群名会自动带 `[botname]` 前缀。

## 常用命令

### 会话

- `/t`：查看最近 20 条本地 Codex / Claude Code 会话。
  - 表格标记：绿色表示当前聊天绑定；灰色表示其他聊天已绑定。
- `/t rename <名称>`：重命名当前线程；群聊通道会同步修改群聊名称，真实群名会自动带 `[botname]` 前缀。
- `/new`：发送创建表单，填写名称和工作目录后创建新的 IM 群聊会话。
- `/clear [名称] [路径]`：在当前聊天上下文创建新的对话并绑定过去，之后仍可用 `/t` 找回旧对话。

### 运行设置

- `/`：查看/配置当前聊天，包括模型、模式、思考级别、共享镜像状态。
- `/r <1-5>`：切换思考级别。
- `/mode <normal|yolo>`：切换运行模式，自动映射到 Codex 和 Claude Code 的对应模式。
- `/model <模型名>`：切换当前 IM 会话模型。
- `/require-at`：查看当前飞书通道的群聊 @bot 要求；`/require-at on|off` 可切换是否必须 @bot。
- `/set`：查看全局配置，然后用 `/set <key> <value>` 修改。

### 对话与诊断

- `//...`：向模型发送以 `/` 开头的文本，例如 `//status` 会作为 `/status` 发给模型。
  - 特别常用：`//goal`！
- `/tmux-screen`：诊断 Codex 的运行情况。
  - `<enter>`：向 Codex 对话发送回车。
  - `<C-c>`：向 Codex 对话发送终止。
- `/p tmux`：重启 Codex 会话。
- `/his [N]`：把当前线程最近消息渲染成卡片发送。
- `/his json`：直接发送原始 Codex / Claude Code session JSONL 文件，不做二次包装或后处理。
- `/stop`：停止当前任务；tmux Provider 中已有运行中 TUI turn 时会向 tmux 发送 `<C-c>`。

## 社区

| 微信 | 飞书 |
| --- | --- |
| <img src="docs/assets/community/wechat-qr.png" alt="微信群二维码" width="180"> | <img src="docs/assets/community/feishu-qr.png" alt="飞书群二维码" width="180"> |

## 致谢

深受以下项目的启发，并感谢作者们的开源
- codex-to-im
- lark-coding-agent-bridge
