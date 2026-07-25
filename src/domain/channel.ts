/**
 * Product channel data contracts.
 *
 * These DTOs are persisted and shared by storage, UI, bridge workflows, and
 * channel adapters. They intentionally do not depend on bridge runtime code.
 */

export type ChannelType = string;
export type ChannelChatKind = 'p2p' | 'group';
export type ChannelChatMode = 'normal' | 'yolo' | 'code' | 'plan' | 'ask';

export interface CloudDocumentAddress {
  provider: 'feishu';
  fileToken: string;
  fileType: 'doc' | 'docx' | 'sheet' | 'file';
  commentId: string;
  initialPrompt?: string;
  title?: string;
  operatorId?: string;
  replyId?: string;
  typingReactionReplyId?: string;
  isWhole?: boolean;
  quote?: string;
}

export interface ChannelAddress {
  channelType: ChannelType;
  channelProvider?: string;
  channelAlias?: string;
  chatId: string;
  chatKind?: ChannelChatKind;
  userId?: string;
  displayName?: string;
  cloudDocument?: CloudDocumentAddress;
}

export interface InboundChannelEvent {
  type: 'chat_removed';
  reason: 'bot_removed' | 'chat_disbanded';
  eventType?: string;
}

export interface SessionKey {
  channelType: ChannelType;
  chatId: string;
}

export interface ChannelChat {
  id: string;
  channelType: ChannelType;
  channelProvider?: string;
  channelAlias?: string;
  chatId: string;
  chatKind?: ChannelChatKind;
  chatUserId?: string;
  bridgeSessionId: string;
  codexModelMismatchWarningKey?: string;
  runtimeBridgeSessionIds?: {
    codex?: string;
    claude?: string;
    kimi?: string;
    cursor?: string;
  };
  cloudDocumentChat?: {
    provider: 'feishu';
    fileToken: string;
    fileType: 'doc' | 'docx' | 'sheet' | 'file';
    commentId?: string;
  };
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
}

export interface ChannelDefaultTarget {
  id: string;
  channelType: ChannelType;
  channelProvider?: string;
  channelAlias?: string;
  bridgeSessionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface BridgeStatus {
  running: boolean;
  startedAt: string | null;
  adapters: AdapterStatus[];
}

export interface AdapterStatus {
  channelType: ChannelType;
  channelProvider?: string;
  channelAlias?: string;
  running: boolean;
  connectedAt: string | null;
  lastMessageAt: string | null;
  error: string | null;
}
