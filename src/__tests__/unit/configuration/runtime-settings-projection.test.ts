import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadRuntimeSettings,
  loadRuntimeSettingsProjection,
} from '../../../configuration/runtime-settings-projection.js';

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-runtime-settings-projection-'));
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}

describe('runtime settings projection helper', () => {
  it('projects initial runtime settings from ConfigService and ignores legacy config.env', () => {
    const home = tempHome();
    try {
      writeFile(path.join(home, 'config.toml'), [
        'schema_version = 2',
        '',
        '[runtime]',
        'agent = "claude"',
        '',
        '[runtime.codex]',
        'model = "toml-model"',
        'provider = "pty"',
        'yolo_mode = "on"',
        '',
        '[runtime.claude]',
        'model = "toml-claude"',
        'yolo_mode = "off"',
        '',
        '[[channels]]',
        'id = "feishu-default"',
        'alias = "飞书"',
        'provider = "feishu"',
        'enabled = true',
        '',
        '[channels.config]',
        'history_message_limit = 19',
        'stream_status_idle_start_seconds = 180',
        'stream_status_check_interval_seconds = 10',
        'app_id = "toml-app"',
        'app_secret = ""',
        'site = "feishu"',
        'allowed_users = []',
        'streaming_enabled = true',
        'feedback_markdown_enabled = true',
        'require_mention = false',
        '',
      ].join('\n'));
      writeFile(path.join(home, 'config.env'), [
        'CODELARK_RUNTIME=codex',
        'CODELARK_CODEX_DEFAULT_MODEL=legacy-env-model',
        'CODELARK_CODEX_DEFAULT_MODE=normal',
        'CODELARK_FEISHU_APP_ID=legacy-env-app',
        '',
      ].join('\n'));

      const projection = loadRuntimeSettingsProjection({ codelarkHome: home, env: {} });
      assert.equal(projection.legacyConfig.runtime, 'claude');
      assert.equal(projection.legacyConfig.defaultModel, 'toml-model');
      assert.equal(projection.legacyConfig.defaultMode, 'yolo');
      assert.equal(projection.legacyConfig.claudePermissionMode, 'default');

      assert.equal(projection.settings.get('bridge_default_runtime'), 'claude');
      assert.equal(projection.settings.get('bridge_default_model'), 'toml-model');
      assert.equal(projection.settings.get('default_model'), 'toml-model');
      assert.equal(projection.settings.get('bridge_default_provider'), 'pty');
      assert.equal(projection.settings.get('bridge_default_mode'), 'yolo');
      assert.equal(projection.settings.get('bridge_claude_default_model'), 'toml-claude');
      assert.equal(projection.settings.get('bridge_claude_permission_mode'), 'default');
      assert.equal(projection.settings.get('bridge_history_message_limit'), '19');
      assert.equal(projection.settings.get('bridge_feishu_enabled'), 'true');
      assert.equal(projection.settings.get('bridge_feishu_app_id'), 'toml-app');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns settings directly for store and UI callers', () => {
    const home = tempHome();
    try {
      writeFile(path.join(home, 'config.toml'), `
[runtime.codex]
model = "direct-model"
`);

      const settings = loadRuntimeSettings({ codelarkHome: home, env: {} });
      assert.equal(settings.get('bridge_default_model'), 'direct-model');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('applies CLI config source above env and home TOML', () => {
    const home = tempHome();
    try {
      writeFile(path.join(home, 'config.toml'), `
[runtime]
agent = "codex"

[runtime.codex]
model = "toml-model"
provider = "sdk"
`);

      const projection = loadRuntimeSettingsProjection({
        codelarkHome: home,
        env: {
          CODELARK_AGENT: 'codex',
          CODELARK_CODEX_MODEL: 'env-model',
          CODELARK_CODEX_PROVIDER: 'pty',
        },
        cli: {
          runtime: {
            agent: 'claude',
            codex: {
              model: 'cli-model',
              provider: 'tmux',
            },
          },
        },
      });

      assert.equal(projection.legacyConfig.runtime, 'claude');
      assert.equal(projection.legacyConfig.defaultModel, 'cli-model');
      assert.equal(projection.legacyConfig.defaultProvider, 'tmux');
      assert.equal(projection.settings.get('bridge_default_runtime'), 'claude');
      assert.equal(projection.settings.get('bridge_default_model'), 'cli-model');
      assert.equal(projection.settings.get('bridge_default_provider'), 'tmux');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
