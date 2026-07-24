import type { BaseChannelAdapter } from '../../../channels/contracts.js';
import type { ChannelAddress, ChannelChat, OutboundRichCard } from '../../../domain/index.js';
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
  responseAddress?: ChannelAddress;
  richCard?: OutboundRichCard;
  threadTableCardScope?: ThreadCardScope;
  afterDelivery?: (messageId?: string) => Promise<void> | void;
  postDeliveryCurrentAddress?: ChannelAddress;
  postDeliveryUserMessages?: Array<{
    address: ChannelAddress;
    text: string;
    messageId: string;
  }>;
  backgroundEffects?: SessionCommandBackgroundEffect[];
}

export interface SessionCommandBackgroundEffect {
  context: string;
  failureNotice: string;
  run(): Promise<void>;
}

export function createGroupRenameBackgroundEffect(
  adapter: BaseChannelAdapter,
  chatId: string,
  name: string,
): SessionCommandBackgroundEffect | undefined {
  if (!adapter.renameGroupChat) return undefined;
  return {
    context: `rename group chat ${chatId}`,
    failureNotice: `本地会话标题已更新，但群聊名称同步失败。可稍后重试 \`/t rename ${name}\`。`,
    run: async () => {
      await adapter.renameGroupChat!(chatId, name);
    },
  };
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

export function scheduleMirrorSubscriptionsBestEffort(
  deps: SessionCommandDeps,
  context: string,
): void {
  if (!deps.reconcileMirrorSubscriptions) return;
  const immediate = setImmediate(() => {
    void reconcileMirrorSubscriptionsBestEffort(deps, context);
  });
  immediate.unref?.();
}
