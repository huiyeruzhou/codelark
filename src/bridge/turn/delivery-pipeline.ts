import path from 'node:path';
import type { BaseChannelAdapter } from '../../channels/contracts.js';
import type { ChannelAddress, OutboundAttachment, OutboundManualInput, OutboundQuestion, OutboundRichCard, SendResult } from '../../domain/index.js';
import {
  deliverResponse as defaultDeliverResponse,
} from '../../channels/delivery/feedback.js';
import { deliver } from '../../channels/delivery/deliver.js';
import type { FinalizedBridgeResponse } from './turn-types.js';
import { buildAgentQuestionCallbackData } from '../callbacks/agent-question.js';

export type DeliverResponseImpl = (
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
  replyToMessageId?: string,
  attachments?: OutboundAttachment[],
) => Promise<unknown>;

export interface FinalResponseDeliveryContext {
  adapter: BaseChannelAdapter;
  address: ChannelAddress;
  sessionId: string;
  replyToMessageId?: string;
  deliverResponse?: DeliverResponseImpl;
  deliverText?: (text: string) => Promise<SendResult>;
  deliverManualInput?: (input: OutboundManualInput) => Promise<void>;
}

export interface FinalResponseDeliveryOptions {
  skipText?: boolean;
  reportAttachmentErrors?: boolean;
}

function normalizeUnknownSendResult(result: unknown): SendResult {
  if (result && typeof result === 'object' && 'ok' in result) {
    return result as SendResult;
  }
  return { ok: true };
}

function buildQuestionCard(question: OutboundQuestion): OutboundRichCard {
  const options = question.options.length > 0
    ? question.options
    : ['继续', '取消'];
  const submitCallbackData = buildAgentQuestionCallbackData({
    question: question.question,
    answer: question.submitText || '提交',
  });
  if (question.input) {
    return {
      title: '需要确认',
      template: 'blue',
      sections: [
        {
          markdown: [
            question.question,
            question.allowTextReply === false
              ? ''
              : '\n也可以直接在当前聊天里回复补充说明。',
          ].filter(Boolean).join('\n'),
        },
      ],
      form: {
        optionElementId: 'clk_choice',
        inputElementId: 'clk_input',
        inputLabel: question.input.label || '补充说明',
        inputPlaceholder: question.input.placeholder || '可留空',
        submitText: question.submitText || '提交',
        submitCallbackData,
        options: options.slice(0, 8).map((option) => ({
          text: option,
          callbackData: option,
        })),
      },
    };
  }
  return {
    title: '需要确认',
    template: 'blue',
    sections: [
      {
        markdown: [
          question.question,
          question.allowTextReply === false
            ? ''
            : '\n也可以直接在当前聊天里回复补充说明。',
        ].filter(Boolean).join('\n'),
      },
    ],
    actions: [
      options.slice(0, 8).map((option) => ({
        text: option,
        callbackData: buildAgentQuestionCallbackData({
          question: question.question,
          answer: option,
        }),
        type: 'default',
      })),
    ],
  };
}

function callbackKind(callbackData: string | undefined): string | undefined {
  return callbackData?.split(':')[0] || undefined;
}

function summarizeQuestionRichCard(card: OutboundRichCard): Record<string, unknown> {
  return {
    title: card.title,
    actionRows: card.actions?.length || 0,
    actionCount: card.actions?.flat().length || 0,
    actionCallbackKinds: card.actions?.flat().map((action) => callbackKind(action.callbackData)) || [],
    hasForm: Boolean(card.form),
    formOptionElementId: card.form?.optionElementId,
    formInputElementId: card.form?.inputElementId,
    formOptionCount: card.form?.options.length || 0,
    formSubmitCallbackKind: callbackKind(card.form?.submitCallbackData),
  };
}

export async function deliverFinalResponse(
  context: FinalResponseDeliveryContext,
  response: FinalizedBridgeResponse,
  options: FinalResponseDeliveryOptions = {},
): Promise<SendResult> {
  let lastResult: SendResult = { ok: true };
  const deliverResponse = context.deliverResponse || defaultDeliverResponse;

  const cloudDocument = context.address.cloudDocument;
  if (cloudDocument && context.adapter.sendCloudDocumentReply) {
    const unsupportedAttachmentNotice = response.attachments.length > 0
      ? `暂不支持在云文档评论中发送本地附件，已省略 ${response.attachments.length} 个附件。`
      : '';
    const text = [
      response.text.trim(),
      response.questions.map((question) => {
        const options = question.options.length > 0
          ? `\n可选回复：${question.options.join(' / ')}`
          : '';
        return `${question.question}${options}`;
      }).join('\n\n').trim(),
      unsupportedAttachmentNotice,
    ].filter(Boolean).join('\n\n');
    if (text) {
      lastResult = await context.adapter.sendCloudDocumentReply(cloudDocument, text);
      if (!lastResult.ok) return lastResult;
    }
    return lastResult;
  }

  if (!options.skipText && response.text.trim()) {
    if (context.deliverText) {
      lastResult = await context.deliverText(response.text);
    } else {
      lastResult = normalizeUnknownSendResult(await deliverResponse(
        context.adapter,
        context.address,
        response.text,
        context.sessionId,
        context.replyToMessageId,
        [],
      ));
    }
    if (!lastResult.ok) return lastResult;
  }

  if (response.attachments.length > 0) {
    lastResult = normalizeUnknownSendResult(await deliverResponse(
      context.adapter,
      context.address,
      '',
      context.sessionId,
      context.replyToMessageId,
      response.attachments,
    ));
    if (!lastResult.ok) {
      if (options.reportAttachmentErrors !== false) {
        const names = response.attachments
          .map((attachment) => attachment.name || path.basename(attachment.path))
          .filter(Boolean)
          .join('、');
        const detail = lastResult.error || 'unknown upload error';
        await deliver(context.adapter, {
          address: context.address,
          text: `附件发送失败${names ? `（${names}）` : ''}：${detail}`,
          parseMode: 'plain',
          replyToMessageId: context.replyToMessageId,
        }, { sessionId: context.sessionId });
      }
      return lastResult;
    }
  }

  for (const question of response.questions) {
    const richCard = buildQuestionCard(question);
    console.log('[bridge] Delivering final response question card:', {
      sessionId: context.sessionId,
      channelType: context.address.channelType,
      chatId: context.address.chatId,
      replyToMessageId: context.replyToMessageId,
      questionChars: question.question.length,
      optionCount: question.options.length,
      hasInput: Boolean(question.input),
      richCard: summarizeQuestionRichCard(richCard),
    });
    lastResult = await context.adapter.send({
      address: context.address,
      text: question.question,
      richCard,
      replyToMessageId: context.replyToMessageId,
    });
    if (!lastResult.ok) return lastResult;
  }

  for (const platformMessage of response.platformMessages) {
    lastResult = await deliver(context.adapter, {
      address: context.address,
      text: '',
      platformMessage,
      replyToMessageId: context.replyToMessageId,
    }, { sessionId: context.sessionId });
    if (!lastResult.ok) {
      const detail = lastResult.error || 'unknown Feishu API error';
      await deliver(context.adapter, {
        address: context.address,
        text: `飞书消息发送失败：${detail}`,
        parseMode: 'plain',
        replyToMessageId: context.replyToMessageId,
      }, { sessionId: context.sessionId });
      return lastResult;
    }
  }

  for (const input of response.manualInputs) {
    if (!context.deliverManualInput) {
      return { ok: false, error: 'manual input delivery is unavailable' };
    }
    try {
      await context.deliverManualInput(input);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return lastResult;
}
