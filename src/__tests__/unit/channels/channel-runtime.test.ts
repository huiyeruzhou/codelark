import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getChannelProviderKey,
  getConfiguredChannelInstance,
  getFeedbackParseMode,
} from '../../../channels/adapter-runtime/channel-runtime.js';

function withTempHome(run: (home: string) => void): void {
  const previousHome = process.env.CODELARK_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-channel-runtime-'));
  process.env.CODELARK_HOME = home;
  try {
    run(home);
  } finally {
    if (previousHome === undefined) {
      delete process.env.CODELARK_HOME;
    } else {
      process.env.CODELARK_HOME = previousHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function writeHomeConfig(home: string, content: string): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), content, 'utf-8');
}

describe('channel-runtime config lookup', () => {
  it('falls back from legacy provider channelType to the configured provider instance', () => {
    withTempHome((home) => {
      writeHomeConfig(home, `
[[channels]]
id = "feishu-default"
alias = "飞书"
provider = "feishu"
enabled = true

[channels.config]
feedback_markdown_enabled = true
`);

      assert.equal(getConfiguredChannelInstance('feishu-default')?.id, 'feishu-default');
      assert.equal(getConfiguredChannelInstance('feishu')?.id, 'feishu-default');
      assert.equal(getChannelProviderKey('feishu-default'), 'feishu');
      assert.equal(getFeedbackParseMode('feishu'), 'Markdown');
    });
  });
});
