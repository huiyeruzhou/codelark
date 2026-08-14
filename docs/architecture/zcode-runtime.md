# ZCode tmux runtime

ZCode 在 CodeLark 中是独立 runtime，当前唯一 provider 是 `zcode:tmux`。CodeLark 直接管理一个名为 `clk-zcode-<bridgeSessionId>` 的 tmux session，并在其中运行本机 `zcode` TUI；没有 app-server、自定义 server 或逐条 slash RPC 适配层。

## 用户合同

- `/runtime zcode` 创建或切回该聊天记住的独立 ZCode BridgeSession。
- 普通文本进入 ZCode TUI；多行输入由 tmux paste/Enter 协议提交。
- `//goal` 先由 CodeLark 现有转义规则去掉一个 `/`，随后把 `/goal` 原样交给 ZCode TUI。CodeLark 不需要知道 `/goal` 的语义。
- `/p tmux` 强制销毁同名 provider session，再以已保存的 `sess_*` 恢复；不是切到另一种 provider。
- `/stop` 中止当前受管 turn；`/clear`、归档和群生命周期清理只处理精确的 provider-owned tmux session。
- `/t zcode` 从本地 SQLite 列出会话，接管身份为稳定 `sess_* + canonical cwd`。

## 持久化与输出

ZCode runtime 支持 `ZCODE_SESSION_DB_PATH` 与 `ZCODE_STORAGE_DIR`。CodeLark 默认沿用 ZCode 自己的配置发现，只读打开 SQLite，不改账户配置。会话发现读取 `session`；普通回合从 `message`、`part`、`turn_usage` 和 `model_usage` 归一化出正文、thinking、工具、usage 及终态。

数据库使用 WAL。主 `sessions.sqlite` 在活跃 turn 中可能完全不变，真实写入只出现在 `sessions.sqlite-wal`。因此 SQLite snapshot 的 identity/size/mtime 聚合主库与 WAL，并监听父目录覆盖 WAL 创建、追加、checkpoint 删除；查询路径始终保持主数据库文件。每次变化只重建当前 `sess_*` 的 snapshot，再用稳定签名做 replacement 和去重，不能按 SQLite 文件 byte offset 当 JSONL 读取。

普通 prompt 由当前交互 turn 的 ZCode Provider 直接读取 SQLite snapshot，把正文、thinking、工具、usage 和终态写入同一张常规流式卡片；后台 mirror 对这条交互 turn 使用 suppression，避免重复发送。ZCode 原生 slash 命令通常不创建 SQLite turn，因此同一个 Provider 会等待 TUI 显示对应 prompt 和 `[✓|✗]` 终态，再把屏幕结果交给当前卡片。后台 mirror 只负责 Bridge 当前交互 turn 之外的本地会话变化与恢复同步。

fresh TUI 会在启动日志中先产生稳定 `sess_*`，但 ZCode 要到首条普通 prompt 才把 `session` 行写入 SQLite。后台 mirror 只有在该行真实存在后才订阅；启动阶段的临时缺行不等同于 dangling session，不能清掉 Bridge 已保存的 identity 或迫使首条消息重启 TUI。

## 失败与恢复

- ready 探测要求真实输入编辑区和 mode footer，不能把登录页、升级页或残留输出当 ready。
- 输入写入后必须观察编辑区已清空；未提交时会补 Enter，超时则明确报错并保留可诊断 tmux。
- 普通回合必须发现 session/turn identity，并以 `turn_usage` 的 completed/error 状态结束；正文停止增长不是终态。
- `model_usage.error_message` 优先作为用户可见错误，例如缺少 `zai` API key。
- Bridge 重启后通过保存的 `sess_*`、cwd 和 SQLite 重新建立后台同步；tmux 丢失时下一次 provider 启动恢复同一 session。

## 测试边界

单元测试覆盖 argv/env、ready/draft、原生 slash 屏幕结果、SQLite session/history/terminal 映射及 WAL 判变。工作流测试覆盖 runtime 切换复用、`/p tmux` 强制恢复、slash 屏幕结果、普通 SQLite 回合的直接卡片所有权和后台 mirror suppression。Operator UI 测试使用真实 SQLite fixture 覆盖 import/history/rename/archive。发布验收仍需使用已登录的真实 ZCode 和用户可见飞书测试群验证冷启动、普通回合、`//goal`、`/stop`、`/p tmux` 与 Bridge 重启恢复。
