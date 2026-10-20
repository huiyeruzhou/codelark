# Claude 同目录会话绑定回归

这条回归验证两个群共用工作目录时，输出监听必须绑定到各自 Claude 进程的会话，不能选择目录中最近更新的 JSONL。

CI 还在 Linux、macOS 和 Windows 上运行 Claude 原生 tmux 及工作流回归。模拟进程必须从实际启动命令读取会话 UUID，兼容 Windows 的 argv 数组及 PowerShell 引号；无法读取时立即让夹具失败，不能沿用预设 UUID 写入模拟日志。

入口是 `scripts/real-feishu-claude-binding.ts`。它通过产品 `/new` 用例创建两个真实飞书群，把已授权用户加入群；后续输入全部使用用户身份发送，经飞书 WebSocket 进入隔离 daemon，由真实 Claude CLI/tmux 处理。模型 HTTP 服务使用本地确定性响应，回复由 Bridge 自动投递，测试以用户身份逐条读取 `user_card_content`。

## 同一测试必须能区分旧版与修复版

先让 IFNAR2 群完成首轮，再向 TNFA 群发送首条消息。为了稳定命中“邻居日志更新更晚”的竞态，测试只把 IFNAR2 真实 JSONL 的修改时间保持领先两秒，直到 TNFA 完成绑定；不修改日志内容、会话 ID、飞书输入或输出。

- 旧版的有效负例：两个不同 tmux/Bridge session 保存相同 Claude ID，并且在 TNFA 群用户读回中出现 `ANSWER_IFNAR2_...`。脚本随后在会话 ID 断言处退出 1。授权失败、建群失败、启动失败或超时都不算复现。
- 修复版：相同条件下保持两个不同 Claude ID，两群分别收到自己的回答；随后并发追问，两次会话 ID 均不变。四次回复必须完成用户读回，两个群都不能包含邻群回答，原生 JSONL 总数必须为 2。

## 运行

使用 Node.js 24，安装真实 `claude`、`tmux`。测试需要独立 CodeLark home 中配置好的测试 App，以及同一 App 的 lark-cli 用户 profile；用户授权需要 IM 建群、发消息、读消息及删除群权限。测试 App 不能同时被其他 Bridge 或 CI 使用。

```bash
unset NODE_OPTIONS
source ~/.nvm/nvm.sh
nvm use 24

CODELARK_REAL_FEISHU_E2E=1 node --import tsx scripts/real-feishu-claude-binding.ts \
  --test-home ~/.codelark-test \
  --profile codelark-test \
  --daemon /path/to/old-checkout/dist/daemon.mjs \
  --label baseline \
  --output-dir work/claude-binding-baseline

CODELARK_REAL_FEISHU_E2E=1 node --import tsx scripts/real-feishu-claude-binding.ts \
  --test-home ~/.codelark-test \
  --profile codelark-test \
  --daemon dist/daemon.mjs \
  --label fixed \
  --output-dir work/claude-binding-fixed
```

旧 daemon 应从修复前的 commit 独立构建，不要在生产安装中回滚文件。两次运行必须串行。负例不能只检查退出码，应同时检查 `report.json` 的 `crossGroupOutput=true`、重复 `bindings[].claudeSessionId`、不同 `tmuxSession` 和 `readback-TNFA.json` 中的实际错误回复。正例应为 `passed=true`，并检查四条 `readbacks` 和清理结果。

脚本使用独立 HOME、CODELARK_HOME、工作目录和 tmux socket，并关闭测试进程内的 Codex app-server/Desktop 自动接入，以限定为 Claude tmux 回归。它不会验证 Codex/Claude 自动选路、云端模型质量或 Desktop GUI。

## 证据与清理

输出目录包含输入 API 请求、用户读回、两个群的绑定、daemon 指纹、原生 CLI 版本和最终报告；原生日志与隔离配置保存在报告的 `root`。隔离配置含测试 App 凭据，不能提交或公开。不要将 API 报告当作 GUI 视觉验收截图。

脚本结束时停止自己启动的 daemon，只在验证过的隔离 socket 上按实际绑定名删除 tmux 会话，并删除本轮创建的群。建群请求超时时，会按本轮随机标记、完整群名和当前用户 owner 查找遗漏的已创建群。删除失败使正例失败，报告保留群 ID 供后续清理；不会扫描删除其他任务群。

2026-10-20 的真实对照中，旧版 `b77c490` 的 TNFA 输入写入独立 JSONL，但两个群镜像同一 IFNAR2 输出，身份断言失败；修复版 `6ba57a8` 完成两群四次用户回读，保持独立身份。该证据使用上述修改时间故障注入，不代表未经控制的线上竞态发生频率。
