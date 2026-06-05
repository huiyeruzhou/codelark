/**
 * Input validation and sanitization for bridge IM commands.
 *
 * Prevents path traversal, command injection, and other dangerous inputs
 * from reaching the conversation engine or file system operations.
 */

import * as path from 'path';

// ── Constants ────────────────────────────────────────────────────

const MAX_INPUT_LENGTH = 32_000;
const MAX_PATH_LENGTH = 1024;
const SESSION_ID_PATTERN = /^[0-9a-f-]{32,64}$/i;
const VALID_MODES = ['normal', 'yolo'] as const;

/**
 * Patterns that indicate shell injection or dangerous input.
 * Each entry has a regex and a human-readable reason.
 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\x00/, reason: 'null byte' },
  { pattern: /\.\.[/\\]/, reason: 'path traversal (../)' },
  { pattern: /\$\(/, reason: 'command substitution $()' },
  { pattern: /`[^`]*`/, reason: 'backtick command substitution' },
  { pattern: /;\s*(rm|cat|curl|wget|chmod|chown|mv|cp|dd|mkfs|shutdown|reboot)\b/, reason: 'chained dangerous command' },
  { pattern: /\|\s*(bash|sh|zsh|exec)\b/, reason: 'pipe to shell' },
  { pattern: />\s*\//, reason: 'redirect to absolute path' },
];

// ── Validators ───────────────────────────────────────────────────

/**
 * Validate a working directory path.
 * Must be an absolute path without traversal or shell metacharacters.
 * Returns sanitized path or null if invalid.
 */
export function validateWorkingDirectory(rawPath: string): string | null {
  if (!rawPath || !rawPath.trim()) return null;

  const trimmed = rawPath.trim();
  const normalizedForHost = path.isAbsolute(trimmed)
    ? trimmed
    : (path.win32.isAbsolute(trimmed) ? path.resolve(trimmed) : '');

  if (!normalizedForHost) return null;

  // Reject null bytes
  if (normalizedForHost.includes('\0')) return null;

  // Reject path traversal segments
  const segments = normalizedForHost.split(/[/\\]/);
  if (segments.some(s => s === '..')) return null;

  // Reject if too long
  if (normalizedForHost.length > MAX_PATH_LENGTH) return null;

  // Reject shell metacharacters that have no place in a directory path
  if (/[$`;|&><(){}\x00-\x1f]/.test(normalizedForHost)) return null;

  return path.normalize(normalizedForHost);
}

/**
 * Validate a session ID format.
 * Must be a hex string or UUID, 32-64 characters.
 */
export function validateSessionId(id: string): boolean {
  if (!id || !id.trim()) return false;
  return SESSION_ID_PATTERN.test(id.trim());
}

/**
 * Check if input contains dangerous patterns (path traversal, command injection, etc.).
 * Returns { dangerous: false } for safe inputs or { dangerous: true, reason } for threats.
 */
export function isDangerousInput(input: string): { dangerous: boolean; reason?: string } {
  if (!input) return { dangerous: false };

  // Excessively long input
  if (input.length > MAX_INPUT_LENGTH * 2) {
    return { dangerous: true, reason: `excessively long input (${input.length} chars)` };
  }

  // Null bytes
  if (input.includes('\0')) {
    return { dangerous: true, reason: 'null byte detected' };
  }

  // Check known dangerous patterns
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(input)) {
      return { dangerous: true, reason };
    }
  }

  return { dangerous: false };
}

/**
 * Sanitize general text input: strip control characters (except newline/tab)
 * and enforce max length.
 * Returns { text, truncated } — truncated is true if the input was shortened.
 */
export function sanitizeInput(
  text: string,
  maxLength: number = MAX_INPUT_LENGTH,
): { text: string; truncated: boolean } {
  if (!text) return { text: '', truncated: false };

  // Strip control characters except \n (0x0A) and \t (0x09)
  // eslint-disable-next-line no-control-regex
  let sanitized = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  const truncated = sanitized.length > maxLength;
  if (truncated) {
    sanitized = sanitized.slice(0, maxLength);
  }

  return { text: sanitized, truncated };
}

export type BridgeCommandMode = typeof VALID_MODES[number];

/**
 * Parse /mode parameter. `code` is kept as the only legacy alias.
 */
export function parseMode(mode: string): BridgeCommandMode | null {
  const normalized = mode.trim().toLowerCase();
  if (normalized === 'code' || normalized === 'normal') return 'normal';
  if (normalized === 'yolo') return 'yolo';
  return null;
}

/**
 * Validate /mode parameter.
 */
export function validateMode(mode: string): boolean {
  return parseMode(mode) !== null;
}
