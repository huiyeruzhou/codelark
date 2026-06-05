import type { LLMProvider, StreamChatParams } from '../contracts.js';
import type { PendingPermissions } from '../permission-gateway.js';
import { ClaudePtyProvider } from '../../runtime/claude/pty-provider.js';
import { ClaudeSdkProvider } from '../../runtime/claude/sdk-provider.js';
import { CodexProvider } from './provider.js';
import { CodexPtyProvider, shouldUseCodexPtyTui } from './pty-provider.js';
import { CodexTmuxProvider, shouldUseCodexTmuxTui } from './tmux-provider.js';

export type CodexProviderChoice = 'sdk' | 'tmux' | 'pty';

function normalizeProviderChoice(value: unknown): CodexProviderChoice | null {
  if (value === 'sdk' || value === 'tmux' || value === 'pty') return value;
  return null;
}

export class CodexRoutingProvider implements LLMProvider {
  private readonly sdkProvider: LLMProvider;
  private readonly tmuxProvider: LLMProvider;
  private readonly ptyProvider: LLMProvider;
  private readonly claudePtyProvider: LLMProvider;
  private readonly claudeSdkProvider: LLMProvider;
  private readonly defaultProvider: CodexProviderChoice;

  constructor(pendingPerms?: PendingPermissions, defaultProvider?: CodexProviderChoice) {
    this.sdkProvider = new CodexProvider(pendingPerms);
    this.tmuxProvider = new CodexTmuxProvider(pendingPerms);
    this.ptyProvider = new CodexPtyProvider(pendingPerms);
    this.claudePtyProvider = new ClaudePtyProvider();
    this.claudeSdkProvider = new ClaudeSdkProvider();
    this.defaultProvider = defaultProvider
      || (shouldUseCodexPtyTui() ? 'pty' : shouldUseCodexTmuxTui() ? 'tmux' : 'sdk');
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    if (params.runtime === 'claude') {
      const claudeProvider = params.claudeProvider === 'sdk' ? 'sdk' : 'pty';
      console.log('[codex-routing-provider] Route Claude Code request:', {
        bridge_session_id: params.sessionId,
        runtime: params.runtime || null,
        executable: params.claudeExecutable || 'claude',
        provider: claudeProvider,
      });
      return claudeProvider === 'sdk'
        ? this.claudeSdkProvider.streamChat(params)
        : this.claudePtyProvider.streamChat(params);
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
