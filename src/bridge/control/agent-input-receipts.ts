import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CODELARK_HOME } from '../../configuration/paths.js';

const RECEIPTS_PATH = path.join(CODELARK_HOME, 'data', 'agent-input-receipts.json');

function readReceipts(): Record<string, string> {
  try {
    const value = JSON.parse(fs.readFileSync(RECEIPTS_PATH, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, string>
      : {};
  } catch {
    return {};
  }
}

/**
 * Atomically claim a durable Agent input identity. A claimed key is never
 * accepted again, including after a Bridge restart.
 */
export function claimAgentInputReceipt(idempotencyKey: string): boolean {
  const key = idempotencyKey.trim();
  if (!key) return true;
  const receipts = readReceipts();
  if (receipts[key]) return false;
  receipts[key] = new Date().toISOString();
  fs.mkdirSync(path.dirname(RECEIPTS_PATH), { recursive: true });
  const temporary = `${RECEIPTS_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(receipts, null, 2), 'utf8');
  fs.renameSync(temporary, RECEIPTS_PATH);
  return true;
}

export const _testOnly = { path: RECEIPTS_PATH };
