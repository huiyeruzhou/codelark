import fs from 'node:fs';
import path from 'node:path';

import type {
  BridgeMirrorRecord,
  BridgeMirrorSupplementalDelta,
} from '../contracts.js';

export function kimiSessionLogFilePath(sessionFilePath: string): string {
  return path.resolve(path.dirname(sessionFilePath), '..', '..', 'logs', 'kimi-code.log');
}

interface ParsedKimiTerminalErrors {
  records: BridgeMirrorRecord[];
  trailingText: string;
}

function splitCompleteRuntimeLogText(text: string): { completeText: string; trailingText: string } {
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline < 0) return { completeText: '', trailingText: text };

  let completeText = text.slice(0, lastNewline + 1);
  let trailingText = text.slice(lastNewline + 1);
  const danglingHeader = completeText.match(/(^|\n)([^\n]*\bERROR\s+turn failed\b[^\n]*\n)$/u);
  if (danglingHeader?.index !== undefined) {
    const headerStart = danglingHeader.index + (danglingHeader[1] ? 1 : 0);
    trailingText = `${completeText.slice(headerStart)}${trailingText}`;
    completeText = completeText.slice(0, headerStart);
  }
  return { completeText, trailingText };
}

export function parseKimiTerminalErrorsFromLog(
  text: string,
  afterTimestamp: string | null,
  currentTurnId: string | null,
): ParsedKimiTerminalErrors {
  const split = splitCompleteRuntimeLogText(text);
  const records: BridgeMirrorRecord[] = [];
  const pattern = /^(\S+)\s+ERROR\s+turn failed\b([^\n]*)\n[ \t]+([^\n]+)/gmu;
  for (const match of split.completeText.matchAll(pattern)) {
    const timestamp = match[1] || '';
    if (afterTimestamp && timestamp <= afterTimestamp) continue;
    const errorText = (match[3] || '').trim();
    if (!errorText || errorText.startsWith('at ')) continue;
    const logTurnId = match[2]?.match(/\bturnId=(\S+)/u)?.[1]?.trim();
    records.push({
      signature: `kimi-runtime-error:${timestamp}:${logTurnId || currentTurnId || '-'}`,
      type: 'task_complete',
      content: '',
      timestamp,
      turnId: currentTurnId || logTurnId,
      isError: true,
      errorText,
    });
  }
  return { records, trailingText: split.trailingText };
}

function latestKimiWireTimestamp(filePath: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0) return null;

  const length = Math.min(stat.size, 64 * 1024);
  const start = stat.size - length;
  const buffer = Buffer.allocUnsafe(length);
  const fd = fs.openSync(filePath, 'r');
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/u);
  if (start > 0) lines.shift();
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index] || '') as { time?: unknown };
      if (typeof parsed.time !== 'number') continue;
      const timestamp = new Date(parsed.time).toISOString();
      if (timestamp) return timestamp;
    } catch {
      // Ignore partial and non-JSON lines in the bounded tail.
    }
  }
  return null;
}

function latestTimestamp(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

function readRuntimeLogRange(filePath: string, startOffset: number): { text: string; nextOffset: number } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { text: '', nextOffset: startOffset };
  }
  if (!stat.isFile()) return { text: '', nextOffset: startOffset };

  const safeStart = stat.size < startOffset ? 0 : Math.max(0, startOffset);
  const length = stat.size - safeStart;
  if (length <= 0) return { text: '', nextOffset: stat.size };

  const buffer = Buffer.allocUnsafe(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    const bytesRead = fs.readSync(fd, buffer, 0, length, safeStart);
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), nextOffset: safeStart + bytesRead };
  } finally {
    fs.closeSync(fd);
  }
}

export function readKimiRuntimeLogDelta(
  sessionFilePath: string,
  startOffset: number,
  trailingText: string,
  afterTimestamp: string | null,
  currentTurnId: string | null,
): BridgeMirrorSupplementalDelta {
  const range = readRuntimeLogRange(kimiSessionLogFilePath(sessionFilePath), startOffset);
  if (!range.text) {
    return { records: [], nextOffset: range.nextOffset, trailingText };
  }
  const parsed = parseKimiTerminalErrorsFromLog(
    `${trailingText}${range.text}`,
    latestTimestamp(afterTimestamp, latestKimiWireTimestamp(sessionFilePath)),
    currentTurnId,
  );
  return {
    records: parsed.records,
    nextOffset: range.nextOffset,
    trailingText: parsed.trailingText,
  };
}
