import type { TmuxSendAction } from '../tmux/runtime.js';

export const DEFAULT_CAPTURE_LINES = 20;
const MIN_CAPTURE_LINES = 1;
const MAX_CAPTURE_LINES = 500;
const MIN_SCREEN_INTERVAL_SECONDS = 3;

export interface TmuxScreenArgs {
  action: 'show' | 'stop';
  lines?: number;
  intervalSeconds?: number;
}

export function normalizeCaptureLines(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : Number(String(value || '').trim());
  if (!Number.isFinite(parsed)) return DEFAULT_CAPTURE_LINES;
  return Math.min(MAX_CAPTURE_LINES, Math.max(MIN_CAPTURE_LINES, Math.floor(parsed)));
}

function parseCaptureLineLimit(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_CAPTURE_LINES) return null;
  return normalizeCaptureLines(parsed);
}

export function validateTmuxSessionName(raw: string): string | null {
  const name = raw.trim();
  if (!name || name.length > 120) return null;
  if (/[\x00-\x1f\x7f]/.test(name)) return null;
  return name;
}

export function formatOnOff(value: boolean): string {
  return value ? 'on' : 'off';
}

function canonicalBaseKey(raw: string): string | null {
  const normalized = raw.trim();
  const lower = normalized.toLowerCase();
  const named: Record<string, string> = {
    enter: 'Enter',
    return: 'Enter',
    tab: 'Tab',
    esc: 'Escape',
    escape: 'Escape',
    space: 'Space',
    backspace: 'BSpace',
    bs: 'BSpace',
    delete: 'DC',
    del: 'DC',
    up: 'Up',
    down: 'Down',
    left: 'Left',
    right: 'Right',
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pagedown: 'PageDown',
  };
  if (named[lower]) return named[lower];
  if (/^f(?:[1-9]|1[0-2])$/i.test(normalized)) return normalized.toUpperCase();
  if (/^[A-Za-z0-9]$/.test(normalized)) return normalized.toLowerCase();
  return null;
}

function parseSpecialKeyToken(raw: string): { key?: string; error?: string } {
  const compact = raw.trim().replace(/\s+/g, '');
  if (!compact) return { error: '空的特殊键。' };

  const modifierMatch = compact.match(/^(ctrl|control|c|cmd|command|option|opt|alt|m)[+-](.+)$/i);
  if (modifierMatch) {
    const modifier = modifierMatch[1].toLowerCase();
    const base = canonicalBaseKey(modifierMatch[2]);
    if (!base) return { error: `不支持的特殊键：<${raw}>。` };
    if ((modifier === 'cmd' || modifier === 'command') && base === 'BSpace') {
      return { key: 'C-u' };
    }
    if (modifier === 'ctrl' || modifier === 'control' || modifier === 'c' || modifier === 'cmd' || modifier === 'command') {
      return { key: `C-${base}` };
    }
    return { key: `M-${base}` };
  }

  const base = canonicalBaseKey(compact);
  if (!base) return { error: `不支持的特殊键：<${raw}>。` };
  return { key: base };
}

export function parseTmuxSendActions(raw: string): { actions?: TmuxSendAction[]; error?: string } {
  const actions: TmuxSendAction[] = [];
  const pattern = /<([^<>]+)>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(raw)) !== null) {
    const literal = raw.slice(lastIndex, match.index);
    if (literal) actions.push({ type: 'literal', text: literal });

    const parsedKey = parseSpecialKeyToken(match[1]);
    if (parsedKey.error) return { error: parsedKey.error };
    actions.push({ type: 'key', key: parsedKey.key! });
    lastIndex = pattern.lastIndex;
  }

  const trailing = raw.slice(lastIndex);
  if (trailing) actions.push({ type: 'literal', text: trailing });
  return { actions };
}

export function parseTmuxKeySequence(raw: string): TmuxSendAction[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const actions: TmuxSendAction[] = [];
  const pattern = /<([^<>]+)>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(trimmed)) !== null) {
    if (trimmed.slice(lastIndex, match.index).trim()) return null;
    const parsedKey = parseSpecialKeyToken(match[1]);
    if (parsedKey.error) return null;
    actions.push({ type: 'key', key: parsedKey.key! });
    lastIndex = pattern.lastIndex;
  }

  if (trimmed.slice(lastIndex).trim()) return null;
  return actions.length > 0 ? actions : null;
}

export function isPureSpecialKeySyntax(raw: string): boolean {
  const trimmed = raw.trim();
  return Boolean(trimmed) && /^(?:<[^<>]+>\s*)+$/.test(trimmed);
}

function parseOnOff(raw: string): boolean | null {
  const token = raw.trim().toLowerCase();
  if (['on', 'true', '1', 'yes', 'enable', 'enabled'].includes(token)) return true;
  if (['off', 'false', '0', 'no', 'disable', 'disabled'].includes(token)) return false;
  return null;
}

export function parseTmuxSetArgs(args: string): { key: 'lines'; value: number } | { key: 'echo'; value: boolean } | null {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 2) return null;
  const key = parts[0].toLowerCase();
  if (['lines', 'line', 'rows', 'row', 'capture-lines', 'capture'].includes(key)) {
    const value = parseCaptureLineLimit(parts[1]);
    return value === null ? null : { key: 'lines', value };
  }
  if (['echo', 'echo-input', 'input-echo', 'replay'].includes(key)) {
    const value = parseOnOff(parts[1]);
    return value === null ? null : { key: 'echo', value };
  }
  return null;
}

function parseIntervalSeconds(raw: string): number | null {
  const token = raw.trim().toLowerCase();
  const match = token.match(/^(\d+)s$/);
  if (!match) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return Math.max(MIN_SCREEN_INTERVAL_SECONDS, Math.floor(parsed));
}

export function parseTmuxScreenArgs(args: string): TmuxScreenArgs | null {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { action: 'show' };
  if (parts.length === 1 && parts[0].toLowerCase() === 'stop') return { action: 'stop' };

  let lines: number | undefined;
  let intervalSeconds: number | undefined;

  if (parts.length === 1) {
    const token = parts[0].toLowerCase();
    const interval = parseIntervalSeconds(token);
    if (interval) return { action: 'show', intervalSeconds: interval };
    const parsedLines = parseCaptureLineLimit(token);
    if (parsedLines !== null) return { action: 'show', lines: parsedLines };
    return null;
  }

  if (parts.length !== 2) return null;
  const [lineToken, intervalToken] = parts.map((part) => part.toLowerCase());
  const parsedLines = parseCaptureLineLimit(lineToken);
  if (parsedLines === null) return null;
  lines = parsedLines;
  intervalSeconds = parseIntervalSeconds(intervalToken) ?? undefined;
  if (!intervalSeconds) return null;

  return { action: 'show', lines, intervalSeconds };
}
