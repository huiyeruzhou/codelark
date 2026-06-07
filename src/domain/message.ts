import type { ChannelAddress, InboundChannelEvent } from './channel.js';

export interface FileAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  data: string;
  filePath?: string;
}

export interface BridgeMessage {
  role: string;
  content: string;
  timestamp?: string;
}

export interface InboundMessage {
  messageId: string;
  address: ChannelAddress;
  text: string;
  timestamp: number;
  callbackData?: string;
  callbackMessageId?: string;
  raw?: unknown;
  contextText?: string;
  updateId?: number;
  attachments?: FileAttachment[];
  channelEvent?: InboundChannelEvent;
}

export interface OutboundMessage {
  address: ChannelAddress;
  text: string;
  parseMode?: 'HTML' | 'Markdown' | 'plain';
  attachments?: OutboundAttachment[];
  inlineButtons?: InlineButton[][];
  richCard?: OutboundRichCard;
  richCardUpdateMessageId?: string;
  replyToMessageId?: string;
}

export interface OutboundAttachment {
  kind: 'image' | 'file';
  path: string;
  caption?: string;
  name?: string;
}

export interface OutboundQuestion {
  question: string;
  options: string[];
  allowTextReply?: boolean;
  input?: {
    label?: string;
    placeholder?: string;
  };
  submitText?: string;
}

export interface InlineButton {
  text: string;
  callbackData: string;
}

export interface OutboundCardActionButton {
  text: string;
  callbackData: string;
  type?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
  submit?: boolean;
}

export interface OutboundCardActionSelectOption {
  text: string;
  callbackData: string;
}

export interface OutboundCardActionSelect {
  id?: string;
  placeholder: string;
  selectedCallbackData?: string;
  options: OutboundCardActionSelectOption[];
}

export interface OutboundRichCardSection {
  title?: string;
  text?: string;
  markdown?: string;
  image?: {
    imageKey: string;
    alt?: string;
    mode?: 'fit_horizontal' | 'crop_center';
    preview?: boolean;
  };
  fields?: Array<[string, string | null | undefined]>;
  code?: {
    text: string;
    language?: string;
  };
  actions?: OutboundCardActionButton[][];
}

export interface OutboundRichCardPanel {
  title: string;
  template?: OutboundRichCard['template'];
  expanded?: boolean;
  subtitle?: string;
  table?: OutboundRichCardTable;
  selects?: OutboundCardActionSelect[];
  actions?: OutboundCardActionButton[][];
  footer?: string[];
}

export interface OutboundRichCardTableColumn {
  name: string;
  displayName: string;
  width?: string;
  dataType?: 'text' | 'lark_md' | 'markdown' | 'number';
  horizontalAlign?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'center' | 'bottom';
}

export interface OutboundRichCardTable {
  columns: OutboundRichCardTableColumn[];
  rows: Array<Record<string, string | number | null | undefined>>;
  pageSize?: number;
  rowHeight?: 'low' | 'middle' | 'medium' | 'high' | 'auto' | `${number}px`;
  freezeFirstColumn?: boolean;
}

export interface OutboundRichCardTableBlock {
  title?: string;
  titleColor?: string;
  subtitle?: string;
  table: OutboundRichCardTable;
  selects?: OutboundCardActionSelect[];
  actions?: OutboundCardActionButton[][];
  footer?: string[];
}

export interface OutboundRichCard {
  title: string;
  subtitle?: string;
  tags?: string[];
  tagColor?: 'neutral' | 'blue' | 'green' | 'red' | 'yellow' | 'orange' | 'purple' | 'turquoise';
  table?: OutboundRichCardTable;
  tableBlocks?: OutboundRichCardTableBlock[];
  panels?: OutboundRichCardPanel[];
  sections: OutboundRichCardSection[];
  form?: {
    optionElementId: string;
    inputElementId?: string;
    inputLabel?: string;
    inputPlaceholder?: string;
    inputDefaultValue?: string;
    layout?: 'single' | 'two_column';
    selects?: Array<{
      elementId: string;
      label?: string;
      placeholder?: string;
      selectedCallbackData?: string;
      options: OutboundCardActionSelectOption[];
    }>;
    controlBar?: {
      selects?: OutboundCardActionSelect[];
      actions?: OutboundCardActionButton[];
      dividerAfter?: boolean;
    };
    extraInputs?: Array<{
      elementId: string;
      label: string;
      placeholder: string;
      defaultValue?: string;
    }>;
    submitText: string;
    submitCallbackData: string;
    options: OutboundCardActionSelectOption[];
  };
  footer?: string[];
  selects?: OutboundCardActionSelect[];
  actions?: OutboundCardActionButton[][];
  template?: 'blue' | 'wathet' | 'turquoise' | 'green' | 'yellow' | 'orange' | 'red' | 'carmine' | 'violet' | 'purple' | 'indigo' | 'grey';
  maxSections?: number;
  updateKey?: string;
  updateTtlMs?: number | null;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  httpStatus?: number;
}

export interface PreviewCapabilities {
  supported: boolean;
  privateOnly: boolean;
}

export interface StreamingPreviewState {
  draftId: number;
  chatId: string;
  lastSentText: string;
  lastSentAt: number;
  degraded: boolean;
  throttleTimer: ReturnType<typeof setTimeout> | null;
  pendingText: string;
}

export const PLATFORM_LIMITS: Record<string, number> = {
  feishu: 30000,
};
