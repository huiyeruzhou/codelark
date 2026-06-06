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
  it('resolves a session execution config from real TOML source files and exports child process env', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-config-v2-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-config-v2-cwd-'));
    try {
      writeFile(path.join(home, 'config.toml'), `
[runtime]
provider = "codex"

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

[[channels]]
id = "feishu-default"
alias = "飞书"
provider = "feishu"
enabled = true

[channels.config]
history_message_limit = 7
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
      assert.equal(service.get('channels[].config.historyMessageLimit', scope), 7);
      assert.equal(service.resolve('channels[].config.historyMessageLimit', scope).source, 'local');

      const env = service.exportProcessEnv(scope);
      assert.equal(env.CODELARK_CODEX_MODEL, 'session-model');
      assert.equal(env.CODELARK_CODEX_REASONING_EFFORT, 'high');
      assert.equal(env.CODELARK_FEISHU_APP_ID, 'home-app');
      assert.equal(env.CODELARK_HISTORY_MESSAGE_LIMIT, '7');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
