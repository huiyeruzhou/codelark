import type { LLMProvider, StreamChatParams } from '../contracts.js';
import type { PendingPermissions } from '../permission-gateway.js';
import type { RuntimeProviderChoice } from '../../domain/session.js';
import { isRuntimeProviderChoice } from '../../domain/session-runtime.js';
import { ClaudePtyProvider } from '../../runtime/claude/pty-provider.js';
import { ClaudeSdkProvider } from '../../runtime/claude/sdk-provider.js';
import { ClaudeTmuxProvider } from '../../runtime/claude/tmux-provider.js';
import { KimiTmuxProvider } from '../../runtime/kimi/tmux-provider.js';
import { CursorTmuxProvider } from '../../runtime/cursor/tmux-provider.js';
import { CursorDesktopProvider } from '../../runtime/cursor/desktop-provider.js';
import { ZcodeTmuxProvider } from '../../runtime/zcode/tmux-provider.js';
import { CodexTmuxProvider } from './tmux-provider.js';
import { streamCodexAppServer } from './app-server-provider.js';

function normalizeProviderChoice(value: unknown): RuntimeProviderChoice | null {
  return isRuntimeProviderChoice(value) ? value : null;
}

export class CodexRoutingProvider implements LLMProvider {
  private readonly tmuxProvider: LLMProvider;
  private readonly claudePtyProvider: LLMProvider;
  private readonly claudeSdkProvider: LLMProvider;
  private readonly claudeTmuxProvider: LLMProvider;
  private readonly kimiTmuxProvider: LLMProvider;
  private readonly cursorTmuxProvider: LLMProvider;
  private readonly cursorDesktopProvider: LLMProvider;
  private readonly zcodeTmuxProvider: LLMProvider;

  constructor(pendingPerms?: PendingPermissions, _legacyDefaultProvider?: unknown) {
    this.tmuxProvider = new CodexTmuxProvider(pendingPerms);
    this.claudePtyProvider = new ClaudePtyProvider(pendingPerms);
    this.claudeSdkProvider = new ClaudeSdkProvider();
    this.claudeTmuxProvider = new ClaudeTmuxProvider(pendingPerms);
    this.kimiTmuxProvider = new KimiTmuxProvider();
    this.cursorTmuxProvider = new CursorTmuxProvider();
    this.cursorDesktopProvider = new CursorDesktopProvider();
    this.zcodeTmuxProvider = new ZcodeTmuxProvider();
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    if (params.runtime === 'zcode') {
      console.log('[codex-routing-provider] Route ZCode request:', {
        bridge_session_id: params.sessionId,
        runtime: params.runtime,
        provider: 'tmux',
      });
      return this.zcodeTmuxProvider.streamChat(params);
    }
    if (params.runtime === 'cursor') {
      const cursorProvider = params.cursorProvider === 'desktop' ? 'desktop' : 'tmux';
      console.log('[codex-routing-provider] Route Cursor Agent request:', {
        bridge_session_id: params.sessionId,
        runtime: params.runtime,
        provider: cursorProvider,
      });
      return cursorProvider === 'desktop'
        ? this.cursorDesktopProvider.streamChat(params)
        : this.cursorTmuxProvider.streamChat(params);
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
    console.log('[codex-routing-provider] Route Codex request:', {
      bridge_session_id: params.sessionId,
      runtime: params.runtime || null,
      provider: 'tmux',
      configured_provider: params.codexProvider || null,
    });
    return streamCodexAppServer(params, this.tmuxProvider);
  }
}
