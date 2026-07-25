import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { configV2ToLegacyConfig, legacyConfigToConfigPatch } from '../../../configuration/legacy.js';
import { configPatchSchema, type ConfigV2 } from '../../../configuration/schema.js';
import type { Config } from '../../../configuration/legacy-types.js';

function baseConfigV2(): ConfigV2 {
  return {
    schemaVersion: 2,
    session: {
      workspace: '~',
      tmuxCaptureLines: 80,
      tmuxAutoEnter: true,
      tmuxEchoInput: false,
    },
    runtime: {
      agent: 'claude',
      codex: {
        model: 'gpt-test',
        yoloMode: 'on',
        provider: 'tmux',
        skipGitRepoCheck: true,
        sandboxMode: 'danger-full-access',
        networkAccess: false,
        reasoningEffort: 'high',
      },
      claude: {
        model: 'claude-test',
        yoloMode: 'off',
        provider: 'pty',
        executable: 'ccr',
        reasoningEffort: 'medium',
        idleTimeoutMinutes: 12,
      },
      kimi: {
        model: '',
        provider: 'tmux',
      },
    },
    bridge: {
      defaultWorkspace: '~',
      uiAllowLan: true,
      uiAccessToken: 'ui-token',
    },
    channels: [{
      id: 'feishu-default',
      alias: '飞书',
      provider: 'feishu',
      enabled: true,
      config: {
        historyMessageLimit: 12,
        streamStatusIdleStartSeconds: 240,
        streamStatusCheckIntervalSeconds: 15,
        appId: 'app-id',
        appSecret: 'app-secret',
        site: 'lark',
        allowedUsers: ['u1', 'u2'],
        streamingEnabled: false,
        feedbackMarkdownEnabled: true,
        requireMention: true,
        groupAuthorized: false,
      },
    }],
  };
}

describe('legacy config compatibility adapter', () => {
  it('maps v2 effective config to the old expanded Config shape without changing legacy runtime values', () => {
    const legacy = configV2ToLegacyConfig(baseConfigV2());

    assert.equal(legacy.schemaVersion, 2);
    assert.equal(legacy.runtime, 'claude');
    assert.equal(legacy.defaultWorkspaceRoot, os.homedir());
    assert.equal(legacy.defaultModel, 'gpt-test');
    assert.equal(legacy.defaultProvider, 'tmux');
    assert.equal(legacy.defaultMode, 'yolo');
    assert.equal(legacy.codexSandboxMode, 'danger-full-access');
    assert.equal(legacy.codexNetworkAccess, false);
    assert.equal(legacy.codexReasoningEffort, 'high');
    assert.equal(legacy.claudeDefaultModel, 'claude-test');
    assert.equal(legacy.historyMessageLimit, 12);
    assert.equal(legacy.channels?.[0]?.config.appId, 'app-id');
    assert.deepEqual(legacy.enabledChannels, ['feishu']);
  });

  it('maps old Config writes to a v2 patch for fields with confirmed semantics', () => {
    const legacy: Config = {
      runtime: 'codex',
      defaultWorkspaceRoot: '/workspace',
      defaultModel: 'gpt-test',
      defaultProvider: 'sdk',
      defaultMode: 'normal',
      historyMessageLimit: 10,
      streamStatusIdleStartSeconds: 300,
      streamStatusCheckIntervalSeconds: 20,
      codexSkipGitRepoCheck: false,
      codexSandboxMode: 'read-only',
      codexNetworkAccess: true,
      codexReasoningEffort: 'minimal',
      claudeDefaultModel: 'claude-test',
      claudeProvider: 'sdk',
      claudeExecutable: 'claude',
      claudeIdleTimeoutMinutes: 0,
      uiAllowLan: false,
      uiAccessToken: 'token',
      enabledChannels: ['feishu'],
      channels: [{
        id: 'feishu-default',
        alias: '飞书',
        provider: 'feishu',
        enabled: true,
        createdAt: '2026-06-06T00:00:00.000Z',
        updatedAt: '2026-06-06T00:00:00.000Z',
        config: {
          appId: 'app-id',
          appSecret: 'app-secret',
          site: 'feishu',
          allowedUsers: ['u1'],
          streamingEnabled: true,
          feedbackMarkdownEnabled: false,
          requireMention: true,
        },
      }],
    };

    const patch = configPatchSchema.parse(legacyConfigToConfigPatch(legacy));
    assert.equal(patch.runtime?.agent, 'codex');
    assert.equal(patch.runtime?.codex?.yoloMode, 'off');
    assert.equal(patch.runtime?.codex?.provider, 'sdk');
    assert.equal(patch.bridge?.defaultWorkspace, '/workspace');
    assert.equal(patch.channels?.[0]?.config?.historyMessageLimit, 10);
    assert.equal(patch.channels?.[0]?.config?.streamStatusIdleStartSeconds, 300);
    assert.equal(patch.channels?.[0]?.config?.streamStatusCheckIntervalSeconds, 20);
    assert.equal(patch.channels?.[0]?.config?.appSecret, 'app-secret');
  });

  it('materializes partial legacy channel config into a valid v2 channel patch', () => {
    const legacy: Config = {
      runtime: 'codex',
      defaultMode: 'normal',
      enabledChannels: ['feishu'],
      channels: [{
        id: 'feishu',
        alias: '飞书',
        provider: 'feishu',
        enabled: true,
        createdAt: '2026-06-06T00:00:00.000Z',
        updatedAt: '2026-06-06T00:00:00.000Z',
        config: {
          appId: 'app-id',
          appSecret: 'app-secret',
        },
      }],
    };

    const patch = configPatchSchema.parse(legacyConfigToConfigPatch(legacy));
    assert.equal(patch.channels?.[0]?.config?.appId, 'app-id');
    assert.equal(patch.channels?.[0]?.config?.historyMessageLimit, 8);
    assert.equal(patch.channels?.[0]?.config?.streamStatusIdleStartSeconds, 0);
    assert.equal(patch.channels?.[0]?.config?.streamStatusCheckIntervalSeconds, 5);
    assert.equal(patch.channels?.[0]?.config?.site, 'feishu');
    assert.deepEqual(patch.channels?.[0]?.config?.allowedUsers, []);
    assert.equal(patch.channels?.[0]?.config?.streamingEnabled, true);
    assert.equal(patch.channels?.[0]?.config?.feedbackMarkdownEnabled, true);
    assert.equal(patch.channels?.[0]?.config?.requireMention, false);
  });

  it('materializes the default channel when old global channel behavior fields are saved without channels', () => {
    const legacy: Config = {
      runtime: 'codex',
      defaultMode: 'normal',
      historyMessageLimit: 12,
      enabledChannels: [],
    };

    const patch = configPatchSchema.parse(legacyConfigToConfigPatch(legacy));
    assert.equal(patch.channels?.[0]?.id, 'feishu-default');
    assert.equal(patch.channels?.[0]?.enabled, false);
    assert.equal(patch.channels?.[0]?.config?.historyMessageLimit, 12);
    assert.equal(patch.channels?.[0]?.config?.streamStatusIdleStartSeconds, 0);
    assert.equal(patch.channels?.[0]?.config?.streamStatusCheckIntervalSeconds, 5);
  });

});
