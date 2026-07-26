import '../../setup/test-setup.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveInstalledCodelarkVersion } from '../../../bridge/update/installed-version.js';
import { renderUiShellHtml } from '../../../operator-ui/shell.js';

describe('operator UI shell', () => {
  it('shows the installed CodeLark version in the brand area', () => {
    const html = renderUiShellHtml();
    const version = resolveInstalledCodelarkVersion();

    assert.ok(version);
    assert.match(html, new RegExp(`class="brand-version">v${version.replaceAll('.', '\\.')}<\\/span>`));
  });
});
