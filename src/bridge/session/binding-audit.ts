import type { BridgeStore } from '../../domain/audit.js';
import type { ChannelAddress, ChannelChat } from '../../domain/channel.js';

export type BindingChangeAction =
  | 'auto_create_draft'
  | 'auto_recreate_missing_session'
  | 'switch_draft'
  | 'switch_codex'
  | 'switch_bridge'
  | 'switch_binding'
  | 'add_codex'
  | 'new_session'
  | 'web_switch'
  | 'web_unbind';

export interface BindingChangeAuditInput {
  action: BindingChangeAction;
  address: Pick<ChannelAddress, 'channelType' | 'chatId' | 'chatKind' | 'channelProvider' | 'channelAlias'>;
  fromBinding?: ChannelChat | null;
  toBinding?: ChannelChat | null;
  messageId?: string;
  source?: string;
  reason?: string;
}

function describeBinding(binding: ChannelChat | null | undefined): string {
  if (!binding) return 'none';
  return `session=${binding.bridgeSessionId}`;
}

export function recordBindingChange(
  store: Pick<BridgeStore, 'insertAuditLog'>,
  input: BindingChangeAuditInput,
): void {
  const from = describeBinding(input.fromBinding);
  const to = describeBinding(input.toBinding);
  const details = [
    `action=${input.action}`,
    `from=[${from}]`,
    `to=[${to}]`,
  ];
  if (input.source) details.push(`source=${input.source}`);
  if (input.reason) details.push(`reason=${input.reason}`);

  store.insertAuditLog({
    channelType: input.address.channelType,
    channelProvider: input.address.channelProvider
      || input.toBinding?.channelProvider
      || input.fromBinding?.channelProvider,
    channelAlias: input.address.channelAlias
      || input.toBinding?.channelAlias
      || input.fromBinding?.channelAlias,
    chatId: input.address.chatId,
    direction: 'inbound',
    messageId: input.messageId || `binding-change:${Date.now()}`,
    summary: `Binding change: ${details.join('; ')}`,
  });
}
