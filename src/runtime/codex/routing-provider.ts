import type { LLMProvider, StreamChatParams } from '../contracts.js';
import type { PendingPermissions } from '../permission-gateway.js';
import type { RuntimeProviderChoice } from '../../domain/session.js';
import { isRuntimeProviderChoice } from '../../domain/session-runtime.js';
import { ClaudePtyProvider } from '../../runtime/claude/pty-provider.js';
import { ClaudeSdkProvider } from '../../runtime/claude/sdk-provider.js';
import { ClaudeTmuxProvider } from '../../runtime/claude/tmux-provider.js';
import { KimiTmuxProvider } from '../../runtime/kimi/tmux-provider.js';
import { CursorTmuxProvider } from '../../runtime/cursor/tmux-provider.js';
import { CodexProvider } from './provider.js';
import { CodexPtyProvider, shouldUseCodexPtyTui } from './pty-provider.js';
import { CodexTmuxProvider, shouldUseCodexTmuxTui } from './tmux-provider.js';

export type CodexProviderChoice = RuntimeProviderChoice;

function normalizeProviderChoice(value: unknown): CodexProviderChoice | null {
  return isRuntimeProviderChoice(value) ? value : null;
}

export class CodexRoutingProvider implements LLMProvider {
  private readonly sdkProvider: LLMProvider;
  private readonly tmuxProvider: LLMProvider;
  private readonly ptyProvider: LLMProvider;
  private readonly claudePtyProvider: LLMProvider;
  private readonly claudeSdkProvider: LLMProvider;
  private readonly claudeTmuxProvider: LLMProvider;
  private readonly kimiTmuxProvider: LLMProvider;
  private readonly cursorTmuxProvider: LLMProvider;
  private readonly defaultProvider: CodexProviderChoice;

  constructor(pendingPerms?: PendingPermissions, defaultProvider?: CodexProviderChoice) {
    this.sdkProvider = new CodexProvider(pendingPerms);
    this.tmuxProvider = new CodexTmuxProvider(pendingPerms);
    this.ptyProvider = new CodexPtyProvider(pendingPerms);
    this.claudePtyProvider = new ClaudePtyProvider();
    this.claudeSdkProvider = new ClaudeSdkProvider();
    this.claudeTmuxProvider = new ClaudeTmuxProvider();
    this.kimiTmuxProvider = new KimiTmuxProvider();
    this.cursorTmuxProvider = new CursorTmuxProvider();
    this.defaultProvider = defaultProvider
      || (shouldUseCodexPtyTui() ? 'pty' : shouldUseCodexTmuxTui() ? 'tmux' : 'sdk');
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    if (params.runtime === 'cursor') {
      console.log('[codex-routing-provider] Route Cursor Agent request:', {
        bridge_session_id: params.sessionId,
        runtime: params.runtime,
        provider: 'tmux',
      });
      return this.cursorTmuxProvider.streamChat(params);
    }
    if (params.runtime === 'kimi') {
      console.log('[codex-routing-provider] Route Kimi Code request:', {
        bridge_session_id: params.sessionId,
        runtime: params.runtime,
        provider: 'tmux',
      });
      return this.kimiTmuxProvider.streamChat(params);
    }
    if (params.runtime === 'claude') {
      const claudeProvider = normalizeProviderChoice(params.claudeProvider) || 'tmux';
      console.log('[codex-routing-provider] Route Claude Code request:', {
        bridge_session_id: params.sessionId,
        runtime: params.runtime || null,
        executable: params.claudeExecutable || 'claude',
        provider: claudeProvider,
      });
      if (claudeProvider === 'tmux') return this.claudeTmuxProvider.streamChat(params);
      if (claudeProvider === 'pty') return this.claudePtyProvider.streamChat(params);
      return this.claudeSdkProvider.streamChat(params);
    }
    const choice = normalizeProviderChoice(params.codexProvider) || this.defaultProvider;
    console.log('[codex-routing-provider] Route Codex request:', {
      bridge_session_id: params.sessionId,
      runtime: params.runtime || null,
      provider: choice,
      configured_provider: params.codexProvider || null,
      default_provider: this.defaultProvider,
    });
    if (choice === 'tmux') return this.tmuxProvider.streamChat(params);
    if (choice === 'pty') return this.ptyProvider.streamChat(params);
    return this.sdkProvider.streamChat(params);
  }
}
