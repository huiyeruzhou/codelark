import '../../../setup/test-setup.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODELARK_HOME } from '../../../../configuration/paths.js';
import { createConfigService } from '../../../../configuration/service.js';
import { resolveMigrationPaths, runConfigMigrations } from '../../../../configuration/migrations/index.js';
import { exportRuntimeSettings } from '../../../../runtime/config-projections.js';
import { JsonFileStore } from '../../../../storage/json-store.js';
import { initBridgeContext } from '../../../../bridge/host/context.js';
import { _testOnly, start, stop } from '../../../../bridge/host/manager.js';
import { BaseChannelAdapter, registerAdapterFactory } from '../../../../channels/contracts.js';
import type { OutboundMessage, PermissionGateway, SendResult } from '../../../../domain/index.js';
import type { LifecycleHooks, LLMProvider, StreamChatParams } from '../../../../runtime/contracts.js';
import type { RuntimeChannelInstance } from '../../../../channels/types.js';

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-config-v1-e2e-'));
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}

const noopLlm: LLMProvider = {
  streamChat(_params: StreamChatParams): ReadableStream<string> {
    return new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
  },
};

const noopPermissions: PermissionGateway = {
  resolvePendingPermission: () => false,
};

const noopLifecycle: LifecycleHooks = {};

class MigratedConfigAdapter extends BaseChannelAdapter {
  static startedInstances: RuntimeChannelInstance[] = [];
  static stoppedInstances: string[] = [];

  readonly channelType: string;
  readonly provider: string;
  private running = false;
  private waiters: Array<(msg: null) => void> = [];

  constructor(private readonly instance: RuntimeChannelInstance) {
    super();
    this.channelType = instance.id;
    this.provider = instance.provider;
    Object.defineProperty(this, 'alias', {
      value: instance.alias,
      configurable: true,
      enumerable: true,
      writable: false,
    });
  }

  async start(): Promise<void> {
    this.running = true;
    MigratedConfigAdapter.startedInstances.push(this.instance);
  }

