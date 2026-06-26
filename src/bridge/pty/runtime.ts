import type { BridgeSession } from '../../domain/index.js';
import {
  getSessionActiveRuntime,
  getSessionClaudeSessionId,
  getSessionCodexThreadId,
} from '../../domain/session-runtime.js';
import { capturePtyScreen } from '../../runtime/codex/pty-provider.js';
import { captureClaudePtyScreen } from '../../runtime/claude/pty-provider.js';

export interface RuntimePtyScreenSnapshot {
  screen: string;
  exited: boolean;
  runtime: 'codex' | 'claude';
  provider: 'pty';
  codexThreadId?: string;
  claudeSessionId?: string;
}

export function captureRuntimePtyScreen(session: BridgeSession, lines: number): RuntimePtyScreenSnapshot | null {
  const runtime = getSessionActiveRuntime(session) || 'codex';
  if (runtime === 'claude') {
    const capture = captureClaudePtyScreen(session.id, lines);
    if (!capture) return null;
    return {
      runtime: 'claude',
      provider: 'pty',
      screen: capture.screen,
      exited: capture.exited,
      claudeSessionId: getSessionClaudeSessionId(session),
    };
  }
  if (runtime !== 'codex') return null;
  const capture = capturePtyScreen(session.id, lines);
  if (!capture) return null;
  return {
    runtime: 'codex',
    provider: 'pty',
    screen: capture.screen,
    exited: capture.exited,
    codexThreadId: capture.threadId || getSessionCodexThreadId(session) || undefined,
  };
}
