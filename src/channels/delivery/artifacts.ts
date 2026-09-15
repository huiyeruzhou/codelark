import path from 'node:path';

import type {
  ManualInputTargetSelector,
  OutboundAttachment,
  OutboundManualInput,
  OutboundPlatformMessage,
  OutboundQuestion,
} from '../../domain/index.js';

// Protocol blocks must own their line and begin with JSON. This prevents an
// inline literal such as `<clk-send>` in ordinary prose from pairing with a
// later real block's closing tag and swallowing everything in between.
const SEND_BLOCK_REGEX = /^[ \t]*<clk-send>[ \t]*(?:\r?\n[ \t]*)?([\[{][\s\S]*?)[ \t]*<\/clk-send>[ \t]*$/gim;
const SEND_BLOCK_OPEN_REGEX = /^[ \t]*<clk-send>[ \t]*(?=$|[\[{])/im;
const ASK_BLOCK_REGEX = /^[ \t]*<clk-ask>[ \t]*(?:\r?\n[ \t]*)?([\[{][\s\S]*?)[ \t]*<\/clk-ask>[ \t]*$/gim;
const ASK_BLOCK_OPEN_REGEX = /^[ \t]*<clk-ask>[ \t]*(?=$|[\[{])/im;
const INPUT_BLOCK_REGEX = /^[ \t]*<clk-input>[ \t]*(?:\r?\n[ \t]*)?([\[{][\s\S]*?)[ \t]*<\/clk-input>[ \t]*$/gim;
const INPUT_BLOCK_OPEN_REGEX = /^[ \t]*<clk-input>[ \t]*(?=$|[\[{])/im;
const LOCAL_MARKDOWN_IMAGE_REGEX = /!\[([^\]\n]*)\]\(([^)\n]+)\)/gu;

interface RawSendInstruction {
  type?: unknown;
  path?: unknown;
  caption?: unknown;
  name?: unknown;
  msg_type?: unknown;
  content?: unknown;
  local_path?: unknown;
}

interface RawAskInstruction {
  question?: unknown;
  options?: unknown;
  allowTextReply?: unknown;
  input?: unknown;
  submitText?: unknown;
}

interface RawInputInstruction {
  target?: unknown;
  text?: unknown;
  codelark_home?: unknown;
}

function normalizeManualInputTarget(value: unknown): string | ManualInputTargetSelector | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const fields: Array<[keyof ManualInputTargetSelector, string]> = [
    ['query', 'query'],
    ['chatId', 'chat_id'],
    ['chatName', 'chat_name'],
    ['botName', 'bot_name'],
    ['codelarkHome', 'codelark_home'],
    ['runtime', 'runtime'],
    ['runtimeStatus', 'runtime_status'],
  ];
  const allowedKeys = new Set(fields.map(([, sourceKey]) => sourceKey));
  if (Object.keys(raw).some((key) => !allowedKeys.has(key))) return null;
  const selector: ManualInputTargetSelector = {};
  for (const [targetKey, sourceKey] of fields) {
    const field = raw[sourceKey];
    if (field === undefined) continue;
    if (typeof field !== 'string' || !field.trim()) return null;
    selector[targetKey] = field.trim();
  }
  return Object.keys(selector).length > 0 ? selector : null;
}

export interface ParsedOutboundArtifacts {
  cleanText: string;
  attachments: OutboundAttachment[];
  questions: OutboundQuestion[];
  platformMessages: OutboundPlatformMessage[];
  manualInputs: OutboundManualInput[];
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
  platformMessages: OutboundPlatformMessage[];
  errors: string[];
} {
  const attachments: OutboundAttachment[] = [];
  const platformMessages: OutboundPlatformMessage[] = [];
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
    const msgType = typeof raw.msg_type === 'string' ? raw.msg_type.trim() : '';
    if (msgType) {
      const localPath = typeof raw.local_path === 'string' ? raw.local_path.trim() : '';
      if (localPath) {
        if ((msgType !== 'image' && msgType !== 'file') || !(path.isAbsolute(localPath) || path.win32.isAbsolute(localPath))) {
          errors.push('invalid-local-upload-instruction');
          continue;
        }
        attachments.push({
          kind: msgType,
          path: localPath,
          caption: typeof raw.caption === 'string' && raw.caption.trim() ? raw.caption.trim() : undefined,
          name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : undefined,
        });
        continue;
      }
      if (raw.content === undefined || raw.content === null) {
        errors.push('missing-feishu-message-content');
        continue;
      }
      platformMessages.push({ msgType, content: raw.content });
      continue;
    }
    const normalized = normalizeInstruction(raw);
    if (normalized) {
      attachments.push(normalized);
    } else {
      errors.push('invalid-send-instruction');
    }
  }

  return { attachments, platformMessages, errors };
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

function extractLocalMarkdownImages(text: string): {
  text: string;
  attachments: OutboundAttachment[];
} {
  const attachments: OutboundAttachment[] = [];
  const lines = text.split('\n');
  let fenceLength = 0;
  const rendered = lines.map((line) => {
    if (fenceLength > 0) {
      const closer = /^( {0,3})(`{3,})([^`]*)$/.exec(line);
      if (closer && closer[2].length >= fenceLength) fenceLength = 0;
      return line;
    }
    const opener = /^( {0,3})(`{3,})([^`]*)$/.exec(line);
    if (opener) {
      fenceLength = opener[2].length;
      return line;
    }
    if (/^(?: {4}|\t)/u.test(line)) return line;

    return line.replace(LOCAL_MARKDOWN_IMAGE_REGEX, (match, altText: string, destination: string) => {
      const filePath = destination.trim();
      if (!(path.isAbsolute(filePath) || path.win32.isAbsolute(filePath))) return match;
      attachments.push({
        kind: 'image',
        path: filePath,
        caption: altText.trim() || undefined,
        name: undefined,
      });
      return '';
    });
  });
  return { text: rendered.join('\n'), attachments };
}

function normalizeManualInputPayload(payload: unknown): { inputs: OutboundManualInput[]; errors: string[] } {
  const records = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { items?: unknown }).items)
      ? (payload as { items: unknown[] }).items
      : [payload];
  const inputs: OutboundManualInput[] = [];
  const errors: string[] = [];
  for (const value of records) {
    const raw = value && typeof value === 'object' ? value as RawInputInstruction : {};
    const target = normalizeManualInputTarget(raw.target);
    const text = typeof raw.text === 'string' ? raw.text : '';
    if (!target || !text.trim()) {
      errors.push('invalid-manual-input-instruction');
      continue;
    }
    inputs.push({
      target,
      text,
      ...(typeof raw.codelark_home === 'string' && raw.codelark_home.trim()
        ? { codelarkHome: raw.codelark_home.trim() }
        : {}),
    });
  }
  return { inputs, errors };
}

export function parseOutboundArtifacts(text: string): ParsedOutboundArtifacts {
  const attachments: OutboundAttachment[] = [];
  const questions: OutboundQuestion[] = [];
  const platformMessages: OutboundPlatformMessage[] = [];
  const manualInputs: OutboundManualInput[] = [];
  const errors: string[] = [];
  let mutated = text ?? '';

  mutated = mutated.replace(SEND_BLOCK_REGEX, (_full, payloadText: string) => {
    try {
      const payload = JSON.parse(payloadText);
      const normalized = normalizeInstructionPayload(payload);
      attachments.push(...normalized.attachments);
      platformMessages.push(...normalized.platformMessages);
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

  mutated = mutated.replace(INPUT_BLOCK_REGEX, (_full, payloadText: string) => {
    try {
      const normalized = normalizeManualInputPayload(JSON.parse(payloadText));
      manualInputs.push(...normalized.inputs);
      errors.push(...normalized.errors);
    } catch {
      errors.push('invalid-manual-input-json');
    }
    return '';
  });

  const localMarkdownImages = extractLocalMarkdownImages(mutated);
  mutated = localMarkdownImages.text;
  attachments.push(...localMarkdownImages.attachments);

  return {
    cleanText: compactBlankLines(mutated),
    attachments,
    questions,
    platformMessages,
    manualInputs,
    errors,
  };
}

export function stripOutboundArtifactBlocksForStreaming(text: string): string {
  if (!text) return '';

  let stripped = text.replace(SEND_BLOCK_REGEX, '').replace(ASK_BLOCK_REGEX, '').replace(INPUT_BLOCK_REGEX, '');
  const sendOpenMatch = SEND_BLOCK_OPEN_REGEX.exec(stripped);
  const askOpenMatch = ASK_BLOCK_OPEN_REGEX.exec(stripped);
  const inputOpenMatch = INPUT_BLOCK_OPEN_REGEX.exec(stripped);
  const openMatch = [sendOpenMatch, askOpenMatch, inputOpenMatch]
    .filter((match): match is RegExpExecArray => Boolean(match))
    .sort((a, b) => a.index - b.index)[0];
  if (openMatch) {
    stripped = stripped.slice(0, openMatch.index);
  }

  stripped = extractLocalMarkdownImages(stripped).text;
  return stripped.replace(/\n{3,}/g, '\n\n').trimEnd();
}

export function supportsOutboundArtifacts(provider: string): boolean {
  return provider === 'feishu';
}
