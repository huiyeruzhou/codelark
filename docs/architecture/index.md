# 架构与数据契约

本模块收纳 BridgeSession、ChannelChat、运行时边界、数据 schema、安全模型和后端状态相关文档。

## 阅读路径

1. [当前架构](current.md)：BridgeSession、ChannelChat、运行时、Mirror 等核心设计。
2. [生命周期与解耦评估](lifecycle-and-decoupling-audit.md)：本地进程拓扑、Bridge 生命周期、stream/mirror 边界和后续解耦建议。
3. [模块边界审计](module-boundary-audit.md)：文件粒度、功能聚合、多跳查阅热点和改进建议。
4. [后端状态](backend-status.md)：后端模块、状态文件和运行期数据概览。
5. [运行时命令作用域](runtime-command-scope.md)：slash 命令、运行时配置和 Bridge 配置边界。
6. [配置系统说明](config-refactor.md)：当前配置来源、TOML shape、多级覆盖、统一查询 API 和迁移兼容边界。
7. [JSON Schema 与升级契约](json-schemas.md)：本地数据文件 schema 和迁移边界。
8. [桥接安全模型](security.md)：授权、输入校验、限流、权限回调和审计日志。
9. [流式卡片](streaming-card.md)：本地镜像、投递计划、碎片投递抑制、长连接刷新、底层飞书 API 和性能观测。
