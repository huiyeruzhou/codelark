import type { BridgeSession } from '../../domain/index.js';
import {
  getSessionActiveRuntime,
  getSessionClaudeSessionId,
} from '../../domain/session-runtime.js';
import { captureClaudePtyScreen } from '../../runtime/claude/pty-provider.js';

export interface RuntimePtyScreenSnapshot {
  screen: string;
  exited: boolean;
  runtime: 'claude';
  provider: 'pty';
  claudeSessionId?: string;
}

export function captureRuntimePtyScreen(session: BridgeSession, lines: number): RuntimePtyScreenSnapshot | null {
  const runtime = getSessionActiveRuntime(session) || 'codex';
  if (runtime !== 'claude') return null;
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
