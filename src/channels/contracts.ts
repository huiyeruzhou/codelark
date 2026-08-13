import type {
  ChannelAddress,
  ChannelChatKind,
  ChannelType,
  CloudDocumentAddress,
} from '../domain/channel.js';
import type {
  InboundMessage,
  OutboundAttachment,
  OutboundMessage,
  PreviewCapabilities,
  SendResult,
} from '../domain/message.js';
import type { AgentMessageSentInfo, RuntimeNoticeInfo, StreamingHistoryItem, TaskProgressInfo, ToolCallInfo } from '../domain/progress.js';

export interface AdapterRuntimeInstance {
  id: string;
  alias: string;
  enabled: boolean;
  config: unknown;
  provider: string;
}

export interface StructuredStreamingUiSnapshot {
  active: boolean;
  lastAttemptAt?: number | null;
  lastUpdateAt?: number | null;
  lastErrorAt?: number | null;
  lastError?: string | null;
  flushInFlight?: boolean;
  flushInFlightSince?: number | null;
  consecutiveFailures?: number;
}

export interface StructuredStreamingUiActionButton {
  text: string;
  callbackData: string;
  type?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
}

export interface StructuredStreamingUiMetadata {
  title?: string;
  tags?: string[];
  template?: 'blue' | 'wathet' | 'turquoise' | 'green' | 'yellow' | 'orange' | 'red' | 'carmine' | 'violet' | 'purple' | 'indigo' | 'grey';
  tagColor?: 'neutral' | 'blue' | 'green' | 'red' | 'yellow' | 'orange' | 'purple' | 'turquoise';
}

export interface CreatedGroupChat {
  chatId: string;
  chatKind: 'group';
  name?: string;
}

export interface GroupChatInfo {
  chatId: string;
  chatKind: ChannelChatKind;
  name?: string;
}

export interface CreateGroupChatOptions {
  name: string;
  ownerUserId?: string;
  userIds?: string[];
}

export abstract class BaseChannelAdapter {
  private inboundQueue: InboundMessage[] = [];
  private inboundWaiters: Array<(msg: InboundMessage | null) => void> = [];

  abstract readonly channelType: ChannelType;
  abstract readonly provider: string;
  readonly alias?: string;

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract isRunning(): boolean;
  abstract consumeOne(): Promise<InboundMessage | null>;
  abstract send(message: OutboundMessage): Promise<SendResult>;

  /** Human-readable identity of the bot represented by this adapter instance. */
  getBotDisplayName(): string {
    return this.alias?.trim() || this.channelType;
  }

  /** Move in-flight adapter-owned UI/resource state across a config-driven instance restart. */
  takeRuntimeHandoff?(): Promise<unknown>;
  /** Restore state returned by the previous instance's takeRuntimeHandoff(). */
  restoreRuntimeHandoff?(_handoff: unknown): void;

  sendCloudDocumentReply?(_target: CloudDocumentAddress, _text: string): Promise<SendResult>;
  createGroupChat?(_options: CreateGroupChatOptions): Promise<CreatedGroupChat>;
  notifyGroupChatCreated?(_address: ChannelAddress, _group: CreatedGroupChat): Promise<void>;
  renameGroupChat?(_chatId: string, _name: string): Promise<GroupChatInfo>;
  getGroupChatInfo?(_chatId: string): Promise<GroupChatInfo | null>;
  pinMessage?(_chatId: string, _messageId: string): Promise<SendResult>;
  unpinMessage?(_chatId: string, _messageId: string): Promise<SendResult>;
  addMessageReaction?(_messageId: string, _emojiType: string): Promise<string | null>;
  removeMessageReaction?(_messageId: string, _reactionId: string, _emojiType?: string): Promise<void>;
  startLargeFileUpload?(
    _address: ChannelAddress,
    _attachment: OutboundAttachment,
    _options?: { replyToMessageId?: string },
  ): SendResult;

  async answerCallback(_callbackQueryId: string, _text?: string): Promise<void> {
    // No-op by default; override in adapters that support callback queries.
  }