  async stop(): Promise<void> {
    this.running = false;
    MigratedConfigAdapter.stoppedInstances.push(this.channelType);
    for (const resolve of this.waiters.splice(0)) {
      resolve(null);
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  consumeOne(): Promise<null> {
    if (!this.running) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async send(_message: OutboundMessage): Promise<SendResult> {
    return { ok: true, messageId: 'migrated-config-adapter-message' };
  }

  validateConfig(): string | null {
    const config = this.instance.config as { appId?: string; appSecret?: string };
    return config.appId && config.appSecret ? null : 'missing migrated app credentials';
  }

  isAuthorized(): boolean {
    return true;
  }
}

function cleanCodelarkHomeConfig(home: string): void {
  const paths = resolveMigrationPaths(home);
  fs.rmSync(paths.homeToml, { force: true });
  fs.rmSync(paths.legacyConfigJson, { force: true });
  fs.rmSync(paths.legacyConfigEnv, { force: true });
  fs.rmSync(`${paths.legacyConfigJson}.migrated-v1`, { force: true });
  fs.rmSync(`${paths.legacyConfigEnv}.migrated-v1`, { force: true });
  fs.rmSync(paths.dataSessionsJson, { force: true });
  fs.rmSync(path.dirname(paths.dataSessionsJson), { recursive: true, force: true });
  fs.rmSync(path.join(home, 'config'), { recursive: true, force: true });
  fs.rmSync(path.join(home, 'runtime', 'config-migrations.json'), { force: true });
  fs.rmSync(paths.backupDir, { recursive: true, force: true });
}

describe('v1 config migration e2e', () => {
  afterEach(async () => {
    await stop();
    _testOnly.resetStateForTests();
  });

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
      assert.equal(fs.existsSync(paths.legacyConfigJson), false);
      assert.equal(fs.existsSync(paths.legacyConfigEnv), false);
      assert.equal(fs.existsSync(`${paths.legacyConfigJson}.migrated-v1`), true);
      assert.equal(fs.existsSync(`${paths.legacyConfigEnv}.migrated-v1`), true);

      const service = createConfigService({ codelarkHome: home, env: {} });
      assert.equal(service.get('runtime.agent'), 'codex');
      assert.equal(service.get('runtime.codex.model'), 'env-model');
      assert.equal(service.get('runtime.codex.provider'), 'tmux');
      assert.equal(service.get('runtime.codex.sandboxMode'), 'danger-full-access');
      assert.equal(service.get('runtime.claude.model'), 'claude-json');
      assert.equal(service.get('runtime.claude.yoloMode'), 'off');
      assert.equal(service.get('runtime.claude.reasoningEffort'), 'high');
      assert.equal(service.get('runtime.claude.idleTimeoutMinutes'), 5);
      const channel = service.snapshot().config.channels.find((entry) => entry.id === 'feishu-default');
      assert.equal(channel?.config.historyMessageLimit, 15);
      assert.equal(channel?.config.appId, 'env-app');
      assert.equal(channel?.config.appSecret, 'env-secret');
      assert.equal(channel?.config.site, 'lark');
      assert.deepEqual(channel?.config.allowedUsers, ['env-user-1', 'env-user-2']);

      writeFile(paths.legacyConfigEnv, [
        'CODELARK_CODEX_DEFAULT_MODEL=must-not-be-read',
        'CODELARK_FEISHU_APP_ID=must-not-be-read',
      ].join('\n'));
      const afterEnvEdit = createConfigService({ codelarkHome: home, env: {} });
      assert.equal(afterEnvEdit.get('runtime.codex.model'), 'env-model');
      assert.equal(
        afterEnvEdit.snapshot().config.channels.find((entry) => entry.id === 'feishu-default')?.config.appId,
        'env-app',
      );
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
      assert.equal(service.get('runtime.agent', { kind: 'session', sessionId: 'session-codex' }), 'codex');
      assert.equal(service.get('session.workspace', { kind: 'session', sessionId: 'session-codex' }), '/repo/codex');
      assert.equal(service.get('session.tmuxCaptureLines', { kind: 'session', sessionId: 'session-codex' }), 120);
      assert.equal(service.get('session.tmuxAutoEnter', { kind: 'session', sessionId: 'session-codex' }), false);
      assert.equal(service.get('session.tmuxEchoInput', { kind: 'session', sessionId: 'session-codex' }), true);
      assert.equal(service.get('runtime.codex.model', { kind: 'session', sessionId: 'session-codex' }), 'gpt-5-codex');
      assert.equal(service.get('runtime.codex.yoloMode', { kind: 'session', sessionId: 'session-codex' }), 'on');
      assert.equal(service.get('runtime.codex.provider', { kind: 'session', sessionId: 'session-codex' }), 'tmux');
      assert.equal(service.get('runtime.codex.sandboxMode', { kind: 'session', sessionId: 'session-codex' }), 'read-only');
      assert.equal(service.get('runtime.codex.networkAccess', { kind: 'session', sessionId: 'session-codex' }), false);
      assert.equal(service.get('runtime.codex.reasoningEffort', { kind: 'session', sessionId: 'session-codex' }), 'high');

      assert.equal(service.get('runtime.agent', { kind: 'session', sessionId: 'session-claude' }), 'claude');
      assert.equal(service.get('session.workspace', { kind: 'session', sessionId: 'session-claude' }), '/repo/claude-config');
      assert.equal(service.get('runtime.claude.model', { kind: 'session', sessionId: 'session-claude' }), 'claude-sonnet');
      assert.equal(service.get('runtime.claude.provider', { kind: 'session', sessionId: 'session-claude' }), 'pty');
      assert.equal(service.get('runtime.claude.yoloMode', { kind: 'session', sessionId: 'session-claude' }), 'off');
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
        tmuxSessionName: 'codex-tmux',
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

  it('starts the bridge from v2 config after migrating legacy v1 files', async () => {
    cleanCodelarkHomeConfig(CODELARK_HOME);
    MigratedConfigAdapter.startedInstances = [];
    MigratedConfigAdapter.stoppedInstances = [];
    registerAdapterFactory('feishu', (instance) => new MigratedConfigAdapter(instance as RuntimeChannelInstance));

    const paths = resolveMigrationPaths(CODELARK_HOME);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codelark-v1-v2-runtime-workspace-'));
    try {
      writeFile(paths.legacyConfigJson, JSON.stringify({
        schemaVersion: 1,
        runtime: {
          provider: 'claude',
          codex: {
            defaultModel: 'legacy-json-model',
            defaultMode: 'normal',
            sandboxMode: 'workspace-write',
            networkAccess: false,
            reasoningEffort: 'medium',
          },
          bridgeControl: {
            defaultCodexProvider: 'sdk',
          },
          bridge: {
            defaultWorkspaceRoot: workspace,
            historyMessageLimit: 7,
            streamStatusIdleStartSeconds: 90,
            streamStatusCheckIntervalSeconds: 5,
          },
        },
        channels: [{
          id: 'feishu-default',
          alias: 'Legacy Feishu',
          provider: 'feishu',
          enabled: true,
          config: {
            appId: 'json-app',
            appSecret: 'json-secret',
            site: 'feishu',
            allowedUsers: ['json-user'],
            streamingEnabled: false,
            feedbackMarkdownEnabled: false,
            requireMention: true,
          },
        }],
      }, null, 2));
      writeFile(paths.legacyConfigEnv, [
        'CODELARK_RUNTIME=codex',
        'CODELARK_ENABLED_CHANNELS=feishu',
        'CODELARK_CODEX_DEFAULT_MODEL=env-runtime-model',
        'CODELARK_DEFAULT_CODEX_PROVIDER=tmux',
        'CODELARK_CODEX_NETWORK_ACCESS=true',
        'CODELARK_HISTORY_MESSAGE_LIMIT=11',
        'CODELARK_STREAM_STATUS_IDLE_START_SECONDS=120',
        'CODELARK_STREAM_STATUS_CHECK_INTERVAL_SECONDS=12',
        'CODELARK_FEISHU_APP_ID=env-runtime-app',
        'CODELARK_FEISHU_APP_SECRET=env-runtime-secret',
        'CODELARK_FEISHU_SITE=lark',
        'CODELARK_FEISHU_ALLOWED_USERS=env-user-1,env-user-2',
        'CODELARK_FEISHU_STREAMING_ENABLED=true',
        'CODELARK_FEISHU_COMMAND_MARKDOWN_ENABLED=true',
        'CODELARK_FEISHU_REQUIRE_MENTION=false',
      ].join('\n'));

      const service = createConfigService({
        codelarkHome: CODELARK_HOME,
        env: {},
        migrationNow: () => new Date('2026-06-07T14:55:00.000Z'),
      });
      assert.equal(service.migrationResult?.changed, true);
      assert.equal(service.migrationResult?.applied[0]?.id, 'v1');
      assert.equal(fs.existsSync(paths.homeToml), true);
      assert.equal(fs.existsSync(paths.legacyConfigJson), false);
      assert.equal(fs.existsSync(paths.legacyConfigEnv), false);

      initBridgeContext({
        store: new JsonFileStore(exportRuntimeSettings(service.snapshot().config), { dynamicSettings: true }),
        llm: noopLlm,
        permissions: noopPermissions,
        lifecycle: noopLifecycle,
      });

      await start();

      assert.equal(MigratedConfigAdapter.startedInstances.length, 1);
      const instance = MigratedConfigAdapter.startedInstances[0]!;
      assert.equal(instance.id, 'feishu-default');
      assert.equal(instance.alias, '飞书');
      assert.equal(instance.enabled, true);
      assert.deepEqual(instance.config, {
        historyMessageLimit: 11,
        streamStatusIdleStartSeconds: 120,
        streamStatusCheckIntervalSeconds: 12,
        appId: 'env-runtime-app',
        appSecret: 'env-runtime-secret',
        site: 'lark',
        allowedUsers: ['env-user-1', 'env-user-2'],
        streamingEnabled: true,
        feedbackMarkdownEnabled: true,
        requireMention: false,
        groupAuthorized: false,
      });

      const runtimeService = createConfigService({ codelarkHome: CODELARK_HOME, env: {}, migrate: false });
      assert.equal(runtimeService.get('runtime.agent'), 'codex');
      assert.equal(runtimeService.get('runtime.codex.model'), 'env-runtime-model');
      assert.equal(runtimeService.get('runtime.codex.provider'), 'tmux');
      assert.equal(runtimeService.get('runtime.codex.networkAccess'), true);
      assert.equal(runtimeService.get('bridge.defaultWorkspace'), workspace);

      writeFile(paths.legacyConfigEnv, [
        'CODELARK_CODEX_DEFAULT_MODEL=must-not-affect-running-v2',
        'CODELARK_FEISHU_APP_ID=must-not-affect-running-v2',
      ].join('\n'));
      await stop();
      _testOnly.resetStateForTests();
      await start();

      assert.equal(MigratedConfigAdapter.startedInstances.length, 2);
      assert.equal(MigratedConfigAdapter.startedInstances[1]?.config.appId, 'env-runtime-app');
      assert.equal(
        createConfigService({ codelarkHome: CODELARK_HOME, env: {}, migrate: false }).get('runtime.codex.model'),
        'env-runtime-model',
      );
    } finally {
      await stop();
      _testOnly.resetStateForTests();
      cleanCodelarkHomeConfig(CODELARK_HOME);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
