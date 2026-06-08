import type { LLMProvider, StreamChatParams } from '../contracts.js';
import { sseEvent } from '../sse.js';
import {
  claudeTmuxSessionName,
  startClaudeTmuxSession,
  tmuxCore,
} from '../../bridge/tmux/runtime.js';
import { findLatestClaudeSessionJsonlUpdatedAfter } from './pty-provider.js';

const DEFAULT_CLAUDE_TMUX_PROMPT_DELAY_MS = 1_000;
const DEFAULT_CLAUDE_TMUX_RESPONSE_QUIET_MS = 1_500;
const DEFAULT_CLAUDE_TMUX_RESPONSE_TIMEOUT_MS = 45_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveIntEnv(name: string, fallback: number, minValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= minValue) return Math.floor(parsed);
  return fallback;
}

async function waitForQuietTmuxScreen(sessionName: string): Promise<string> {
  const quietMs = parsePositiveIntEnv('CODELARK_CLAUDE_TMUX_RESPONSE_QUIET_MS', DEFAULT_CLAUDE_TMUX_RESPONSE_QUIET_MS, 250);
  const timeoutMs = parsePositiveIntEnv('CODELARK_CLAUDE_TMUX_RESPONSE_TIMEOUT_MS', DEFAULT_CLAUDE_TMUX_RESPONSE_TIMEOUT_MS, 1_000);
  const deadline = Date.now() + timeoutMs;
  let lastScreen = '';
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await sleep(250);
    const capture = await tmuxCore.capturePane(sessionName, 120);
    if (capture.screen !== lastScreen) {
      lastScreen = capture.screen;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= quietMs) break;
  }
  return lastScreen;
}

export function streamClaudeTmuxTui(params: StreamChatParams): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      (async () => {
        const cwd = params.workingDirectory || process.cwd();
        const sessionName = claudeTmuxSessionName(params.claudeSessionId || params.sessionId);
        const abortListener = () => {
          tmuxCore.sendInterrupt(sessionName).catch(() => null);
        };
        try {
          controller.enqueue(sseEvent('status', {
            tmux_session: sessionName,
            provider: 'tmux',
          }));
          await startClaudeTmuxSession({
            sessionName,
            bridgeSessionId: params.sessionId,
            workingDirectory: cwd,
            executable: params.claudeExecutable,
            model: params.model,
            permissionMode: params.claudePermissionMode,
            reasoningEffort: params.claudeReasoningEffort,
          });
          params.abortController?.signal.addEventListener('abort', abortListener, { once: true });
          const promptDelayMs = parsePositiveIntEnv('CODELARK_CLAUDE_TMUX_PROMPT_DELAY_MS', DEFAULT_CLAUDE_TMUX_PROMPT_DELAY_MS, 0);
          if (promptDelayMs > 0) await sleep(promptDelayMs);
          const promptStartedAtMs = Date.now();
          await tmuxCore.injectPromptIntoPane(sessionName, params.prompt);
          const screen = await waitForQuietTmuxScreen(sessionName);
          const claudeJsonlSession = findLatestClaudeSessionJsonlUpdatedAfter(cwd, promptStartedAtMs);
          controller.enqueue(sseEvent('text', screen || '(Claude Code tmux has not produced visible output yet.)'));
          controller.enqueue(sseEvent('result', {
            ...(claudeJsonlSession?.sessionId || params.claudeSessionId
              ? { session_id: claudeJsonlSession?.sessionId || params.claudeSessionId }
              : {}),
            ...(claudeJsonlSession?.cwd || params.claudeSessionId ? { cwd: claudeJsonlSession?.cwd || cwd } : {}),
            ...(claudeJsonlSession?.filePath ? { transcript_path: claudeJsonlSession.filePath } : {}),
            tmux_session: sessionName,
          }));
          controller.close();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[claude-tmux] Error:', error instanceof Error ? error.stack || error.message : error);
          try {
            controller.enqueue(sseEvent('error', message || 'Claude tmux execution failed.'));
            controller.close();
          } catch {
            // Controller may already be closed.
          }
        } finally {
          params.abortController?.signal.removeEventListener('abort', abortListener);
        }
      })();
    },
  });
}

export class ClaudeTmuxProvider implements LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string> {
    return streamClaudeTmuxTui(params);
  }
}
