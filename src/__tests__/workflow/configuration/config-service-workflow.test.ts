import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfigService } from '../../../configuration/service.js';

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}

describe('ConfigService v2 workflow', () => {
  it('materializes partial custom channel TOML entries from default channel shape', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-config-v2-home-'));
    try {
      writeFile(path.join(home, 'config.toml'), `
[[channels]]
id = "feishu-custom"
alias = "飞书配置别名"
provider = "feishu"
enabled = true

[channels.config]
history_message_limit = 12
`);

      const service = createConfigService({ codelarkHome: home, env: {} });
      const custom = service.snapshot().config.channels.find((channel) => channel.id === 'feishu-custom');

      assert.ok(custom);
      assert.equal(custom.alias, '飞书配置别名');
      assert.equal(custom.provider, 'feishu');
      assert.equal(custom.enabled, true);
      assert.equal(custom.config.historyMessageLimit, 12);
      assert.equal(custom.config.streamStatusIdleStartSeconds, 180);
      assert.equal(custom.config.streamStatusCheckIntervalSeconds, 10);
      assert.equal(custom.config.appId, '');
      assert.deepEqual(custom.config.allowedUsers, []);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('resolves a session execution config from real TOML source files and exports child process env', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-config-v2-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-config-v2-cwd-'));
    try {
      writeFile(path.join(home, 'config.toml'), `
[runtime]
agent = "codex"

[runtime.codex]
model = "home-model"
reasoning_effort = "low"

[[channels]]
id = "feishu-default"
alias = "飞书"
provider = "feishu"
enabled = true

[channels.config]
app_id = "home-app"
app_secret = "home-secret"
history_message_limit = 6
`);
      writeFile(path.join(cwd, '.codelark', 'config.toml'), `
[runtime.codex]
model = "local-model"
`);
      writeFile(path.join(home, 'config', 'channels', 'chat-1.toml'), `
[runtime.codex]
reasoning_effort = "high"
`);
      writeFile(path.join(home, 'config', 'sessions', 'session-1.toml'), `
[session]
workspace = "/tmp/session-work"

[runtime.codex]
model = "session-model"
`);

      const service = createConfigService({ codelarkHome: home, env: {} });
      const scope = {
        kind: 'session',
        sessionId: 'session-1',
        channelId: 'chat-1',
        provider: 'feishu',
        cwd,
      } as const;

      assert.equal(service.get('runtime.codex.model', scope), 'session-model');
      assert.equal(service.resolve('runtime.codex.model', scope).source, 'session');
      assert.equal(service.get('runtime.codex.reasoningEffort', scope), 'high');
      assert.equal(service.resolve('runtime.codex.reasoningEffort', scope).source, 'channel');
      assert.equal(service.get('channels[].config.historyMessageLimit', scope), 6);
      assert.equal(service.resolve('channels[].config.historyMessageLimit', scope).source, 'home');

      const env = service.exportProcessEnv(scope);
      assert.equal(env.CODELARK_CODEX_MODEL, 'session-model');
      assert.equal(env.CODELARK_CODEX_REASONING_EFFORT, 'high');
      assert.equal(env.CODELARK_FEISHU_APP_ID, 'home-app');
      assert.equal(env.CODELARK_HISTORY_MESSAGE_LIMIT, '6');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
