import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  getHistoryMessageLimit,
  getWorkspaceRoot,
  resolveClaudeRuntimeConfig,
  resolveDisplayedModel,
  resolveEffectiveCodexProvider,
  resolveEffectiveNetworkAccess,
  resolveEffectiveReasoningEffort,
  resolveEffectiveSandboxMode,
  resolveSessionRuntimeConfig,
} from '../../../bridge/session/support.js';
import { CODELARK_HOME } from '../../../configuration/paths.js';
import {
  getSessionActiveRuntime,
  getSessionClaudeModel,
  getSessionClaudeProvider,
  getSessionClaudeSessionId,
  getSessionCodexModel,
  getSessionCodexNetworkAccess,
  getSessionCodexProvider,
  getSessionCodexReasoningEffort,
  getSessionCodexSandboxMode,
  getSessionCodexThreadId,
  getSessionRuntimeProviderIdentity,
  getSessionTmuxSessionName,
  materializeBridgeSessionRuntime,
  setSessionClaudeTmuxProviderUpdate,
  setSessionActiveRuntimeUpdate,
  setSessionClaudeSessionIdUpdate,
  setSessionCodexTmuxProviderUpdate,
} from '../../../domain/session-runtime.js';
import type { BridgeSession } from '../../../domain/index.js';
import { initBridgeTestContext } from '../../helpers/bridge/test-bridge-utils.js';

const configTomlPath = path.join(CODELARK_HOME, 'config.toml');

