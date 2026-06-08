# 架构与数据契约

本模块收纳 BridgeSession、ChannelChat、运行时边界、数据 schema、安全模型和后端状态相关文档。

## 阅读路径

1. [当前架构](current.md)：BridgeSession、ChannelChat、运行时、Mirror 等核心设计。
2. [生命周期与解耦评估](lifecycle-and-decoupling-audit.md)：本地进程拓扑、Bridge 生命周期、stream/mirror 边界和后续解耦建议。
3. [tmux Runtime 生命周期](tmux-runtime-lifecycle.md)：Codex/Claude tmux provider 的 thread/session、prompt 注入、mirror 和卡顿检测链路。
4. [后端状态](backend-status.md)：后端模块、状态文件和运行期数据概览。
5. [运行时命令作用域](runtime-command-scope.md)：slash 命令、运行时配置和 Bridge 配置边界。
6. [JSON Schema 与升级契约](json-schemas.md)：本地数据文件 schema 和迁移边界。
7. [桥接安全模型](security.md)：授权、输入校验、限流、权限回调和审计日志。
8. [流式卡片](streaming-card.md)：本地镜像、投递计划、碎片投递抑制、长连接刷新、底层飞书 API 和性能观测。
