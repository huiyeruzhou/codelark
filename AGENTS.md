# AGENTS.md — CodeLark 项目协作准则

git 不要提交 `STATUS.md`

## 用户链接格式

- 向用户提供 URL 时，必须使用 Markdown 超链接（例如 `[打开授权页面](https://example.com)`）或独立代码块；不要直接发送裸 URL，以免当前聊天客户端无法点击或错误解析。

## 开发工作流
- 本仓库的 Node.js 开发命令使用 Node.js 24。
- 运行 `npm run build`、`npm test`、`npm run typecheck` 或其他 Node 命令前，除非当前 shell 已经是 Node.js 24，否则先运行 `nvm use 24`。
- 由于环境可能带有普通 Node 不接受的 `NODE_OPTIONS`，必要时使用 `unset NODE_OPTIONS; source ~/.nvm/nvm.sh && nvm use 24 && ...`。
- 除非用户明确要求，不要 push commit，不要 hot update 或 redeploy 本地 bridge。
- 工作完成后，代码变更仍应提交到本地 git；同一功能阶段的 follow-up 应 amend 到同一个 commit，并且询问用户是否要merge回主分支。

### 动作要落盘

- 改动代码时使用 worktree，不要直接修改主分支，除非用户明确要求。轻量开发可以使用符号链接将 `node_modules` 指向 worktree 的 `node_modules`，如果这样不 work 就手动 `npm install`。
- 每当有新的认识、理解、计划、依赖事实、审计结果、测试结果或用户纠偏，必须立即写入新worktree的 `STATUS.md`。
- 状态文件必须包含：
  - h2-任务目标：原始指令：任务开始时的目标，不能改变。 用户修改后，追加修改。
  - h2-任务日志：这里存储每个阶段的计划、执行、审计信息
    - h3-阶段条目：阶段描述 + 带有精确到分钟级别的时间戳，阶段是一个相对大一点的模块化的任务，需要若干个行动来完成，是一个自包含的原子任务。每个阶段应该对应一个git提交。
      - ul-若干行动条目：对当前思考了什么、做了什么、得到什么结论的一个描述，完成几次任务调用之后就可以更新一条行动条目。
      - ul-阶段验证和git提交
  如果说当前阶段被用户中断了，就直接在行动条目里记录下中断，然后再规划下一个阶段。

- 逐步修改、逐步测试。每个动作完成代码修改后，确认已经同步 `STATUS.md` 和相关项目文档。
- 代码从一个稳定状态收敛到另一个稳定状态后，并且在开发中特别是经历了多个non-trival修改后，就形成一个阶段。
- 每个阶段完成后要提交到本地 git，如果远程没有相关修改，就考虑用 `git commit --amend`，不要堆叠无意义的 incremental fix commits。只有无关变更才单独提交。另外STATUS.md文件本身的修改不用单独提交·
- 不要把“我打算做什么”只留在对话里；长期任务的关键上下文必须落盘。
- 每当一个阶段改完，必须执行阶段审计：
  - 功能开发：运行相关测试，并尽量假设一个端到端使用场景验证，更新相应的功能文档。
  - 文档编写：检查内容是否全面、准确、没有旧术语误导。
  - 代码重构：检查重构是否干净、彻底，是否消除了目标耦合，而不是只移动文件。
- 然后继续考虑下一个工作点

## 飞书云文档创建 SOP

当用户要求“整理一个云文档”“发到飞书云文档”或明确要求创建 Lark/飞书文档时，按下面流程执行：

1. 先把要写入云文档的内容落成本地 Markdown 文件，优先放在当前任务的 `work/<goalname>/` 目录；同步更新 `STATUS.md`，记录文档目的、内容来源和输出路径。
2. 运行 `lark-cli` 前使用 Node.js 24：

   ```bash
   unset NODE_OPTIONS; source ~/.nvm/nvm.sh && nvm use 24
   ```

3. 检查 `lark-cli` 和登录状态：

   ```bash
   npx lark-cli --version
   npx lark-cli auth status
   ```

   如果 user 或 bot 身份不可用，先在回复或 `STATUS.md` 中明确说明需要登录/授权，不要假装已经创建云文档。

4. 用 Markdown 创建云文档。默认使用当前登录用户身份；如果任务明确要求机器人身份，再把 `--as user` 改为 `--as bot`：

   ```bash
   npx lark-cli docs +create --api-version v2 --as user --doc-format markdown --content @work/<goalname>/<file>.md
   ```

5. 从命令 JSON 输出中提取并记录：
   - `data.document.document_id`
   - `data.document.revision_id`
   - `data.document.url`
   - `data.warnings`

6. 创建后必须至少做一次读取验证：

   ```bash
   npx lark-cli docs +fetch --api-version v2 --as user --doc <document_id>
   ```

   验证返回 `ok=true`，并抽查标题或首段内容和本地 Markdown 一致。验证结果立即写入 `STATUS.md`。

7. 最终回复用户时必须直接给出云文档 URL。不要只说“已创建”或只发送本地附件；如果创建成功，结尾也要保留可点击/可复制的 URL。


## Hot Update 本地 Bridge

只有用户明确要求 hot update 或 redeploy 本地 CodeLark bridge 时才执行本节。

不要在前台运行 `codelark stop`。前台 stop 可能停止承载当前 Codex 会话的 bridge，导致命令自己中断。

操作步骤：

1. 确认当前工作目录是 `codelark` 项目根目录。
2. 只有用户明确要求 pull latest changes 时，才传 `--pull`；否则不要传。
3. 如果刚刚针对同一批本地改动完整跑过 `npm test` 且通过，可以传 `--skip-tests`，避免 detached hot update 重跑完整测试；否则不要传。
4. 从项目根目录派发 detached updater：

   ```bash
   bash scripts/hot-update-bridge.sh
   ```

   带 pull：

   ```bash
   bash scripts/hot-update-bridge.sh --pull
   ```

   刚跑完完整测试后跳过测试：

   ```bash
   bash scripts/hot-update-bridge.sh --skip-tests
   ```

5. 回复用户时必须说明：实际派发的命令、是否使用 `--pull`、是否跳过测试、hot update log 路径、bridge log 路径。

脚本负责使用 Node.js 24、检测 `--use-env-proxy`、运行 build/test（除非传 `--skip-tests`）、并从 detached worker 重启 bridge。默认 bridge log 路径是 `~/.codelark/logs/bridge.log`。
