# CodeLark 文档

欢迎阅读 CodeLark 文档站。内容分为面向使用者的用户文档，以及面向设计、开发和验证的维护文档。

- 代码仓库：https://github.com/huiyeruzhou/codelark
- 文档站：https://huiyeruzhou.github.io/site/codelark/

## 快速入口

### 用户文档

- [5 分钟上手](guide/daily-workflow.md)：从创建任务群到查看 tmux、继续追问和接回会话。
- [安装与使用](guide/)：安装、平台接入、会话管理、云文档能力和排障。

### 设计与维护文档

- [产品与实现](product/)：能力边界、命令体系、运行时/提供方、通道和源码地图。
- [架构与数据契约](architecture/)：核心架构、运行时边界、JSON Schema、安全模型和后端状态。
- [测试与验证](testing/)：功能覆盖审计、真实飞书 E2E 和专项验证计划。

## 本地预览

```bash
npm run docs:build
npm run docs:preview
```

开发时如果系统文件监听额度足够，也可以使用：

```bash
npm run docs:dev
```
