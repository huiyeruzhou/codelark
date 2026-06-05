import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import pino, { type DestinationStream, type Logger } from 'pino';
import { CODELARK_HOME } from '../configuration/index.js';

const MASK_PATTERNS: RegExp[] = [
  /(?:token|secret|password|api_key)["']?\s*[:=]\s*["']?([^\s"',]+)/gi,
  /bot\d+:[A-Za-z0-9_-]{35}/g,
  /Bearer\s+[A-Za-z0-9._-]+/g,
];

export function maskSecrets(text: string): string {
  let result = text;
  for (const pattern of MASK_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => {
      if (match.length <= 4) return match;
      return '*'.repeat(match.length - 4) + match.slice(-4);
    });
  }
  return result;
}

const LOG_DIR = path.join(CODELARK_HOME, 'logs');
const LOG_PATH = path.join(LOG_DIR, 'bridge.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROTATED = 3;
const SECRET_FIELD_PATTERN = /token|secret|password|api_key/i;

let logStream: fs.WriteStream | null = null;

interface ConsoleLogPayload {
  message: string;
  fields: Record<string, unknown>;
}

export function formatLogArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`;
  }
  if (value === null) return 'null';
  if (typeof value === 'undefined') return 'undefined';
  if (typeof value === 'object') {
    return inspect(value, {
      depth: 4,
      breakLength: Infinity,
      compact: true,
    });
  }

  return String(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseConsolePrefix(message: string): { name?: string; message: string } {
  const match = message.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (!match) return { message };
  return {
    name: match[1],
    message: match[2] || message,
  };
}

export function formatConsoleLogArgs(args: unknown[]): ConsoleLogPayload {
  if (typeof args[0] === 'string' && isPlainRecord(args[1])) {
    const parsed = parseConsolePrefix(args[0]);
    const trailing = args.slice(2).map((arg) => formatLogArg(arg));
    return {
      message: [parsed.message, ...trailing].filter(Boolean).join(' '),
      fields: {
        source: 'console',
        ...(parsed.name ? { name: parsed.name } : {}),
        ...args[1],
      },
    };
  }

  return {
    message: args.map((arg) => formatLogArg(arg)).join(' '),
    fields: { source: 'console' },
  };
}

function openLogStream(): fs.WriteStream {
  return fs.createWriteStream(LOG_PATH, { flags: 'a' });
}

function ensureLogStream(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  if (!logStream) {
    logStream = openLogStream();
  }
}

function rotateIfNeeded(): void {
  try {
    const stat = fs.statSync(LOG_PATH);
    if (stat.size < MAX_LOG_SIZE) return;
  } catch {
    return; // file doesn't exist yet
  }

  // Close current stream
  if (logStream) {
    logStream.end();
    logStream = null;
  }

  // Rotate: delete .3, shift .2→.3, .1→.2, current→.1
  const path3 = `${LOG_PATH}.${MAX_ROTATED}`;
  if (fs.existsSync(path3)) fs.unlinkSync(path3);

  for (let i = MAX_ROTATED - 1; i >= 1; i--) {
    const src = `${LOG_PATH}.${i}`;
    const dst = `${LOG_PATH}.${i + 1}`;
    if (fs.existsSync(src)) fs.renameSync(src, dst);
  }

  fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
  logStream = openLogStream();
}

function maskSecretValue(value: string): string {
  if (value.length <= 4) return value;
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

function maskStructuredValue(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    return key && SECRET_FIELD_PATTERN.test(key)
      ? maskSecretValue(value)
      : maskSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskStructuredValue(item));
  }
  if (value && typeof value === 'object') {
    if (key && SECRET_FIELD_PATTERN.test(key)) {
      return '[redacted]';
    }
    const masked: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      masked[childKey] = maskStructuredValue(childValue, childKey);
    }
    return masked;
  }
  return value;
}

export function maskStructuredLogLine(line: string): string {
  const newline = line.endsWith('\n') ? '\n' : '';
  const trimmed = newline ? line.slice(0, -1) : line;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return JSON.stringify(maskStructuredValue(parsed)) + newline;
  } catch {
    return maskSecrets(line);
  }
}

const logDestination: DestinationStream = {
  write(line: string): void {
    ensureLogStream();
    rotateIfNeeded();
    logStream?.write(maskStructuredLogLine(line));
  },
};

const rootLogger = pino({
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label.toUpperCase() };
    },
  },
}, logDestination);

export function getLogger(name: string): Logger {
  return rootLogger.child({ name });
}

export function setupLogger(): void {
  ensureLogStream();
  const write = (level: string, args: unknown[]) => {
    const payload = formatConsoleLogArgs(args);
    if (level === 'ERROR') {
      rootLogger.error(payload.fields, payload.message);
    } else if (level === 'WARN') {
      rootLogger.warn(payload.fields, payload.message);
    } else {
      rootLogger.info(payload.fields, payload.message);
    }
  };

  console.log = (...args: unknown[]) => write('INFO', args);
  console.error = (...args: unknown[]) => write('ERROR', args);
  console.warn = (...args: unknown[]) => write('WARN', args);
}
