import type { ChannelChat, OutboundRichCard } from '../../../domain/index.js';
import type { ThreadCardScope } from '../../command/thread-display.js';

export interface SessionCommandDeps {
  getActiveTask(sessionId: string): { abortController: AbortController } | undefined;
  forceStopSession?(sessionId: string, detail?: string): Promise<boolean>;
  recordInteractiveHealthEnd?(sessionId: string, outcome: 'completed' | 'failed' | 'aborted', detail?: string): void;
  reconcileMirrorSubscriptions?(): Promise<void>;
  onBindingRemoved?(binding: ChannelChat): void;
  threadCardRefreshScope?: ThreadCardScope | null;
  threadCardSelectedId?: string | null;
}

export interface SessionCommandResult {
  response: string;
  richCard?: OutboundRichCard;
  threadTableCardScope?: ThreadCardScope;
}

export async function reconcileMirrorSubscriptionsBestEffort(
  deps: SessionCommandDeps,
  context: string,
): Promise<void> {
  if (!deps.reconcileMirrorSubscriptions) return;
  try {
    await deps.reconcileMirrorSubscriptions();
  } catch (error) {
    console.error(`[session-command-use-case] Mirror reconcile failed during ${context}:`, error);
  }
}
