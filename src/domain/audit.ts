import type { ChannelChat, ChannelType } from './channel.js';
import type { BridgeMessage } from './message.js';
import type { PermissionLinkInput, PermissionLinkRecord } from './permission.js';
import type { BridgeApiProvider } from '../runtime/contracts.js';
import type {
  BridgeSession,
  BridgeSessionCodexRuntimeState,
  BridgeSessionRuntimeState,
  BridgeSessionUpdate,
  CodexReasoningEffort,
} from './session.js';

export interface AuditLogInput {
  channelType: string;
  channelProvider?: string;
  channelAlias?: string;
  chatId: string;
  direction: 'inbound' | 'outbound';
  messageId: string;
  summary: string;
}

export interface AuditLogEntry {
  id: string;
  channelType: ChannelType;
  chatId: string;
  direction: 'inbound' | 'outbound';
  messageId: string;
  summary: string;
  createdAt: string;
}

export interface OutboundRefInput {
  channelType: string;
  channelProvider?: string;
  channelAlias?: string;
  chatId: string;
  chatKind?: string;
  chatUserId?: string;
  bridgeSessionId: string;
  platformMessageId: string;
  purpose: string;
}

export interface UpsertChannelChatInput {
  channelType: string;
  channelProvider?: string;
  channelAlias?: string;
  chatId: string;
  chatKind?: string;
  chatUserId?: string;
  bridgeSessionId: string;
  runtimeBridgeSessionIds?: ChannelChat['runtimeBridgeSessionIds'];
  cloudDocumentChat?: ChannelChat['cloudDocumentChat'];
}

export interface SettingsProvider {
  getSetting(key: string): string | null;
}

export interface BridgeStore {
  getSetting(key: string): string | null;
  getChannelChat(channelType: string, chatId: string): ChannelChat | null;
  upsertChannelChat(data: UpsertChannelChatInput): ChannelChat;
  deleteChannelChat(id: string): void;
  updateChannelChat(id: string, updates: Partial<ChannelChat>): void;
  touchChannelChatActivity(id: string, timestamp?: string): void;
  listChannelChats(channelType?: ChannelType): ChannelChat[];
  getSession(id: string): BridgeSession | null;
  listSessions(): BridgeSession[];
  findSessionByCodexThreadId(codexThreadId: string): BridgeSession | null;
  createSession(
    name: string,
    model: string,
    systemPrompt?: string,
    cwd?: string,
    mode?: string,
    options?: {
      reasoningEffort?: CodexReasoningEffort;
      activeRuntime?: BridgeSessionRuntimeState['activeRuntime'];
      sessionType?: BridgeSession['session_type'];
      hidden?: boolean;
      parentSessionId?: string;
      expiresAt?: string;
    },
  ): BridgeSession;
  updateSessionProviderId(sessionId: string, providerId: string): void;
  updateSession(sessionId: string, updates: BridgeSessionUpdate, options?: { touch?: boolean }): void;
  deleteSession(sessionId: string): void;
  addMessage(sessionId: string, role: string, content: string, usage?: string | null): void;
  getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] };
  acquireSessionLock(sessionId: string, lockId: string, owner: string, ttlSecs: number): boolean;
  renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void;
  releaseSessionLock(sessionId: string, lockId: string): void;
  setSessionRuntimeStatus(sessionId: string, status: string): void;
  updateSessionCodexThreadId(sessionId: string, codexThreadId: string): void;
  updateSessionModel(sessionId: string, model: string): void;
  syncSdkTasks(sessionId: string, todos: unknown): void;
  getProvider(id: string): BridgeApiProvider | undefined;
  getDefaultProviderId(): string | null;
  insertAuditLog(entry: AuditLogInput): void;
  checkDedup(key: string): boolean;
  insertDedup(key: string): void;
  cleanupExpiredDedup(): void;
  insertOutboundRef(ref: OutboundRefInput): void;
  insertPermissionLink(link: PermissionLinkInput): void;
  getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null;
  markPermissionLinkResolved(permissionRequestId: string): boolean;
  listPendingPermissionLinksByChat(chatId: string): PermissionLinkRecord[];
  getChannelOffset(key: string): string;
  setChannelOffset(key: string, offset: string): void;
}
