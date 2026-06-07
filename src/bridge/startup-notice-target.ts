import fs from 'node:fs';
import path from 'node:path';

import { CODELARK_HOME } from '../configuration/paths.js';
import type { ChannelAddress } from '../domain/channel.js';

const STARTUP_TARGET_PATH = path.join(CODELARK_HOME, 'data', 'startup-notice-target.json');
const STARTUP_TARGET_TTL_MS = 30 * 60 * 1000;

export interface StartupNoticeTarget {
  address: ChannelAddress;
  sessionId?: string;
  createdAt: number;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function saveStartupNoticeTarget(address: ChannelAddress, sessionId?: string): void {
  const record: StartupNoticeTarget = {
    address,
    sessionId,
    createdAt: Date.now(),
  };
  ensureParentDir(STARTUP_TARGET_PATH);
  const tmpPath = `${STARTUP_TARGET_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), 'utf-8');
  fs.renameSync(tmpPath, STARTUP_TARGET_PATH);
}

export function consumeStartupNoticeTarget(): StartupNoticeTarget | null {
  let parsed: StartupNoticeTarget | null = null;
  try {
    parsed = JSON.parse(fs.readFileSync(STARTUP_TARGET_PATH, 'utf-8')) as StartupNoticeTarget;
  } catch {
    return null;
  } finally {
    fs.rmSync(STARTUP_TARGET_PATH, { force: true });
  }

  if (!parsed?.address?.channelType || !parsed.address.chatId) return null;
  if (!Number.isFinite(parsed.createdAt) || Date.now() - parsed.createdAt > STARTUP_TARGET_TTL_MS) {
    return null;
  }
  return parsed;
}
