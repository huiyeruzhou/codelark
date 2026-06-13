# Release Notes

## v0.1.1

发布日期：2026-06-14

`0.1.1` 聚焦 tmux provider 的启动恢复、输入透传和文档可用性。npm 包版本为 `codelark@0.1.1`，对应 Git tag `v0.1.1`。

### 用户可见变化

- tmux provider 在 Codex 启动弹窗后会保留待转发输入；选择 `Skip` 后等待 TUI ready 再注入原消息，选择 `Update now` 后会提示并重新拉起 Codex。
- tmux capture 行数语义改为“最终希望看到的行数”。例如配置 20 行、当前 pane 高度为 10 时，只会额外请求 10 行历史，而不是把两个数相加。
- Codex TUI 显示 `Working` 但底部仍有输入行时，会被识别为可输入状态；普通消息可以继续透传到已有 tmux session。
- 新增会话、Provider 与配置工作流文档，集中说明 `/t`、attach/detach、`/provider`、`/tmux-screen`、`/tmux-set`、`/current` 和 home/session 配置层级。

### 验证范围

- GitHub Actions main CI 已通过：typecheck、stable tests、build、docs build、npm package contents。
- 发布前本地也完成过完整 `npm test`、`npm run build`、`npm run typecheck` 和 docs build。
- fake Codex TUI E2E 覆盖普通启动、delayed ready、update prompt、permission prompt、Working 输入行和启动弹窗后的 auto-forward 恢复。

### 升级

```bash
npm install -g codelark@0.1.1
```

或直接运行：

```bash
npx -y codelark@0.1.1 run
```
