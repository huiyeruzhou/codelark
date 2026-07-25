import { maskSecrets } from '../../../shared/logger.js';
import { sanitizeInput } from '../../../shared/security/validators.js';
import {
  buildToolCallDetailFromInput,
  buildToolCallDetailFromOutput,
  mergeToolCallDetail,
} from '../../../shared/progress/tool-call-details.js';
import { buildToolProgressMarkdown } from '../../../shared/progress/tool-rendering.js';

export function appendStreamPreviewChunk(
  current: string,
  chunk: string,
  separateBeforeChunk: boolean,
): string {
  if (!separateBeforeChunk || !current.trim() || !chunk.trim()) {
    return current + chunk;
  }
  const separator = current.endsWith('\n\n') ? '' : (current.endsWith('\n') ? '\n' : '\n\n');
  return `${current}${separator}${chunk}`;
}

export function buildInlineToolBlock(params: {
  name: string;
  status?: 'running' | 'complete' | 'error';
  input?: unknown;
  output?: string;
  isError?: boolean;
}): string {
  const status = params.status || (params.isError ? 'error' : (typeof params.output === 'string' ? 'complete' : 'running'));
  const inputDetail = typeof params.input !== 'undefined'
    ? buildToolCallDetailFromInput(params.name, params.input)
    : null;
  const outputDetail = typeof params.output === 'string'
    ? buildToolCallDetailFromOutput(params.name, params.output, inputDetail)
    : null;
  const detail = mergeToolCallDetail(inputDetail, outputDetail);
  return buildToolProgressMarkdown([{
    id: 'inline',
    name: params.name || 'tool',
    status,
    input: null,
    output: null,
    detail,
  }]).trim();
}

export function buildReasoningPreviewNote(note: string): string {
  const masked = maskSecrets(note);
  const { text } = sanitizeInput(masked, 1200);
  return text.trim() ? `> ${text.trim().replace(/\n/g, '\n> ')}\n\n` : '';
}
