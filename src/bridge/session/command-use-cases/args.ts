import type { BridgeSession } from '../../../domain/index.js';
import { getSessionCodexTitle } from '../../../domain/session-runtime.js';

function parseCommandArgs(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const args: string[] = [];
  let i = 0;
  while (i < trimmed.length) {
    while (i < trimmed.length && /\s/.test(trimmed[i])) i += 1;
    if (i >= trimmed.length) break;
    const quote = trimmed[i];
    if (quote === '"' || quote === "'") {
      i += 1;
      let escaped = false;
      let value = '';
      for (; i < trimmed.length; i += 1) {
        const ch = trimmed[i];
        if (escaped) {
          value += ch;
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === quote) {
          i += 1;
          break;
        }
        value += ch;
      }
      if (i > trimmed.length || trimmed[i - 1] !== quote) return null;
      args.push(value);
      continue;
    }
    let escaped = false;
    let value = '';
    for (; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (escaped) {
        value += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (/\s/.test(ch)) break;
      value += ch;
    }
    args.push(value);
  }
  return args;
}

export const SESSION_ARG_QUOTE_NOTE = '名称或路径包含空格时，请使用英文双引号 `"` 或英文单引号 `\'`。';
export const NEW_SESSION_ARG_RULE_NOTE = `参数规则：\`/new [name] [path]\` 会创建一个新的群聊；${SESSION_ARG_QUOTE_NOTE}`;
export const CLEAR_SESSION_ARG_RULE_NOTE = `参数规则：\`/clear [name] [path]\` 会在当前聊天上下文创建一个新的对话；${SESSION_ARG_QUOTE_NOTE}之后可用 \`/t\` 重新附加到之前的对话。`;

function parseSessionCreationArgs(
  args: string,
  command: '/new' | '/clear',
  argRuleNote: string,
): { name?: string; pathArgs: string } | { error: string } {
  const parsed = parseCommandArgs(args);
  if (!parsed) return { error: `参数格式无效。名称或路径包含空格时，请使用英文双引号 \`"\` 或英文单引号 \`'\`，例如 \`${command} \"项目/前端\" ~/work/proj\`。` };
  if (parsed.length > 2) return { error: `参数过多。${argRuleNote}` };
  return { name: parsed[0], pathArgs: parsed[1] || '' };
}

export function parseForceFlag(args: string): { args: string; force: boolean } {
  const forcePattern = /(^|\s)--force(?=\s|$)/;
  const force = forcePattern.test(args);
  const cleaned = args.replace(/(^|\s)--force(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  return { args: cleaned, force };
}

export function parseClearConfirmationFlag(args: string): { args: string; confirmed: boolean } {
  const confirmed = /(^|\s)--yes(?=\s|$)/.test(args);
  const cleaned = args.replace(/(^|\s)--yes(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  return { args: cleaned, confirmed };
}

export function parseNewSessionArgs(args: string): { name?: string; pathArgs: string } | { error: string } {
  return parseSessionCreationArgs(args, '/new', NEW_SESSION_ARG_RULE_NOTE);
}

export function parseClearSessionArgs(args: string): { name?: string; pathArgs: string } | { error: string } {
  return parseSessionCreationArgs(args, '/clear', CLEAR_SESSION_ARG_RULE_NOTE);
}

function isReservedThreadName(name: string): boolean {
  const trimmed = name.trim();
  return /^\d+$/.test(trimmed)
    || /^[0-9a-f]{8,}$/i.test(trimmed)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed);
}

export function validateThreadName(raw: string): { ok: true; name: string } | { ok: false; message: string } {
  const name = raw.trim();
  if (!name) return { ok: false, message: '用法：/t rename <新名称>。' };
  if (name.length > 80) return { ok: false, message: '名称过长，请控制在 80 个字符以内。' };
  if (/[\x00-\x1f\x7f]/.test(name)) return { ok: false, message: '名称不能包含控制字符。' };
  if (isReservedThreadName(name)) {
    return { ok: false, message: '名称不能是纯数字，也不能长得像 binding id 或 runtime id。' };
  }
  return { ok: true, name };
}

export function validateNewSessionName(raw: string): { ok: true; name: string } | { ok: false; message: string } {
  const parsed = validateThreadName(raw);
  if (parsed.ok) return parsed;
  return {
    ok: false,
    message: parsed.message.replace('用法：/t rename <新名称>。', '用法：/new <name> [path]。'),
  };
}

function lastPathSegment(value: string | null | undefined): string {
  const normalized = value?.trim() || '';
  if (!normalized) return '';
  return normalized.split(/[\\/]+/).filter(Boolean).at(-1) || '';
}

export function deriveNewGroupName(rawName: string | undefined, currentSession: BridgeSession | null, workDir: string): string {
  return rawName?.trim()
    || currentSession?.name?.trim()
    || getSessionCodexTitle(currentSession)
    || lastPathSegment(workDir)
    || 'new';
}

function quoteCommandArg(value: string): string {
  return /[\s"'\\]/.test(value)
    ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : value;
}

export function buildClearConfirmedCommand(args: string): string {
  const parsed = parseClearSessionArgs(args);
  if ('error' in parsed) return `/clear --yes ${args}`.trim();
  return ['/clear', '--yes', parsed.name, parsed.pathArgs]
    .filter((part): part is string => Boolean(part))
    .map((part, index) => index < 2 ? part : quoteCommandArg(part))
    .join(' ');
}
