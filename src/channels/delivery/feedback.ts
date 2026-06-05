import type { BaseChannelAdapter } from '../contracts.js';
import type {
  ChannelAddress,
  OutboundAttachment,
  OutboundRichCard,
  SendResult,
} from '../../domain/index.js';
import { deliver } from './deliver.js';
import { getFeedbackParseMode, renderFeedbackText } from '../adapter-runtime/channel-runtime.js';
import { supportsOutboundArtifacts } from './artifacts.js';

/**
 * Render bridge-generated text through the channel's preferred parse mode.
 * Feishu keeps Markdown so notices, command responses, and model replies stay aligned.
 */
export async function deliverTextResponse(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId?: string,
  replyToMessageId?: string,
  options?: {
    audit?: boolean;
    richCard?: OutboundRichCard;
    richCardUpdateMessageId?: string;
  },
): Promise<SendResult> {
  if (!responseText.trim()) return { ok: true };

  const parseMode = getFeedbackParseMode(adapter.channelType);
  const renderedText = renderFeedbackText(responseText, parseMode);

  if (parseMode === 'Markdown' && adapter.provider === 'feishu') {
    return deliver(adapter, {
      address,
      text: responseText,
      parseMode: 'Markdown',
      richCard: options?.richCard,
      richCardUpdateMessageId: options?.richCardUpdateMessageId,
      replyToMessageId,
    }, { sessionId, audit: options?.audit });
  }
  return deliver(adapter, {
    address,
    text: parseMode === 'Markdown' ? responseText : renderedText,
    parseMode,
    richCard: options?.richCard,
    richCardUpdateMessageId: options?.richCardUpdateMessageId,
    replyToMessageId,
  }, { sessionId, audit: options?.audit });
}

export async function deliverBridgeNotice(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  text: string,
  options?: {
    sessionId?: string;
    replyToMessageId?: string;
    audit?: boolean;
    richCard?: OutboundRichCard;
    richCardUpdateMessageId?: string;
  },
): Promise<SendResult> {
  return deliverTextResponse(
    adapter,
    address,
    text,
    options?.sessionId,
    options?.replyToMessageId,
    {
      audit: options?.audit,
      richCard: options?.richCard,
      richCardUpdateMessageId: options?.richCardUpdateMessageId,
    },
  );
}

export async function deliverResponse(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
  replyToMessageId?: string,
  attachments: OutboundAttachment[] = [],
): Promise<SendResult> {
  let lastResult: SendResult = { ok: true };

  if (responseText.trim()) {
    lastResult = await deliverTextResponse(adapter, address, responseText, sessionId, replyToMessageId);
    if (!lastResult.ok) return lastResult;
  }

  for (const attachment of attachments) {
    if (attachment.caption) {
      const captionResult = await deliverTextResponse(
        adapter,
        address,
        attachment.caption,
        sessionId,
        replyToMessageId,
      );
      if (!captionResult.ok) return captionResult;
      lastResult = captionResult;
    }

    if (!supportsOutboundArtifacts(adapter.provider)) {
      lastResult = await deliverTextResponse(
        adapter,
        address,
        `生成了一个本地${attachment.kind === 'image' ? '图片' : '文件'}，但当前通道暂不支持直接发送：${attachment.path}`,
        sessionId,
        replyToMessageId,
      );
      if (!lastResult.ok) return lastResult;
      continue;
    }

    const attachmentResult = await deliver(adapter, {
      address,
      text: '',
      parseMode: 'plain',
      attachments: [attachment],
      replyToMessageId,
    }, { sessionId });

    if (!attachmentResult.ok) {
      return deliverTextResponse(
        adapter,
        address,
        `附件发送失败：${attachment.path}\n${attachmentResult.error || '未知错误'}`,
        sessionId,
        replyToMessageId,
      );
    }

    lastResult = attachmentResult;
  }

  return lastResult;
}
