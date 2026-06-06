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

  it('migrates BridgeSession runtime config overrides into session TOML and prunes session JSON', () => {
    const home = tempHome();
    try {
      const paths = resolveMigrationPaths(home);
      writeFile(paths.dataSessionsJson, JSON.stringify({
        'session-codex': {
          id: 'session-codex',
          name: 'Codex work',
          runtime: {
            activeRuntime: 'codex',
            codex: {
              threadId: 'thread-123',
              title: 'Existing Codex thread',
              model: 'gpt-5-codex',
              mode: 'yolo',
              provider: 'tmux',
              sandboxMode: 'read-only',
              networkAccess: false,
              reasoningEffort: 'high',
            },
            general: {
              workingDirectory: '/repo/codex',
              systemPrompt: 'Do not move this into config.',
              tmuxSessionName: 'codex-tmux',
              captureLines: 120,
              autoEnter: false,
              echoInput: true,
            },
          },
          health_status: 'idle',
          created_at: '2026-06-06T10:00:00.000Z',
        },
        'session-claude': {
          id: 'session-claude',
          runtime: {
            activeRuntime: 'claude',
            claude: {
              sessionId: 'claude-session-123',
              cwd: '/repo/claude-runtime',
              model: 'claude-sonnet',
              provider: 'pty',
              permissionMode: 'bypassPermissions',
              reasoningEffort: 'xhigh',
              idleTimeoutMinutes: 7,
            },
            general: {
              workingDirectory: '/repo/claude-config',
            },
          },
          runtime_status: 'idle',
        },
      }, null, 2));

      const result = runConfigMigrations({
        codelarkHome: home,
        now: () => new Date('2026-06-06T14:45:00.000Z'),
      });

      assert.equal(result.changed, true);
      assert.equal(result.applied[0]?.id, 'v1');
      assert.equal(fs.existsSync(path.join(paths.backupDir, 'v1', 'data', 'sessions.json')), true);
      assert.equal(fs.existsSync(path.join(paths.sessionConfigDir, 'session-codex.toml')), true);
      assert.equal(fs.existsSync(path.join(paths.sessionConfigDir, 'session-claude.toml')), true);

      const service = createConfigService({ codelarkHome: home, env: {} });
      assert.equal(service.get('runtime.provider', { kind: 'session', sessionId: 'session-codex' }), 'codex');
      assert.equal(service.get('session.workspace', { kind: 'session', sessionId: 'session-codex' }), '/repo/codex');
      assert.equal(service.get('session.tmuxSessionName', { kind: 'session', sessionId: 'session-codex' }), 'codex-tmux');
      assert.equal(service.get('session.tmuxCaptureLines', { kind: 'session', sessionId: 'session-codex' }), 120);
      assert.equal(service.get('session.tmuxAutoEnter', { kind: 'session', sessionId: 'session-codex' }), false);
      assert.equal(service.get('session.tmuxEchoInput', { kind: 'session', sessionId: 'session-codex' }), true);
      assert.equal(service.get('runtime.codex.model', { kind: 'session', sessionId: 'session-codex' }), 'gpt-5-codex');
      assert.equal(service.get('runtime.codex.yoloMode', { kind: 'session', sessionId: 'session-codex' }), 'on');
      assert.equal(service.get('runtime.codex.provider', { kind: 'session', sessionId: 'session-codex' }), 'tmux');
      assert.equal(service.get('runtime.codex.sandboxMode', { kind: 'session', sessionId: 'session-codex' }), 'read-only');
      assert.equal(service.get('runtime.codex.networkAccess', { kind: 'session', sessionId: 'session-codex' }), false);
      assert.equal(service.get('runtime.codex.reasoningEffort', { kind: 'session', sessionId: 'session-codex' }), 'high');

      assert.equal(service.get('runtime.provider', { kind: 'session', sessionId: 'session-claude' }), 'claude');
      assert.equal(service.get('session.workspace', { kind: 'session', sessionId: 'session-claude' }), '/repo/claude-config');
      assert.equal(service.get('runtime.claude.model', { kind: 'session', sessionId: 'session-claude' }), 'claude-sonnet');
      assert.equal(service.get('runtime.claude.provider', { kind: 'session', sessionId: 'session-claude' }), 'pty');
      assert.equal(service.get('runtime.claude.yoloMode', { kind: 'session', sessionId: 'session-claude' }), 'on');
      assert.equal(service.get('runtime.claude.reasoningEffort', { kind: 'session', sessionId: 'session-claude' }), 'xhigh');
      assert.equal(service.get('runtime.claude.idleTimeoutMinutes', { kind: 'session', sessionId: 'session-claude' }), 7);

      const pruned = JSON.parse(fs.readFileSync(paths.dataSessionsJson, 'utf-8')) as Record<string, {
        health_status?: string;
        runtime_status?: string;
        runtime?: {
          activeRuntime?: string;
          codex?: Record<string, unknown>;
          claude?: Record<string, unknown>;
          general?: Record<string, unknown>;
        };
      }>;
      assert.equal(pruned['session-codex']?.runtime?.activeRuntime, undefined);
      assert.deepEqual(pruned['session-codex']?.runtime?.codex, {
        threadId: 'thread-123',
        title: 'Existing Codex thread',
      });
      assert.deepEqual(pruned['session-codex']?.runtime?.general, {
        systemPrompt: 'Do not move this into config.',
      });
      assert.equal(pruned['session-codex']?.health_status, 'idle');
      assert.equal(pruned['session-claude']?.runtime?.activeRuntime, undefined);
      assert.deepEqual(pruned['session-claude']?.runtime?.claude, {
        sessionId: 'claude-session-123',
        cwd: '/repo/claude-runtime',
      });
      assert.equal(pruned['session-claude']?.runtime_status, 'idle');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
