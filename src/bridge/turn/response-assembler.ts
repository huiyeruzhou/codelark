import type { OutboundAttachment, OutboundManualInput, OutboundPlatformMessage, OutboundQuestion, StreamingHistoryItem } from '../../domain/index.js';
import {
  parseOutboundArtifacts,
  stripOutboundArtifactBlocksForStreaming,
} from '../../channels/delivery/artifacts.js';
import type {
  BridgeTurnFinalSource,
  FinalizedBridgeResponse,
} from './turn-types.js';

export interface AssembleFinalResponseInput {
  text?: string | null;
  attachments?: OutboundAttachment[];
  questions?: OutboundQuestion[];
  platformMessages?: OutboundPlatformMessage[];
  manualInputs?: OutboundManualInput[];
  hasError?: boolean;
  errorMessage?: string;
}

export interface FinalResponseArtifactParseResult {
  text: string;
  attachments: OutboundAttachment[];
  questions: OutboundQuestion[];
  platformMessages: OutboundPlatformMessage[];
  manualInputs: OutboundManualInput[];
}

export function outboundAttachmentKey(attachment: OutboundAttachment): string {
  return [
    attachment.kind,
    attachment.path,
    attachment.caption || '',
    attachment.name || '',
  ].join('\0');
}

export function stripFinalOnlyBlocksFromStreamingHistory(
  items: StreamingHistoryItem[],
): StreamingHistoryItem[] {
  return items.flatMap((item) => {
    if (item.type !== 'markdown' || item.role !== 'assistant') return [item];
    const content = stripOutboundArtifactBlocksForStreaming(item.content);
    return content ? [{ ...item, content }] : [];
  });
}

export function dedupeOutboundAttachments(
  attachments: OutboundAttachment[],
): OutboundAttachment[] {
  const seen = new Set<string>();
  const deduped: OutboundAttachment[] = [];
  for (const attachment of attachments) {
    const key = outboundAttachmentKey(attachment);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(attachment);
  }
  return deduped;
}

function dedupeByKey<T>(values: T[], keyFor: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyFor(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function platformMessageKey(message: OutboundPlatformMessage): string {
  return `${message.msgType}\0${JSON.stringify(message.content)}`;
}

function manualInputKey(input: OutboundManualInput): string {
  return [input.codelarkHome || '', JSON.stringify(input.target), input.text].join('\0');
}

export function collectFinalResponseArtifacts(
  text?: string | null,
  attachments: OutboundAttachment[] = [],
  questions: OutboundQuestion[] = [],
  platformMessages: OutboundPlatformMessage[] = [],
  manualInputs: OutboundManualInput[] = [],
): FinalResponseArtifactParseResult {
  const parsed = parseOutboundArtifacts(text || '');
  if (parsed.questions.length > 0 || questions.length > 0 || parsed.errors.some((error) => error.includes('ask'))) {
    console.log('[bridge] Final response artifact parse:', {
      parsedQuestionCount: parsed.questions.length,
      carriedQuestionCount: questions.length,
      questionCount: questions.length + parsed.questions.length,
      inputQuestionCount: [
        ...questions,
        ...parsed.questions,
      ].filter((question) => Boolean(question.input)).length,
      errors: parsed.errors,
    });
  }
  return {
    text: parsed.cleanText,
    attachments: dedupeOutboundAttachments([
      ...attachments,
      ...parsed.attachments,
    ]),
    questions: [
      ...questions,
      ...parsed.questions,
    ],
    platformMessages: [
      ...platformMessages,
      ...parsed.platformMessages,
    ],
    manualInputs: [
      ...manualInputs,
      ...parsed.manualInputs,
    ],
  };
}

function assembleFinalResponse(
  source: BridgeTurnFinalSource,
  input: AssembleFinalResponseInput,
): FinalizedBridgeResponse {
  const parsed = collectFinalResponseArtifacts(
    input.text,
    input.attachments,
    input.questions,
    input.platformMessages,
    input.manualInputs,
  );
  return {
    text: parsed.text,
    attachments: parsed.attachments,
    questions: parsed.questions,
    platformMessages: parsed.platformMessages,
    manualInputs: parsed.manualInputs,
    hasError: input.hasError,
    errorMessage: input.errorMessage,
    source,
  };
}

export function assembleSdkFinalResponse(
  input: AssembleFinalResponseInput,
): FinalizedBridgeResponse {
  return assembleFinalResponse('sdk_result', input);
}

export function assembleCodexFinalResponse(
  input: AssembleFinalResponseInput,
): FinalizedBridgeResponse {
  return assembleFinalResponse('codex_task_complete', input);
}

export function hasFinalResponsePayload(response: FinalizedBridgeResponse): boolean {
  return Boolean(
    response.text
    || response.attachments.length > 0
    || response.questions.length > 0
    || response.platformMessages.length > 0
    || response.manualInputs.length > 0,
  );
}

export function mergeFinalResponses(
  primary: FinalizedBridgeResponse,
  fallback: FinalizedBridgeResponse,
): FinalizedBridgeResponse {
  return {
    text: primary.text || fallback.text,
    attachments: dedupeOutboundAttachments([
      ...fallback.attachments,
      ...primary.attachments,
    ]),
    questions: [
      ...fallback.questions,
      ...primary.questions,
    ],
    platformMessages: dedupeByKey([
      ...fallback.platformMessages,
      ...primary.platformMessages,
    ], platformMessageKey),
    manualInputs: dedupeByKey([
      ...fallback.manualInputs,
      ...primary.manualInputs,
    ], manualInputKey),
    hasError: primary.hasError ?? fallback.hasError,
    errorMessage: primary.errorMessage || fallback.errorMessage,
    source: primary.source,
  };
}

export function stripFinalOnlyBlocksForStreaming(text: string): string {
  return stripOutboundArtifactBlocksForStreaming(text);
}
