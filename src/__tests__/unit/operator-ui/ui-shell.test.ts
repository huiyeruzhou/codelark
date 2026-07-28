import '../../setup/test-setup.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveInstalledCodelarkVersion } from '../../../bridge/update/installed-version.js';
import { mainStyles } from '../../../operator-ui/assets.js';
import { renderUiShellHtml } from '../../../operator-ui/shell.js';

describe('operator UI shell', () => {
  it('shows the installed CodeLark version in the brand area', () => {
    const html = renderUiShellHtml();
    const version = resolveInstalledCodelarkVersion();

    assert.ok(version);
    assert.match(html, new RegExp(`class="brand-version">v${version.replaceAll('.', '\\.')}<\\/span>`));
  });

  it('renders one truthful bridge path with every live status target present', () => {
    const html = renderUiShellHtml();

    assert.equal((html.match(/class="bridge-path-node/g) || []).length, 4);
    assert.match(html, /Web 工作台/);
    assert.match(html, /Bridge 服务/);
    assert.match(html, /通道实例/);
    assert.match(html, /活动会话/);
    for (const id of [
      'bridgeStatus',
      'bridgeStatusMeta',
      'channelStatus',
      'activeSessionCount',
      'runtimeStatus',
      'codexSessionCount',
      'bindingCount',
      'integrationStatus',
      'autostartStatus',
    ]) {
      assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
    }
    assert.doesNotMatch(html, /class="status-grid"/);
    assert.doesNotMatch(html, /class="status-card"/);
  });

  it('uses the modern control-plane visual contract at desktop and narrow widths', () => {
    assert.doesNotMatch(mainStyles, /backdrop-filter/i);
    assert.match(mainStyles, /\.bridge-path\s*\{/);
    assert.match(mainStyles, /@media \(max-width: 720px\)[\s\S]*\.bridge-path-node\s*\{[\s\S]*grid-template-columns:/);
    assert.match(mainStyles, /\.nav-link\.active\s*\{[\s\S]*linear-gradient/);
    assert.match(mainStyles, /radial-gradient/);
    assert.match(mainStyles, /--shadow-sm:/);
    assert.match(mainStyles, /input, select, textarea \{[\s\S]*min-width: 0;/);
    assert.match(mainStyles, /#boundSessionsList, #codexSessionsList \{ min-width: 0; max-width: 100%; \}/);
    assert.match(mainStyles, /\.binding-table-wrap \{ width: 100%; max-width: 100%; min-width: 0;/);
    assert.match(mainStyles, /@media \(max-width: 720px\)[\s\S]*\.help-tip::after \{[\s\S]*position: fixed;/);
  });

  it('offers one shared search and runtime filter for the session ledger', () => {
    const html = renderUiShellHtml();

    assert.match(html, /id="sessionSearch"/);
    assert.match(html, /id="sessionRuntimeFilter"/);
    assert.match(html, /<option value="codex">Codex<\/option>/);
    assert.match(html, /<option value="claude">Claude Code<\/option>/);
    assert.match(html, /<option value="kimi">Kimi Code<\/option>/);
    assert.match(html, /<option value="cursor">Cursor Agent<\/option>/);
    assert.match(html, /function sessionMatchesFilter\(session\)/);
    assert.match(html, /const sessions = allSessions\.filter\(sessionMatchesFilter\)/);
  });

  it('groups global settings into one common tab and runtime-owned tabs', () => {
    const html = renderUiShellHtml();

    for (const tab of ['common', 'codex', 'claude', 'kimi', 'cursor', 'web']) {
      assert.match(html, new RegExp(`data-config-tab="${tab}"`));
      assert.match(html, new RegExp(`data-config-section="${tab}"`));
    }
    assert.match(html, /data-config-section="common"[\s\S]*id="defaultWorkspaceRoot"[\s\S]*id="tmuxCaptureLines"[\s\S]*id="tmuxEchoInput"/);
    assert.match(html, /data-config-section="codex"[\s\S]*id="defaultProvider"/);
    assert.match(html, /function setActiveConfigTab\(tab\)/);
  });

  it('renders equal live status surfaces for all supported runtimes', () => {
    const html = renderUiShellHtml();

    assert.match(html, /aria-label="Runtime 当前状态"/);
    for (const runtime of ['codex', 'claude', 'kimi', 'cursor']) {
      assert.match(html, new RegExp(`class="runtime-status-item" data-runtime="${runtime}"`));
      assert.match(html, new RegExp(`id="runtime-${runtime}-state"`));
      assert.match(html, new RegExp(`id="runtime-${runtime}-counts"`));
      assert.match(html, new RegExp(`id="runtime-${runtime}-config"`));
      assert.match(html, new RegExp(`id="runtime-${runtime}-recent"`));
    }
    assert.match(html, /function runtimeStatusProjection\(runtime\)/);
    assert.match(html, /function renderRuntimeStatuses\(\)/);
  });

  it('avoids vague location filler while preserving actionable descriptions', () => {
    const html = renderUiShellHtml();
    for (const vagueCopy of [
      '集中在这一页',
      '可以直接在这里',
      '这里显示',
      '这里展示',
      '这里维护',
      '这里列出',
      '都走这里',
    ]) {
      assert.equal(html.includes(vagueCopy), false, `vague UI copy: ${vagueCopy}`);
    }
    assert.match(html, /本机运行时和关键目录，用于排查部署问题/);
    assert.match(html, /管理机器人实例，以及各群聊和单聊的会话绑定/);
    assert.match(html, /查看结构化 Bridge JSONL，定位 runtime、通道和投递问题/);
  });
});
