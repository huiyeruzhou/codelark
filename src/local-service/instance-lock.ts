import fs from 'node:fs';
import path from 'node:path';

import { CODELARK_HOME } from '../configuration/paths.js';

export interface BridgeInstanceLock {
  pid: number;
  createdAt: string;
}

const runtimeDir = path.join(CODELARK_HOME, 'runtime');
export const bridgeInstanceLockFile = path.join(runtimeDir, 'bridge.instance.lock');

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function isProcessAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readBridgeInstanceLock(filePath = bridgeInstanceLockFile): BridgeInstanceLock | null {
  const parsed = readJsonFile<Partial<BridgeInstanceLock> | null>(filePath, null);
  const pid = Number(parsed?.pid);
  const createdAt = typeof parsed?.createdAt === 'string' ? parsed.createdAt : '';
  if (!Number.isFinite(pid) || pid <= 0 || !createdAt) return null;
  return { pid, createdAt };
}

export function tryAcquireBridgeInstanceLock(
  options: {
    filePath?: string;
    ownerPid?: number;
    nowMs?: number;
    isAlive?: (pid?: number) => boolean;
  } = {},
): { acquired: boolean; holderPid?: number } {
  const filePath = options.filePath ?? bridgeInstanceLockFile;
  const ownerPid = options.ownerPid ?? process.pid;
  const nowMs = options.nowMs ?? Date.now();
  const isAlive = options.isAlive ?? isProcessAlive;
  const payload: BridgeInstanceLock = {
    pid: ownerPid,
    createdAt: new Date(nowMs).toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), { encoding: 'utf-8', flag: 'wx' });
      return { acquired: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      const existing = readBridgeInstanceLock(filePath);
      if (existing && existing.pid !== ownerPid && isAlive(existing.pid)) {
        return { acquired: false, holderPid: existing.pid };
      }
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Another process may have already cleared or replaced the stale lock.
      }
    }
  }

  const existing = readBridgeInstanceLock(filePath);
  if (existing && existing.pid !== ownerPid && isAlive(existing.pid)) {
    return { acquired: false, holderPid: existing.pid };
  }
  return existing?.pid === ownerPid
    ? { acquired: true }
    : { acquired: false, holderPid: existing?.pid };
}

export function releaseBridgeInstanceLock(filePath = bridgeInstanceLockFile, ownerPid = process.pid): void {
  const existing = readBridgeInstanceLock(filePath);
  if (!existing) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore missing lock file
    }
    return;
  }
  if (existing.pid !== ownerPid) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore missing/stale lock cleanup errors
  }
}

export function clearStaleBridgeInstanceLock(
  filePath = bridgeInstanceLockFile,
  isAlive: (pid?: number) => boolean = isProcessAlive,
): void {
  const existing = readBridgeInstanceLock(filePath);
  if (existing && isAlive(existing.pid)) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore missing/stale lock cleanup errors
  }
}
