export const REASONING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export const LOCAL_SESSION_LIST_LIMIT_OPTIONS = [20, 50, 100] as const;
export const DEFAULT_LOCAL_SESSION_LIST_LIMIT = 20;
export const MAX_LOCAL_SESSION_LIST_LIMIT = 100;
export type LocalSessionListRuntime = 'codex' | 'claude' | 'kimi' | 'cursor';

export function parseListIndex(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

export function resolveCommandAlias(rawCommand: string, args: string): string {
  switch (rawCommand) {
    case '/check':
      return '/health';
    case '/':
      return '/current';
    case '/currnet':
      return '/current';
    case '/h':
      return '/help';
    case '/t':
      return /^(ls|archive|rename|unbind)\b/i.test(args.trim())
        ? '/t'
        : !args
        ? '/threads'
        : /^(all|n\b|codex\b|claude\b|kimi\b|cursor\b|runtime\b)/i.test(args.trim())
          ? '/threads'
          : '/thread';
    case '/n':
      return '/new';
    case '/m':
      return '/mode';
    case '/p':
      return '/provider';
    case '/r':
      return '/reasoning';
    case '/sb':
      return '/sandbox';
    case '/net':
      return '/network';
    case '/ui':
      return '/ui';
    case '/his':
      return '/history';
    case '/hotupdate':
      return '/hot-update';
    case '/tmux-keys':
      return '/tmux-key';
    default:
      return rawCommand;
  }
}

const KNOWN_BRIDGE_COMMANDS = new Set([
  '/start',
  '/new',
  '/new-form',
  '/clear',
  '/clear-cancel',
  '/thread',
  '/threads',
  '/t',
  '/tmux',
  '/tmux-key',
  '/tmux-keys',
  '/tmux-switch',
  '/tmux-attach',
  '/tmux-new',
  '/tmux-status',
  '/tmux-screen',
  '/pty-screen',
  '/tmux-set',
  '/set',
  '/every',
  '/every-form',
  '/then',
  '/then-form',
  '/reasoning',
  '/runtime',
  '/cd',
  '/cwd',
  '/mode',
  '/provider',
  '/sandbox',
  '/network',
  '/ui',
  '/require-at',
  '/model',
  '/status',
  '/current',
  '/currnet',
  '/current-config',
  '/current-runtime',
  '/health',
  '/doctor',
  '/history',
  '/hot-update',
  '/shell',
  '/cat',
  '/file',
  '/stop',
  '/help',
]);

export function isKnownBridgeCommand(rawCommand: string, args = ''): boolean {
  return KNOWN_BRIDGE_COMMANDS.has(resolveCommandAlias(rawCommand.toLowerCase(), args));
}

export function isEscapedSlashPrompt(rawText: string): boolean {
  return rawText.trim().startsWith('//');
}

export function isBridgeCommandText(rawText: string): boolean {
  const trimmed = rawText.trim();
  return trimmed.startsWith('/') && !trimmed.startsWith('//');
}

export function toModelPromptText(rawText: string): string {
  const trimmed = rawText.trim();
  return trimmed.startsWith('//') ? trimmed.slice(1) : trimmed;
}

export function parseLocalSessionListArgs(args: string): { showAll: boolean; limit: number; runtime?: LocalSessionListRuntime } | null {
  const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let runtime: LocalSessionListRuntime | undefined;
  if (parts[0] === 'runtime') parts.shift();
  if (parts[0] === 'codex' || parts[0] === 'claude' || parts[0] === 'kimi' || parts[0] === 'cursor') {
    runtime = parts.shift() as LocalSessionListRuntime;
  }
  if (parts.length === 0) {
    return { showAll: false, limit: DEFAULT_LOCAL_SESSION_LIST_LIMIT, ...(runtime ? { runtime } : {}) };
  }
  if (parts.length === 1 && parts[0] === 'all') {
    return { showAll: true, limit: MAX_LOCAL_SESSION_LIST_LIMIT, ...(runtime ? { runtime } : {}) };
  }
  const match = parts.join(' ').match(/^n\s+(\d+)$/);
  if (!match) return null;
  const requestedLimit = Number(match[1]);
  const limit = Math.min(requestedLimit, MAX_LOCAL_SESSION_LIST_LIMIT);
  if (!Number.isInteger(limit) || limit < 1) return null;
  return { showAll: false, limit, ...(runtime ? { runtime } : {}) };
}

export function normalizeReasoningEffort(raw: string): typeof REASONING_LEVELS[number] | null {
  const token = raw.trim().toLowerCase();
  if (!token) return null;
  if (REASONING_LEVELS.includes(token as typeof REASONING_LEVELS[number])) {
    return token as typeof REASONING_LEVELS[number];
  }

  switch (token) {
    case '1':
      return 'minimal';
    case '2':
      return 'low';
    case '3':
      return 'medium';
    case '4':
      return 'high';
    case '5':
      return 'xhigh';
    default:
      return null;
  }
}
