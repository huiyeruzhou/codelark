import path from 'node:path';

import type { BridgeSession } from '../../../domain/session.js';
import { getSessionWorkingDirectory } from '../../../domain/session-runtime.js';

export function stripLegacySessionPrefix(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/^Desktop:\s*/i, '').trim() || trimmed;
}

export function getSessionDisplayName(session: BridgeSession | null | undefined, fallbackDirectory?: string): string {
  if (session?.name?.trim()) return stripLegacySessionPrefix(session.name);
  const cwd = getSessionWorkingDirectory(session) || fallbackDirectory || '';
  if (cwd) return path.basename(cwd) || cwd;
  if (session?.id) return session.id.slice(0, 8);
  return '未命名会话';
}
