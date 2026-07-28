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

  it('uses the restrained control-plane visual contract at desktop and narrow widths', () => {
    assert.doesNotMatch(mainStyles, /gradient/i);
    assert.doesNotMatch(mainStyles, /backdrop-filter/i);
    assert.match(mainStyles, /\.bridge-path\s*\{/);
    assert.match(mainStyles, /@media \(max-width: 720px\)[\s\S]*\.bridge-path-node\s*\{[\s\S]*grid-template-columns:/);
    assert.match(mainStyles, /\.nav-link\.active\s*\{[\s\S]*background: #344054/);
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
});
