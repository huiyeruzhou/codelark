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
});
