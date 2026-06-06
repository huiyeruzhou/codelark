import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveClaudeRuntimeConfig, resolveSessionRuntimeConfig } from '../../../bridge/session/support.js';
import {
  clearSessionCodexNetworkAccessUpdate,
  clearSessionCodexSandboxModeUpdate,
  getSessionActiveRuntime,
  getSessionClaudeModel,
  getSessionClaudePermissionMode,
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
  setSessionClaudeModelUpdate,
  setSessionClaudePermissionModeUpdate,
  setSessionClaudeProviderUpdate,
  setSessionClaudeSessionIdUpdate,
  setSessionCodexModeUpdate,
  setSessionCodexNetworkAccessUpdate,
  setSessionCodexReasoningEffortUpdate,
  setSessionCodexSandboxModeUpdate,
  setSessionCodexTmuxProviderUpdate,
  setSessionTmuxAutoEnterUpdate,
  setSessionTmuxCaptureLinesUpdate,
  setSessionTmuxEchoInputUpdate,
  setSessionTmuxSessionNameUpdate,
} from '../../../domain/session-runtime.js';
import type { BridgeSession } from '../../../domain/index.js';
import { initBridgeTestContext } from '../../helpers/bridge/test-bridge-utils.js';

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
          permissionMode: 'plan',
        },
        general: { tmuxSessionName: 'nested-tmux' },
      },
    } as unknown as BridgeSession);

    assert.equal(getSessionActiveRuntime(session), 'claude');
    assert.equal(getSessionClaudeSessionId(session), 'claude-session');
    assert.equal(getSessionClaudeModel(session), 'claude-model');
    assert.equal(getSessionClaudeProvider(session), 'sdk');
    assert.equal(getSessionClaudePermissionMode(session), 'plan');
    assert.equal(session.runtime?.codex, undefined);
    assert.equal(getSessionCodexThreadId(session), undefined);
    assert.equal(getSessionCodexModel(session), undefined);
    assert.equal(getSessionCodexProvider(session), undefined);
    assert.equal(getSessionCodexSandboxMode(session), undefined);
    assert.equal(getSessionCodexNetworkAccess(session), undefined);
    assert.equal(getSessionCodexReasoningEffort(session), undefined);
    assert.equal(getSessionTmuxSessionName(session), 'nested-tmux');
  });

  it('resolves Claude runtime config from Claude-specific provider state', () => {
    initBridgeTestContext({
      settings: new Map([
        ['bridge_claude_provider', 'sdk'],
        ['bridge_claude_executable', 'ccr'],
        ['bridge_claude_default_model', 'claude-global'],
        ['bridge_claude_permission_mode', 'default'],
      ]),
    });

    const session: BridgeSession = {
      id: 'session-claude-runtime-config',
      runtime: {
        activeRuntime: 'claude',
        claude: {
          provider: 'pty',
          model: 'claude-session',
          permissionMode: 'plan',
          reasoningEffort: 'high',
        },
      },
    };

    const resolved = resolveClaudeRuntimeConfig(session);

    assert.equal(resolved.provider, 'pty');
    assert.equal(resolved.executable, 'ccr');
    assert.equal(resolved.model, 'claude-session');
    assert.equal(resolved.permissionMode, 'plan');
    assert.equal(resolved.reasoningEffort, 'high');
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

  it('resolves Codex runtime config from Codex-specific session state only', () => {
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

    assert.equal(resolved.model, 'codex-session');
    assert.equal(resolved.mode, 'yolo');
    assert.equal(resolved.codexProvider, 'tmux');
    assert.equal(resolved.sandboxMode, 'danger-full-access');
    assert.equal(resolved.networkAccessEnabled, false);
    assert.equal(resolved.reasoningEffort, 'high');
    assert.equal(resolved.skipGitRepoCheck, true);
  });

  it('centralizes update payloads for the runtime storage schema', () => {
    assert.deepEqual(setSessionActiveRuntimeUpdate('claude'), { runtime: { activeRuntime: 'claude' } });
    assert.deepEqual(setSessionClaudeSessionIdUpdate('claude-1'), { runtime: { activeRuntime: 'claude', claude: { sessionId: 'claude-1' } } });
    assert.deepEqual(setSessionClaudeModelUpdate('sonnet'), { runtime: { activeRuntime: 'claude', claude: { model: 'sonnet' } } });
    assert.deepEqual(setSessionClaudeProviderUpdate('sdk'), { runtime: { activeRuntime: 'claude', claude: { provider: 'sdk' } } });
    assert.deepEqual(setSessionClaudePermissionModeUpdate('bypassPermissions'), { runtime: { activeRuntime: 'claude', claude: { permissionMode: 'bypassPermissions' } } });
    assert.deepEqual(setSessionCodexModeUpdate('yolo'), { runtime: { codex: { mode: 'yolo' } } });
    assert.deepEqual(setSessionCodexReasoningEffortUpdate('high'), { runtime: { codex: { reasoningEffort: 'high' } } });
    assert.deepEqual(setSessionCodexSandboxModeUpdate('read-only'), { runtime: { codex: { sandboxMode: 'read-only' } } });
    assert.deepEqual(clearSessionCodexSandboxModeUpdate(), { runtime: { codex: { sandboxMode: undefined } } });
    assert.deepEqual(setSessionCodexNetworkAccessUpdate(false), { runtime: { codex: { networkAccess: false } } });
    assert.deepEqual(clearSessionCodexNetworkAccessUpdate(), { runtime: { codex: { networkAccess: undefined } } });
    assert.deepEqual(setSessionCodexTmuxProviderUpdate({
      tmuxSessionName: 'clk-thread',
      autoEnter: true,
      threadId: 'thread-1',
    }), {
      runtime: {
        codex: {
          provider: 'tmux',
          threadId: 'thread-1',
        },
        general: {
          tmuxSessionName: 'clk-thread',
          autoEnter: true,
        },
      },
    });
    assert.deepEqual(setSessionTmuxSessionNameUpdate('manual'), { runtime: { general: { tmuxSessionName: 'manual' } } });
    assert.deepEqual(setSessionTmuxCaptureLinesUpdate(120), { runtime: { general: { captureLines: 120 } } });
    assert.deepEqual(setSessionTmuxAutoEnterUpdate(false), { runtime: { general: { autoEnter: false } } });
    assert.deepEqual(setSessionTmuxEchoInputUpdate(true), { runtime: { general: { echoInput: true } } });
  });

});
