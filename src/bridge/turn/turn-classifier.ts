import type { BridgeSession } from '../../domain/index.js';
import { getSessionActiveRuntime, getSessionCodexThreadId } from '../../domain/session-runtime.js';
import type { ChannelChat } from '../../domain/index.js';
import type { BridgeTurnClassification } from './turn-types.js';

export type CodexThreadLookup = (threadId: string) => boolean;

type SessionLike = Pick<
  BridgeSession,
  'id' | 'runtime'
>;

type BindingLike = Pick<ChannelChat, 'bridgeSessionId'>;

export function getCodexThreadId(
  session: SessionLike | null | undefined,
  _binding?: BindingLike | null,
): string | undefined {
  return getSessionCodexThreadId(session);
}

export function classifyInteractiveTurn(
  binding: BindingLike,
  session: SessionLike | null | undefined,
  codexThreadLookup?: CodexThreadLookup,
): BridgeTurnClassification {
  const sessionId = session?.id || binding.bridgeSessionId;
  const activeRuntime = getSessionActiveRuntime(session);
  if (activeRuntime === 'claude' || activeRuntime === 'kimi') {
    return {
      kind: 'im_sdk',
      sessionId,
      codexThreadId: undefined,
      codexThreadAvailable: false,
      reason: activeRuntime === 'kimi' ? 'runtime_kimi' : 'runtime_claude',
    };
  }
  const codexThreadId = getCodexThreadId(session, binding);
  if (codexThreadId) {
    const codexThreadAvailable = codexThreadLookup ? codexThreadLookup(codexThreadId) : false;
    if (codexThreadAvailable) {
      return {
        kind: 'im_codex_reuse',
        sessionId,
        codexThreadId,
        codexThreadAvailable,
        reason: 'codex_thread',
      };
    }
    return {
      kind: 'im_sdk',
      sessionId,
      codexThreadId,
      codexThreadAvailable: false,
      reason: 'bridge_thread',
    };
  }

  return {
    kind: 'im_sdk',
    sessionId,
    codexThreadId,
    codexThreadAvailable: false,
    reason: codexThreadId ? 'bridge_thread' : 'new_bridge_thread',
  };
}
