import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSupportedImagePath } from '../../shared/image-path.js';
import { maskMarkdownCode } from '../../shared/markdown/code-mask.js';

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
const LOCAL_MARKDOWN_LINK_REGEX = /(!?)\[([^\]\n]*)\]\((<[^>\n]+>|(?:\\.|[^)\\\n])+)\)/gu;

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
  references: string[];
  errors: string[];
} {
  const attachments: OutboundAttachment[] = [];
  const platformMessages: OutboundPlatformMessage[] = [];
  const errors: string[] = [];
  const references: string[] = [];

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
    const reference = sourceLocationLink({
      path: typeof raw.local_path === 'string' ? raw.local_path : typeof raw.path === 'string' ? raw.path : '',
      name: typeof raw.name === 'string' ? raw.name : undefined,
      caption: typeof raw.caption === 'string' ? raw.caption : undefined,
    });
    if (reference) { references.push(reference); continue; }
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

  if (!objects.length) errors.push('invalid-send-instruction');
  return { attachments, platformMessages, references, errors };
}

/** A source position is a reference, never a local file upload target. */
export function sourceLocationLink(attachment: { path: string; name?: string; caption?: string }): string | null {
  const target = attachment.path.trim();
  if (!(path.isAbsolute(target) || path.win32.isAbsolute(target) || /^file:/iu.test(target))) return null;
  if (!/(?::\d+(?::\d+)?(?:-\d+(?::\d+)?)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/u.test(target)) return null;
  const label = (attachment.caption || attachment.name || target.split(/[\\/]/u).at(-1) || target)
    .replace(/([\\[\]])/gu, '\\$1');
  return `[${label}](<${target.replace(/>/gu, '%3E')}>)`;
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

/** Decode a file: URL with the host platform's rules, then the other platform's. */
export function fileUrlToLocalPath(url: string, platform: NodeJS.Platform = process.platform): string | null {
  const windows = platform === 'win32';
  try { return fileURLToPath(url, { windows }); } catch { /* try the other platform's rules */ }
  try { return fileURLToPath(url, { windows: !windows }); } catch { return null; }
}

function localMarkdownPath(destination: string): string | null {
  let value = destination.trim().replace(/\s+["'][^"']*["']$/, '');
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1);
  if (sourceLocationLink({ path: value })) return value;
  if (/^file:/i.test(value)) {
    // On Windows fileURLToPath rejects drive-less URLs such as file:///tmp/x;
    // fall back to POSIX semantics so the link is classified the same on every OS.
    const decoded = fileUrlToLocalPath(value);
    if (!decoded) return null;
    value = decoded;
  } else {
    try { value = decodeURIComponent(value); } catch { /* literal percent in a file name */ }
    value = value.replace(/\\([()\[\] ])/g, '$1');
  }
  return (path.isAbsolute(value) || path.win32.isAbsolute(value)) && !/[\r\n\0]/.test(value) ? value : null;
}

function extractLocalMarkdownImages(text: string): {
  text: string;
  attachments: OutboundAttachment[];
} {
  const attachments: OutboundAttachment[] = [];
  if (!text.includes('[')) return { text, attachments };
  const codeMask = maskMarkdownCode(text);
  let lineOffset = 0;
  const lines = text.split('\n');
  const rendered = lines.map((line) => {
    const offset = lineOffset;
    lineOffset += line.length + 1;
    return line.replace(LOCAL_MARKDOWN_LINK_REGEX, (match, bang: string, altText: string, destination: string, index: number) => {
      if (codeMask[offset + index] !== match[0]) return match;
      const escapes = /\\+$/u.exec(line.slice(0, index))?.[0].length || 0;
      if (escapes % 2) return match;
      const filePath = localMarkdownPath(destination);
      if (!filePath) return match;
      if (!isSupportedImagePath(filePath) || sourceLocationLink({ path: filePath })) {
        return bang ? match.slice(1) : match;
      }
      attachments.push({
        kind: 'image',
        path: filePath,
        caption: altText.trim() || undefined,
        name: undefined,
      });
      // Native image delivery supplements the answer; keep its original link.
      // Local image syntax must become a link because CardKit expects img_* keys.
      return bang ? match.slice(1) : match;
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

  const replaceBlocks = (pattern: RegExp, process: (full: string, payload: string) => string) => {
    if (mutated.search(pattern) < 0) return;
    const codeMask = maskMarkdownCode(mutated);
    mutated = mutated.replace(pattern, (full: string, payload: string, offset: number) =>
      /<clk-/iu.test(codeMask.slice(offset, offset + full.indexOf('>') + 1)) ? process(full, payload) : full);
  };
  replaceBlocks(SEND_BLOCK_REGEX, (full, payloadText) => {
    try {
      const payload = JSON.parse(payloadText);
      const normalized = normalizeInstructionPayload(payload);
      errors.push(...normalized.errors);
      if (normalized.errors.length) return full;
      attachments.push(...normalized.attachments);
      platformMessages.push(...normalized.platformMessages);
      return normalized.references.join('\n');
    } catch {
      errors.push('invalid-send-json');
      return full;
    }
  });

  replaceBlocks(ASK_BLOCK_REGEX, (full, payloadText) => {
    try {
      const payload = JSON.parse(payloadText);
      const normalized = normalizeAskPayload(payload);
      errors.push(...normalized.errors);
      if (normalized.errors.length || !normalized.questions.length) return full;
      questions.push(...normalized.questions);
    } catch {
      errors.push('invalid-ask-json');
      return full;
    }
    return '';
  });

  replaceBlocks(INPUT_BLOCK_REGEX, (full, payloadText) => {
    try {
      const normalized = normalizeManualInputPayload(JSON.parse(payloadText));
      errors.push(...normalized.errors);
      if (normalized.errors.length || !normalized.inputs.length) return full;
      manualInputs.push(...normalized.inputs);
    } catch {
      errors.push('invalid-manual-input-json');
      return full;
    }
    return '';
  });

  const localMarkdownAttachments = extractLocalMarkdownImages(mutated);
  mutated = localMarkdownAttachments.text;
  attachments.push(...localMarkdownAttachments.attachments);

  return {
    cleanText: errors.length && mutated === text ? text : compactBlankLines(mutated),
    attachments,
    questions,
    platformMessages,
    manualInputs,
    errors,
  };
}

export function stripOutboundArtifactBlocksForStreaming(text: string): string {
  if (!text) return '';

  let stripped = parseOutboundArtifacts(text).cleanText;
  if (!/<clk-(?:send|ask|input)>/iu.test(stripped)) return stripped;
  const mask = maskMarkdownCode(stripped);
  const sendOpenMatch = SEND_BLOCK_OPEN_REGEX.exec(mask);
  const askOpenMatch = ASK_BLOCK_OPEN_REGEX.exec(mask);
  const inputOpenMatch = INPUT_BLOCK_OPEN_REGEX.exec(mask);
  const openMatch = [sendOpenMatch, askOpenMatch, inputOpenMatch]
    .filter((match): match is RegExpExecArray => Boolean(match))
    .sort((a, b) => a.index - b.index)[0];
  const remainder = openMatch ? stripped.slice(openMatch.index + openMatch[0].length) : '';
  // Hide only an unfinished JSON instruction. A failed complete block or a
  // Markdown link beginning with '[' remains ordinary visible source text.
  if (openMatch && !/<\/clk-(?:send|ask|input)>/iu.test(remainder)
      && /^\s*(?:\{\s*(?:"|$)|\[\s*(?:\{|$)|$)/u.test(remainder)) {
    stripped = stripped.slice(0, openMatch.index);
  }

  return stripped.replace(/\n{3,}/g, '\n\n').trimEnd();
}

export function supportsOutboundArtifacts(provider: string): boolean {
  return provider === 'feishu';
}
