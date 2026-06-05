import path from 'node:path';

import type { OutboundAttachment, OutboundQuestion } from '../../domain/index.js';

const SEND_BLOCK_REGEX = /<clk-send>\s*([\s\S]*?)\s*<\/clk-send>/gi;
const SEND_BLOCK_OPEN_REGEX = /<clk-send>/i;
const ASK_BLOCK_REGEX = /<clk-ask>\s*([\s\S]*?)\s*<\/clk-ask>/gi;
const ASK_BLOCK_OPEN_REGEX = /<clk-ask>/i;

interface RawSendInstruction {
  type?: unknown;
  path?: unknown;
  caption?: unknown;
  name?: unknown;
}

interface RawAskInstruction {
  question?: unknown;
  options?: unknown;
  allowTextReply?: unknown;
  input?: unknown;
  submitText?: unknown;
}

export interface ParsedOutboundArtifacts {
  cleanText: string;
  attachments: OutboundAttachment[];
  questions: OutboundQuestion[];
  errors: string[];
}

function normalizeInstruction(raw: RawSendInstruction): OutboundAttachment | null {
  const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
  const filePath = typeof raw.path === 'string' ? raw.path.trim() : '';
  if ((type !== 'image' && type !== 'file') || !filePath || !(path.isAbsolute(filePath) || path.win32.isAbsolute(filePath))) {
    return null;
  }

  return {
    kind: type,
    path: filePath,
    caption: typeof raw.caption === 'string' && raw.caption.trim() ? raw.caption.trim() : undefined,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : undefined,
  };
}

function normalizeInstructionPayload(payload: unknown): {
  attachments: OutboundAttachment[];
  errors: string[];
} {
  const attachments: OutboundAttachment[] = [];
  const errors: string[] = [];

  const objects: RawSendInstruction[] = [];
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (item && typeof item === 'object') {
        objects.push(item as RawSendInstruction);
      }
    }
  } else if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.items)) {
      for (const item of record.items) {
        if (item && typeof item === 'object') {
          objects.push(item as RawSendInstruction);
        }
      }
    } else {
      objects.push(record as RawSendInstruction);
    }
  }

  for (const raw of objects) {
    const normalized = normalizeInstruction(raw);
    if (normalized) {
      attachments.push(normalized);
    } else {
      errors.push('invalid-send-instruction');
    }
  }

  return { attachments, errors };
}

function normalizeAskPayload(payload: unknown): {
  questions: OutboundQuestion[];
  errors: string[];
} {
  const questions: OutboundQuestion[] = [];
  const errors: string[] = [];

  const objects: RawAskInstruction[] = [];
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (item && typeof item === 'object') objects.push(item as RawAskInstruction);
    }
  } else if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.items)) {
      for (const item of record.items) {
        if (item && typeof item === 'object') objects.push(item as RawAskInstruction);
      }
    } else {
      objects.push(record as RawAskInstruction);
    }
  }

  for (const raw of objects) {
    const question = typeof raw.question === 'string' ? raw.question.trim() : '';
    const rawOptions = Array.isArray(raw.options) ? raw.options : [];
    const options = rawOptions
      .map((item) => typeof item === 'string' ? item.trim() : '')
      .filter(Boolean)
      .slice(0, 8);
    if (!question) {
      errors.push('invalid-ask-instruction');
      continue;
    }
    const inputRecord = raw.input && typeof raw.input === 'object'
      ? raw.input as Record<string, unknown>
      : null;
    const input = inputRecord
      ? {
          label: typeof inputRecord.label === 'string' && inputRecord.label.trim()
            ? inputRecord.label.trim().slice(0, 80)
            : undefined,
          placeholder: typeof inputRecord.placeholder === 'string' && inputRecord.placeholder.trim()
            ? inputRecord.placeholder.trim().slice(0, 120)
            : undefined,
        }
      : undefined;
    questions.push({
      question: question.slice(0, 1000),
      options,
      allowTextReply: raw.allowTextReply !== false,
      ...(input ? { input } : {}),
      ...(typeof raw.submitText === 'string' && raw.submitText.trim()
        ? { submitText: raw.submitText.trim().slice(0, 40) }
        : {}),
    });
  }

  return { questions, errors };
}

function compactBlankLines(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseOutboundArtifacts(text: string): ParsedOutboundArtifacts {
  const attachments: OutboundAttachment[] = [];
  const questions: OutboundQuestion[] = [];
  const errors: string[] = [];
  let mutated = text ?? '';

  mutated = mutated.replace(SEND_BLOCK_REGEX, (_full, payloadText: string) => {
    try {
      const payload = JSON.parse(payloadText);
      const normalized = normalizeInstructionPayload(payload);
      attachments.push(...normalized.attachments);
      errors.push(...normalized.errors);
    } catch {
      errors.push('invalid-send-json');
    }
    return '';
  });

  mutated = mutated.replace(ASK_BLOCK_REGEX, (_full, payloadText: string) => {
    try {
      const payload = JSON.parse(payloadText);
      const normalized = normalizeAskPayload(payload);
      questions.push(...normalized.questions);
      errors.push(...normalized.errors);
    } catch {
      errors.push('invalid-ask-json');
    }
    return '';
  });

  return {
    cleanText: compactBlankLines(mutated),
    attachments,
    questions,
    errors,
  };
}

export function stripOutboundArtifactBlocksForStreaming(text: string): string {
  if (!text) return '';

  let stripped = text.replace(SEND_BLOCK_REGEX, '').replace(ASK_BLOCK_REGEX, '');
  const sendOpenMatch = SEND_BLOCK_OPEN_REGEX.exec(stripped);
  const askOpenMatch = ASK_BLOCK_OPEN_REGEX.exec(stripped);
  const openMatch = [sendOpenMatch, askOpenMatch]
    .filter((match): match is RegExpExecArray => Boolean(match))
    .sort((a, b) => a.index - b.index)[0];
  if (openMatch) {
    stripped = stripped.slice(0, openMatch.index);
  }

  return stripped.replace(/\n{3,}/g, '\n\n').trimEnd();
}

export function supportsOutboundArtifacts(provider: string): boolean {
  return provider === 'feishu';
}