  abstract validateConfig(): string | null;
  abstract isAuthorized(userId: string, chatId: string): boolean;

  onMessageStart?(_chatId: string, _streamKey?: string): void;
  onMessageEnd?(_chatId: string, _streamKey?: string): void;
  acknowledgeUpdate?(_updateId: number): void;
  getPreviewCapabilities?(_chatId: string): PreviewCapabilities | null;
  sendPreview?(_chatId: string, _text: string, _draftId: number): Promise<'sent' | 'skip' | 'degrade'>;
  endPreview?(_chatId: string, _draftId: number): void;
  onStreamText?(_chatId: string, _fullText: string, _streamKey?: string): void;
  onStreamStatus?(_chatId: string, _statusText: string, _streamKey?: string): void;
  onStreamMetadata?(_chatId: string, _metadata: StructuredStreamingUiMetadata, _streamKey?: string): void;
  onStreamActions?(_chatId: string, _actions: StructuredStreamingUiActionButton[][], _streamKey?: string): void;
  supportsStructuredStreamingUi?(_chatId: string): boolean;
  hasActiveStreamingUi?(_chatId: string, _streamKey?: string): boolean;
  getStructuredStreamingUiSnapshot?(_chatId: string, _streamKey?: string): StructuredStreamingUiSnapshot | null;
  getStructuredStreamingUiMessageId?(_chatId: string, _streamKey?: string): string | null;
  waitForStructuredStreamingUiMessageId?(_chatId: string, _streamKey?: string): Promise<string | null>;
  onMirrorStreamStart?(_chatId: string, _streamKey?: string): void;
  onStreamHistory?(_chatId: string, _items: StreamingHistoryItem[], _streamKey?: string): void;
  onRuntimeNotice?(_chatId: string, _notice: RuntimeNoticeInfo, _streamKey?: string): void;
  /** Merge a successful cross-Agent send into the latest active conversation card for this chat. */
  onAgentMessageSent?(_chatId: string, _event: AgentMessageSentInfo): boolean;
  onToolEvent?(_chatId: string, _tools: ToolCallInfo[], _streamKey?: string): void;
  onTaskEvent?(_chatId: string, _tasks: TaskProgressInfo[], _streamKey?: string): void;
  onStreamEnd?(
    _chatId: string,
    _status: 'completed' | 'interrupted' | 'error',
    _responseText: string,
    _streamKey?: string,
  ): Promise<boolean>;

  protected consumeInboundMessage(isRunning: boolean): Promise<InboundMessage | null> {
    const queued = this.inboundQueue.shift();
    if (queued) return Promise.resolve(queued);
    if (!isRunning) return Promise.resolve(null);
    return new Promise<InboundMessage | null>((resolve) => {
      this.inboundWaiters.push(resolve);
    });
  }

  protected enqueueInboundMessage(message: InboundMessage): void {
    const waiter = this.inboundWaiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      this.inboundQueue.push(message);
    }
  }

  /** Inject a trusted local message through the same queue as channel ingress. */
  enqueueManualInboundMessage(message: InboundMessage): void {
    if (!this.isRunning()) throw new Error(`Channel adapter is not running: ${this.channelType}`);
    this.enqueueInboundMessage(message);
  }

  protected clearInboundQueue(): void {
    this.inboundQueue = [];
  }

  protected rejectPendingInboundConsumers(): void {
    for (const waiter of this.inboundWaiters) {
      waiter(null);
    }
    this.inboundWaiters = [];
  }
}

const adapterFactories = new Map<string, (instance?: AdapterRuntimeInstance) => BaseChannelAdapter>();

export function registerAdapterFactory(provider: string, factory: (instance?: AdapterRuntimeInstance) => BaseChannelAdapter): void {
  adapterFactories.set(provider, factory);
}

export function createAdapter(instance: AdapterRuntimeInstance): BaseChannelAdapter | null {
  const factory = adapterFactories.get(instance.provider);
  return factory ? factory(instance) : null;
}

export function getRegisteredTypes(): string[] {
  return Array.from(adapterFactories.keys());
}
