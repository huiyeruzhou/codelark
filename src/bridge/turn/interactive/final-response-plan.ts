import type {
  OutboundAttachment,
  OutboundManualInput,
  OutboundPlatformMessage,
  OutboundQuestion,
} from '../../../domain/index.js';
import type { FinalizedBridgeResponse } from '../turn-types.js';
import {
  assembleCodexFinalResponse,
  assembleSdkFinalResponse,
  hasFinalResponsePayload,
  mergeFinalResponses,
} from '../response-assembler.js';

export type InteractiveFinalStreamStatus = 'completed' | 'interrupted' | 'error';

export interface InteractiveTerminalFinalizationResult {
  outcome: 'completed' | 'failed' | 'aborted';
  detail?: string;
  finalText?: string;
}

export interface InteractiveProcessFinalResult {
  responseText: string;
  outboundAttachments: OutboundAttachment[];
  outboundQuestions?: OutboundQuestion[];
  outboundPlatformMessages?: OutboundPlatformMessage[];
  outboundManualInputs?: OutboundManualInput[];
  hasError: boolean;
  errorMessage: string;
}

export interface InteractiveFinalResponsePlan {
  streamEndStatus: InteractiveFinalStreamStatus;
  cardText: string;
  deliveryResponse: FinalizedBridgeResponse | null;
  skipTextWhenCardFinalized: boolean;
}

function terminalStatus(outcome: InteractiveTerminalFinalizationResult['outcome']): InteractiveFinalStreamStatus {
  return outcome === 'completed'
    ? 'completed'
    : outcome === 'aborted'
      ? 'interrupted'
      : 'error';
}

function appendErrorDetail(baseText: string, errorDetail: string): string {
  return baseText.trim() ? `${baseText.trim()}\n\n${errorDetail}` : errorDetail;
}

export function buildExternalTerminalFinalResponsePlan(params: {
  terminal: InteractiveTerminalFinalizationResult;
  staleTaskNotice?: string | null;
  aborted: boolean;
  formatErrorCard(message: string): string;
}): InteractiveFinalResponsePlan {
  const streamEndStatus = terminalStatus(params.terminal.outcome);
  const terminalResponse = assembleCodexFinalResponse({
    text: params.staleTaskNotice || params.terminal.finalText || '',
  });
  const cardText = streamEndStatus === 'error' && !params.aborted
    ? appendErrorDetail(
        terminalResponse.text,
        params.formatErrorCard(params.terminal.detail || 'External terminal failed'),
      )
    : terminalResponse.text;

  return {
    streamEndStatus,
    cardText,
    deliveryResponse: hasFinalResponsePayload(terminalResponse) ? terminalResponse : null,
    skipTextWhenCardFinalized: true,
  };
}

export function buildProcessFinalResponsePlan(params: {
  result: InteractiveProcessFinalResult;
  terminal: InteractiveTerminalFinalizationResult | null;
  staleTaskNotice?: string | null;
  aborted: boolean;
  formatErrorCard(message: string): string;
}): InteractiveFinalResponsePlan {
  const terminalResponse = params.terminal?.outcome === 'completed'
    ? assembleCodexFinalResponse({ text: params.terminal.finalText || '' })
    : null;
  const sdkResponse = assembleSdkFinalResponse({
    text: params.result.responseText,
    attachments: params.result.outboundAttachments,
    questions: params.result.outboundQuestions || [],
    platformMessages: params.result.outboundPlatformMessages || [],
    manualInputs: params.result.outboundManualInputs || [],
    hasError: params.result.hasError,
    errorMessage: params.result.errorMessage,
  });
  const terminalHasFinalPayload = Boolean(
    terminalResponse && hasFinalResponsePayload(terminalResponse),
  );
  const effectiveResponse = terminalResponse && terminalHasFinalPayload
    ? mergeFinalResponses(terminalResponse, sdkResponse)
    : sdkResponse;

  const staleResponse = params.staleTaskNotice
    ? assembleCodexFinalResponse({ text: params.staleTaskNotice })
    : null;
  const streamEndStatus = params.terminal
    ? terminalStatus(params.terminal.outcome)
    : params.aborted
      ? 'interrupted'
      : params.result.hasError ? 'error' : 'completed';
  const baseCardText = staleResponse?.text || (streamEndStatus === 'interrupted' ? '' : effectiveResponse.text);
  const cardText = streamEndStatus === 'error' && !params.aborted
    ? appendErrorDetail(baseCardText, params.formatErrorCard(params.result.errorMessage))
    : baseCardText;

  if (staleResponse) {
    return {
      streamEndStatus,
      cardText,
      deliveryResponse: staleResponse,
      skipTextWhenCardFinalized: true,
    };
  }

  if (hasFinalResponsePayload(effectiveResponse)) {
    return {
      streamEndStatus,
      cardText,
      deliveryResponse: effectiveResponse,
      skipTextWhenCardFinalized: true,
    };
  }

  if (params.result.hasError && !params.aborted) {
    const fallbackErrorText = params.formatErrorCard(params.result.errorMessage);
    return {
      streamEndStatus,
      cardText: fallbackErrorText,
      deliveryResponse: assembleSdkFinalResponse({
        text: fallbackErrorText,
        hasError: true,
        errorMessage: params.result.errorMessage,
      }),
      skipTextWhenCardFinalized: false,
    };
  }

  return {
    streamEndStatus,
    cardText,
    deliveryResponse: null,
    skipTextWhenCardFinalized: true,
  };
}
