import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'CodeLark',
  description: 'CodeLark 产品功能、架构和验证文档',
  lang: 'zh-CN',
  base: '/site/codelark/',
  cleanUrls: true,
  lastUpdated: true,
  markdown: {
    config(md) {
      const defaultFence = md.renderer.rules.fence;
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const token = tokens[idx];
        const info = token.info.trim().split(/\s+/)[0];
        if (info === 'mermaid') {
          const code = Buffer.from(token.content, 'utf8').toString('base64');
          return `<MermaidDiagram code64="${code}" />`;
        }
        return defaultFence
          ? defaultFence(tokens, idx, options, env, self)
          : self.renderToken(tokens, idx, options);
      };
    },
  },
  themeConfig: {
    logo: undefined,
    nav: [
      { text: '使用配置', link: '/guide/' },
      { text: '产品文档', link: '/product/' },
      { text: '架构', link: '/architecture/' },
      { text: '测试验证', link: '/testing/' },
    ],
    sidebar: [
      {
        text: '使用与配置',
        items: [
          { text: '入口', link: '/guide/' },
          { text: '安装与使用指南', link: '/guide/install-and-usage' },
          { text: 'Release Notes', link: '/guide/release-notes' },
          { text: '会话、Provider 与配置工作流', link: '/guide/session-workflows' },
          { text: '平台配置指南', link: '/guide/platform-setup' },
          { text: '云文档与交互卡片', link: '/guide/cloud-docs-and-cards' },
          { text: '排障指南', link: '/guide/troubleshooting' },
        ],
      },
      {
        text: '产品文档',
        items: [
          { text: '入口', link: '/product/' },
          { text: '命令体系', link: '/product/commands' },
          { text: '运行时与提供方', link: '/product/runtime-providers' },
          { text: '通道与 Web 工作台', link: '/product/channels-ui' },
          { text: '数据、可观测性与验证', link: '/product/data-observability' },
          { text: '开发者源码地图', link: '/product/developer-map' },
        ],
      },
      {
        text: '架构与数据契约',
        items: [
          { text: '入口', link: '/architecture/' },
          { text: '当前架构', link: '/architecture/current' },
          { text: '生命周期与解耦评估', link: '/architecture/lifecycle-and-decoupling-audit' },
          { text: '模块边界审计', link: '/architecture/module-boundary-audit' },
          { text: '后端状态', link: '/architecture/backend-status' },
          { text: '运行时命令作用域', link: '/architecture/runtime-command-scope' },
          { text: '新增 Agent / Runtime 接入边界', link: '/architecture/new-agent-runtime' },
          { text: 'JSON Schemas', link: '/architecture/json-schemas' },
          { text: '桥接安全模型', link: '/architecture/security' },
          { text: '流式卡片', link: '/architecture/streaming-card' },
        ],
      },
      {
        text: '测试与验证',
        items: [
          { text: '入口', link: '/testing/' },
          { text: '测试方法与语义分层', link: '/testing/methods' },
          { text: '功能测试覆盖审计', link: '/testing/coverage-audit' },
          { text: '真实飞书 E2E', link: '/testing/real-feishu/' },
          { text: '云文档 doc-as-chat E2E', link: '/testing/real-feishu/doc-as-chat-from-scratch' },
        ],
      },
    ],
    search: {
      provider: 'local',
    },
    outline: {
      label: '本页目录',
      level: [2, 3],
    },
    docFooter: {
      prev: '上一页',
      next: '下一页',
    },
    lastUpdated: {
      text: '最后更新',
      formatOptions: {
        dateStyle: 'medium',
        timeStyle: 'short',
      },
    },
  },
});