describe('BridgeSession runtime accessors', () => {
  it('keeps Claude and Codex runtime containers mutually exclusive', () => {
    const session = materializeBridgeSessionRuntime({
      id: 'session-runtime-nested',
      runtime: {
        activeRuntime: 'claude',
        codex: {
          threadId: 'nested-thread',
          model: 'nested-model',
          provider: 'tmux',
          sandboxMode: 'read-only',
          networkAccess: true,
          reasoningEffort: 'high',
        },
        claude: {
          sessionId: ' claude-session ',
          model: 'claude-model',
          provider: 'sdk',
        },
        general: { tmuxSessionName: 'nested-tmux' },
      },
    } as unknown as BridgeSession);

    assert.equal(getSessionActiveRuntime(session), 'claude');
    assert.equal(getSessionClaudeSessionId(session), 'claude-session');
    assert.equal(getSessionClaudeModel(session), undefined);
    assert.equal(getSessionClaudeProvider(session), undefined);
    assert.equal(session.runtime?.codex, undefined);
    assert.equal(getSessionCodexThreadId(session), undefined);
    assert.equal(getSessionCodexModel(session), undefined);
    assert.equal(getSessionCodexProvider(session), undefined);
    assert.equal(getSessionCodexSandboxMode(session), undefined);
    assert.equal(getSessionCodexNetworkAccess(session), undefined);
    assert.equal(getSessionCodexReasoningEffort(session), undefined);
    assert.equal(getSessionTmuxSessionName(session), 'nested-tmux');
  });

  it('ignores stale Claude provider JSON and resolves config fields from v2', () => {
    const previousToml = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf-8') : null;
    try {
      fs.mkdirSync(CODELARK_HOME, { recursive: true });
      fs.writeFileSync(configTomlPath, `
schema_version = 2

[runtime.claude]
provider = "sdk"
executable = "ccr"
model = "claude-global"
`);
      initBridgeTestContext({ settings: new Map() });

      const session: BridgeSession = {
        id: 'session-claude-runtime-config',
        runtime: {
          activeRuntime: 'claude',
          claude: {
            provider: 'pty',
            model: 'claude-session',
            reasoningEffort: 'high',
          },
        },
      };

      const resolved = resolveClaudeRuntimeConfig(session);

      assert.equal(resolved.provider, 'sdk');
      assert.equal(resolved.executable, 'ccr');
      assert.equal(resolved.model, 'claude-global');
      assert.equal(resolved.permissionMode, 'default');
      assert.equal(resolved.reasoningEffort, 'medium');
    } finally {
      if (previousToml === null) fs.rmSync(configTomlPath, { force: true });
      else fs.writeFileSync(configTomlPath, previousToml, 'utf-8');
    }
  });

  it('uses symmetric runtime provider identities for Codex and Claude tmux', () => {
    assert.equal(getSessionRuntimeProviderIdentity({
      id: 'session-codex-tmux-identity',
      runtime: { codex: { provider: 'tmux' } },
    } as BridgeSession), 'codex:tmux');

    assert.equal(getSessionRuntimeProviderIdentity({
      id: 'session-claude-tmux-identity',
      runtime: { activeRuntime: 'claude', claude: { provider: 'tmux' } },
    } as BridgeSession), 'claude:tmux');

    assert.deepEqual(setSessionClaudeTmuxProviderUpdate({
      tmuxSessionName: 'claude_session',
      autoEnter: true,
      sessionId: 'claude-thread',
      cwd: '/tmp/project',
    }), {
      runtime: {
        activeRuntime: 'claude',
        claude: {
          provider: 'tmux',
          sessionId: 'claude-thread',
          cwd: '/tmp/project',
        },
        general: {
          tmuxSessionName: 'claude_session',
          autoEnter: true,
        },
      },
    });
  });

  it('defaults Claude runtime provider to tmux when no session or global provider is configured', () => {
    initBridgeTestContext({ settings: new Map() });

    const resolved = resolveClaudeRuntimeConfig({
      id: 'session-claude-runtime-default-provider',
      runtime: { activeRuntime: 'claude' },
    });

    assert.equal(resolved.provider, 'tmux');
  });

  it('ignores stale Codex provider JSON and resolves config fields from v2', () => {
    initBridgeTestContext({
      settings: new Map([
        ['remote_bridge_enabled', 'true'],
        ['bridge_default_model', 'codex-global'],
        ['bridge_default_mode', 'normal'],
        ['bridge_default_provider', 'sdk'],
        ['bridge_codex_sandbox_mode', 'workspace-write'],
        ['bridge_codex_network_access', 'false'],
        ['bridge_codex_reasoning_effort', 'medium'],
        ['bridge_codex_skip_git_repo_check', 'true'],
      ]),
    });

    const session: BridgeSession = {
      id: 'session-runtime-config',
      runtime: {
        general: {
          workingDirectory: '/tmp/runtime',
        },
        codex: {
          model: 'codex-session',
          mode: 'yolo',
          provider: 'tmux',
          sandboxMode: 'read-only',
          networkAccess: false,
          reasoningEffort: 'high',
        },
      },
    };

    const resolved = resolveSessionRuntimeConfig(null, session);

    assert.equal(resolved.model, '');
    assert.equal(resolved.mode, 'normal');
    assert.equal(resolved.codexProvider, 'tmux');
    assert.equal(resolved.sandboxMode, 'workspace-write');
    assert.equal(resolved.networkAccessEnabled, true);
    assert.equal(resolved.reasoningEffort, 'medium');
    assert.equal(resolved.skipGitRepoCheck, true);
  });

  it('resolves global runtime fallback from home TOML before legacy store settings', () => {
    const previousToml = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf-8') : null;
    try {
      fs.mkdirSync(CODELARK_HOME, { recursive: true });
      fs.writeFileSync(configTomlPath, `
schema_version = 2

[bridge]
default_workspace = "/tmp/toml-workspace"

[runtime.codex]
model = "toml-codex"
yolo_mode = "off"
provider = "pty"
skip_git_repo_check = false
sandbox_mode = "read-only"
network_access = true
reasoning_effort = "high"

[runtime.claude]
model = "toml-claude"
yolo_mode = "on"
provider = "pty"
executable = "ccr"
idle_timeout_minutes = 17

[[channels]]
id = "feishu-default"
alias = "飞书"
provider = "feishu"
enabled = true

[channels.config]
history_message_limit = 13
stream_status_idle_start_seconds = 180
stream_status_check_interval_seconds = 10
app_id = ""
app_secret = ""
site = "feishu"
allowed_users = []
streaming_enabled = true
feedback_markdown_enabled = true
require_mention = false
`);
      initBridgeTestContext({
        settings: new Map([
          ['bridge_default_workspace_root', '/tmp/store-workspace'],
          ['bridge_default_model', 'store-codex'],
          ['bridge_default_provider', 'tmux'],
          ['bridge_codex_skip_git_repo_check', 'true'],
          ['bridge_codex_sandbox_mode', 'danger-full-access'],
          ['bridge_codex_network_access', 'false'],
          ['bridge_codex_reasoning_effort', 'low'],
          ['bridge_claude_provider', 'sdk'],
          ['bridge_claude_executable', 'claude'],
          ['bridge_claude_default_model', 'store-claude'],
          ['bridge_claude_idle_timeout_minutes', '5'],
          ['bridge_history_message_limit', '4'],
        ]),
      });

      const codex = resolveSessionRuntimeConfig(null, { id: 'session-global-toml', runtime: {} } as BridgeSession);
      const claude = resolveClaudeRuntimeConfig({ id: 'session-global-toml-claude', runtime: { activeRuntime: 'claude' } });

      assert.equal(getWorkspaceRoot(), '/tmp/toml-workspace');
      assert.equal(codex.model, 'toml-codex');
      assert.equal(codex.codexProvider, 'pty');
      assert.equal(codex.sandboxMode, 'read-only');
      assert.equal(codex.networkAccessEnabled, true);
      assert.equal(codex.reasoningEffort, 'high');
      assert.equal(codex.skipGitRepoCheck, false);
      assert.equal(claude.provider, 'pty');
      assert.equal(claude.executable, 'ccr');
      assert.equal(claude.model, 'toml-claude');
      assert.equal(claude.permissionMode, 'bypassPermissions');
      assert.equal(claude.idleTimeoutMinutes, 17);
      assert.equal(getHistoryMessageLimit(), 13);
    } finally {
      if (previousToml === null) fs.rmSync(configTomlPath, { force: true });
      else fs.writeFileSync(configTomlPath, previousToml, 'utf-8');
    }
  });

  it('does not read global runtime fallback from legacy store settings', () => {
    const previousToml = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf-8') : null;
    try {
      fs.rmSync(configTomlPath, { force: true });
      initBridgeTestContext({
        settings: new Map([
          ['bridge_default_workspace_root', '/tmp/store-workspace'],
          ['bridge_default_model', 'store-codex'],
          ['bridge_default_provider', 'tmux'],
          ['bridge_codex_sandbox_mode', 'danger-full-access'],
          ['bridge_codex_network_access', 'false'],
          ['bridge_codex_reasoning_effort', 'low'],
          ['bridge_claude_executable', 'ccr'],
          ['bridge_history_message_limit', '4'],
        ]),
      });

      const codex = resolveSessionRuntimeConfig(null, { id: 'session-global-store-ignored', runtime: {} } as BridgeSession);
      const claude = resolveClaudeRuntimeConfig({ id: 'session-global-store-ignored-claude', runtime: { activeRuntime: 'claude' } });

      assert.equal(getWorkspaceRoot(), process.env.HOME);
      assert.equal(codex.model, '');
      assert.equal(codex.codexProvider, 'tmux');
      assert.equal(codex.sandboxMode, 'workspace-write');
      assert.equal(codex.networkAccessEnabled, true);
      assert.equal(codex.reasoningEffort, 'medium');
      assert.equal(claude.executable, 'claude');
      assert.equal(getHistoryMessageLimit(), 8);
    } finally {
      if (previousToml === null) fs.rmSync(configTomlPath, { force: true });
      else fs.writeFileSync(configTomlPath, previousToml, 'utf-8');
    }
  });

  it('resolves effective runtime config with channel and session TOML overlays', () => {
    const channelTomlPath = path.join(CODELARK_HOME, 'config', 'channels', 'feishu-default.toml');
    const sessionTomlPath = path.join(CODELARK_HOME, 'config', 'sessions', 'session-scoped-runtime.toml');
    fs.mkdirSync(path.dirname(channelTomlPath), { recursive: true });
    fs.mkdirSync(path.dirname(sessionTomlPath), { recursive: true });
    fs.writeFileSync(channelTomlPath, `
[runtime.codex]
model = "channel-codex"
provider = "pty"
sandbox_mode = "read-only"
network_access = false
reasoning_effort = "high"

[runtime.claude]
model = "channel-claude"
provider = "pty"
yolo_mode = "on"
reasoning_effort = "xhigh"
`);
    fs.writeFileSync(sessionTomlPath, `
[runtime.codex]
model = "session-codex"
reasoning_effort = "low"
`);

    const binding = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      bridgeSessionId: 'session-scoped-runtime',
    } as any;
    const session = { id: 'session-scoped-runtime', runtime: { activeRuntime: 'claude' } } as BridgeSession;

    const codex = resolveSessionRuntimeConfig(binding, session);
    const claude = resolveClaudeRuntimeConfig(session, binding);

    assert.equal(codex.model, 'session-codex');
    assert.equal(codex.codexProvider, 'pty');
    assert.equal(codex.sandboxMode, 'read-only');
    assert.equal(codex.networkAccessEnabled, false);
    assert.equal(codex.reasoningEffort, 'low');
    assert.equal(resolveDisplayedModel(binding, session), 'session-codex');
    assert.equal(resolveEffectiveCodexProvider(session, binding), 'pty');
    assert.equal(resolveEffectiveSandboxMode(session, binding), 'read-only');
    assert.equal(resolveEffectiveNetworkAccess(session, binding), false);
    assert.equal(resolveEffectiveReasoningEffort(session, binding), 'low');
    assert.equal(claude.model, 'channel-claude');
    assert.equal(claude.provider, 'pty');
    assert.equal(claude.permissionMode, 'bypassPermissions');
    assert.equal(claude.reasoningEffort, 'xhigh');

    const legacyProviderBinding = {
      ...binding,
      channelType: 'feishu',
    };
    assert.equal(resolveEffectiveCodexProvider(session, legacyProviderBinding), 'pty');
    assert.equal(resolveEffectiveSandboxMode(session, legacyProviderBinding), 'read-only');
    assert.equal(resolveClaudeRuntimeConfig(session, legacyProviderBinding).model, 'channel-claude');
  });

  it('derives Claude permission mode from scoped yoloMode', () => {
    const channelTomlPath = path.join(CODELARK_HOME, 'config', 'channels', 'feishu-yolo.toml');
    fs.mkdirSync(path.dirname(channelTomlPath), { recursive: true });
    fs.writeFileSync(channelTomlPath, `
[runtime.claude]
yolo_mode = "on"
`);

    const binding = {
      channelType: 'feishu-yolo',
      channelProvider: 'feishu',
      bridgeSessionId: 'session-claude-yolo',
    } as any;
    const session = { id: 'session-claude-yolo', runtime: { activeRuntime: 'claude' } } as BridgeSession;

    assert.equal(resolveClaudeRuntimeConfig(session, binding).permissionMode, 'bypassPermissions');
  });

  it('centralizes update payloads for the runtime storage schema', () => {
    assert.deepEqual(setSessionActiveRuntimeUpdate('claude'), { runtime: { activeRuntime: 'claude' } });
    assert.deepEqual(setSessionClaudeSessionIdUpdate('claude-1'), { runtime: { activeRuntime: 'claude', claude: { sessionId: 'claude-1' } } });
    assert.deepEqual(setSessionCodexTmuxProviderUpdate({
      tmuxSessionName: 'clk-thread',
      autoEnter: true,
      threadId: 'thread-1',
    }), {
      runtime: {
        codex: {
          threadId: 'thread-1',
        },
        general: {
          tmuxSessionName: 'clk-thread',
        },
      },
    });
  });

});
