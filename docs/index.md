# CodeLark 文档

欢迎阅读 CodeLark 文档站。文档按维护主题组织成自然树结构，HTTP 路径和 `docs/` 下的源文件路径保持一致。

- 代码仓库：https://github.com/huiyeruzhou/codelark
- 文档站：https://huiyeruzhou.github.io/site/codelark/

## 快速入口

- [使用与配置](guide/)：安装、平台接入、凭据验证、本地工作台、云文档能力和排障。
- [产品文档](product/)：功能说明、命令体系、运行时/提供方、通道和开发者源码地图。
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
