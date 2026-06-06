import '../../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfigService } from '../../../../configuration/service.js';
import { resolveMigrationPaths, runConfigMigrations } from '../../../../configuration/migrations/index.js';

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-config-v1-e2e-'));
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}

describe('v1 config migration e2e', () => {
  it('migrates config.json plus newer config.env into config.toml and ignores later config.env edits', () => {
    const home = tempHome();
    try {
      const paths = resolveMigrationPaths(home);
      writeFile(paths.legacyConfigJson, JSON.stringify({
        schemaVersion: 1,
        runtime: {
          provider: 'codex',
          codex: {
            defaultModel: 'json-model',
            defaultMode: 'normal',
            sandboxMode: 'workspace-write',
            networkAccess: true,
            reasoningEffort: 'medium',
          },
          bridgeControl: {
            defaultCodexProvider: 'sdk',
          },
          bridge: {
            defaultWorkspaceRoot: '/json/workspace',
            historyMessageLimit: 9,
            streamStatusIdleStartSeconds: 240,
            uiAllowLan: false,
          },
          claude: {
            provider: 'pty',
            executable: 'ccr',
            defaultModel: 'claude-json',
            permissionMode: 'bypassPermissions',
            reasoningEffort: 'high',
            idleTimeoutMinutes: 5,
          },
        },
        channels: [{
          id: 'feishu-rd',
          alias: '研发飞书',
          provider: 'feishu',
          enabled: true,
          createdAt: '2026-03-28T00:00:00.000Z',
          updatedAt: '2026-03-28T00:00:00.000Z',
          config: {
            appId: 'json-app',
            appSecret: 'json-secret',
            site: 'feishu',
            allowedUsers: ['json-user'],
          },
        }],
      }, null, 2));
      writeFile(paths.legacyConfigEnv, [
        'CODELARK_CODEX_DEFAULT_MODEL=env-model',
        'CODELARK_DEFAULT_CODEX_PROVIDER=tmux',
        'CODELARK_HISTORY_MESSAGE_LIMIT=15',
        'CODELARK_CODEX_SANDBOX_MODE=danger-full-access',
        'CODELARK_FEISHU_APP_ID=env-app',
        'CODELARK_FEISHU_APP_SECRET=env-secret',
        'CODELARK_FEISHU_DOMAIN=lark',
        'CODELARK_FEISHU_ALLOWED_USERS=env-user-1,env-user-2',
      ].join('\n'));
      const past = new Date(Date.now() - 10_000);
      const future = new Date(Date.now() + 10_000);
      fs.utimesSync(paths.legacyConfigJson, past, past);
      fs.utimesSync(paths.legacyConfigEnv, future, future);

      const result = runConfigMigrations({
        codelarkHome: home,
        now: () => new Date('2026-06-06T14:30:00.000Z'),
      });

      assert.equal(result.changed, true);
      assert.equal(result.applied[0]?.id, 'v1');
      assert.equal(fs.existsSync(paths.homeToml), true);
      assert.equal(fs.existsSync(path.join(paths.backupDir, 'v1', 'config.json')), true);
      assert.equal(fs.existsSync(path.join(paths.backupDir, 'v1', 'config.env')), true);

      const service = createConfigService({ codelarkHome: home, env: {} });
      assert.equal(service.get('runtime.provider'), 'codex');
      assert.equal(service.get('runtime.codex.model'), 'env-model');
      assert.equal(service.get('runtime.codex.provider'), 'tmux');
      assert.equal(service.get('runtime.codex.sandboxMode'), 'danger-full-access');
      assert.equal(service.get('runtime.claude.model'), 'claude-json');
      assert.equal(service.get('runtime.claude.yoloMode'), 'on');
      assert.equal(service.get('runtime.claude.reasoningEffort'), 'high');
      assert.equal(service.get('runtime.claude.idleTimeoutMinutes'), 5);
      assert.equal(service.get('channels[].config.historyMessageLimit'), 15);
      assert.equal(service.get('channels[].config.appId'), 'env-app');
      assert.equal(service.get('channels[].config.appSecret'), 'env-secret');
      assert.equal(service.get('channels[].config.site'), 'lark');
      assert.deepEqual(service.get('channels[].config.allowedUsers'), ['env-user-1', 'env-user-2']);

      writeFile(paths.legacyConfigEnv, [
        'CODELARK_CODEX_DEFAULT_MODEL=must-not-be-read',
        'CODELARK_FEISHU_APP_ID=must-not-be-read',
      ].join('\n'));
      const afterEnvEdit = createConfigService({ codelarkHome: home, env: {} });
      assert.equal(afterEnvEdit.get('runtime.codex.model'), 'env-model');
      assert.equal(afterEnvEdit.get('channels[].config.appId'), 'env-app');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
