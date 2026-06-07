import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createConfigService,
  type ConfigServiceOptions,
} from '../../../configuration/service.js';
import type { ConfigV2 } from '../../../configuration/schema.js';

interface RuntimeSettingsProjection {
  settings: Map<string, string>;
  config: ConfigV2;
}

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-runtime-settings-service-'));
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}

function projectRuntimeSettingsFromService(options: ConfigServiceOptions = {}): RuntimeSettingsProjection {
  const service = createConfigService(options);
  const config = service.snapshot().config;
  return {
    config,
    settings: service.projectRuntimeSettings(config),
  };
}

function exportRuntimeSettingsFromService(options: ConfigServiceOptions = {}): Map<string, string> {
  return createConfigService(options).exportRuntimeSettings();
}

describe('runtime settings service projection', () => {
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

      const projection = projectRuntimeSettingsFromService({ codelarkHome: home, env: {} });
      assert.equal(projection.config.runtime.agent, 'claude');
      assert.equal(projection.config.runtime.codex.model, 'toml-model');
      assert.equal(projection.config.runtime.codex.yoloMode, 'on');
      assert.equal(projection.config.runtime.claude.permissionMode, 'default');

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

      const settings = exportRuntimeSettingsFromService({ codelarkHome: home, env: {} });
      assert.equal(settings.get('bridge_default_model'), 'direct-model');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('projects local TOML from the service cwd into runtime settings', () => {
    const home = tempHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-runtime-settings-local-'));
    try {
      writeFile(path.join(home, 'config.toml'), `
[runtime.codex]
model = "home-model"
`);
      writeFile(path.join(cwd, '.codelark', 'config.toml'), `
[runtime.codex]
model = "local-model"
`);

      const projection = projectRuntimeSettingsFromService({ codelarkHome: home, cwd, env: {} });

      assert.equal(projection.config.runtime.codex.model, 'local-model');
      assert.equal(projection.settings.get('bridge_default_model'), 'local-model');
      assert.equal(projection.settings.get('bridge_default_model'), projection.config.runtime.codex.model);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
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

      const projection = projectRuntimeSettingsFromService({
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

      assert.equal(projection.config.runtime.agent, 'claude');
      assert.equal(projection.config.runtime.codex.model, 'cli-model');
      assert.equal(projection.config.runtime.codex.provider, 'tmux');
      assert.equal(projection.settings.get('bridge_default_runtime'), 'claude');
      assert.equal(projection.settings.get('bridge_default_model'), 'cli-model');
      assert.equal(projection.settings.get('bridge_default_provider'), 'tmux');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
