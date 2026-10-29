import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CODELARK_HOME } from '../../configuration/paths.js';
import { getCodexSessionByThreadId } from './session-index.js';
import { resolveCodexCliExecutable } from './cli-executable.js';
import { buildCodexTuiEnv } from './tmux-provider.js';
import { prepareCodexLocalAppServer } from './app-server-local.js';
import { CodexAppServerClient } from './app-server-client.js';

/** Retain native records (including compaction and tool results), never a text summary. */
export function readCodexForkPrefix(filePath: string, threadId: string, signature: string): string {
  const input = fs.readFileSync(filePath, 'utf8');
  const lines = input.split('\n');
  // An active writer may have an incomplete trailing line. It is never a checkpoint.
  if (!input.endsWith('\n')) lines.pop();
  // app-server protocol records sign as `app:<thread>:<turn>:<itemId>:<digest>`;
  // the item id anchors the same native JSONL row the card boundary rendered.
  const appServerItemId = parseAppServerSignatureItemId(signature);
  const retained: string[] = [];
  let checkedMeta = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = JSON.parse(trimmed) as { type?: string; payload?: Record<string, any> };
    if (!checkedMeta) {
      if (record.type !== 'session_meta' || record.payload?.id !== threadId) {
        throw new Error('原始 Codex 历史与卡片的 thread 不一致。');
      }
      checkedMeta = true;
    }
    retained.push(trimmed);
    if (appServerItemId) {
      if (record.payload?.item?.id === appServerItemId || record.payload?.id === appServerItemId) {
        return `${retained.join('\n')}\n`;
      }
      continue;
    }
    if (crypto.createHash('sha1').update(trimmed).digest('hex') === signature) {
      return `${retained.join('\n')}\n`;
    }
  }
  throw new Error('原始 Codex 历史中找不到该卡片的边界，未使用当前最新历史替代。');
}

function parseAppServerSignatureItemId(signature: string): string | null {
  if (!signature.startsWith('app:')) return null;
  const parts = signature.split(':');
  // app:<thread>:<turn>:<itemId>:<digest> -> the identity segment can be
  // `itemId` or `itemId:completed`, so take everything after the third colon
  // except the trailing digest.
  const identity = parts.slice(3, -1).join(':');
  const itemId = identity.replace(/:true$|:false$/, '');
  return itemId || null;
}

/** A prefix is a standalone rollout, not another path for the registered source. */
export function createCodexForkSnapshot(prefix: string, sourceThreadId: string): { threadId: string; content: string } {
  const boundary = prefix.indexOf('\n');
  const meta = JSON.parse(prefix.slice(0, boundary));
  if (boundary < 0 || meta.type !== 'session_meta' || meta.payload?.id !== sourceThreadId) {
    throw new Error('分叉快照缺少匹配的 Codex session_meta。');
  }
  const threadId = crypto.randomUUID();
  meta.payload.id = threadId;
  if ('session_id' in meta.payload) meta.payload.session_id = threadId;
  // The copied JSONL is self-contained; it has no paginated storage in Codex's database.
  delete meta.payload.history_mode;
  return { threadId, content: `${JSON.stringify(meta)}${prefix.slice(boundary)}` };
}

/** Codex rewrites timestamps/ordinals when forking, while retaining native record payloads. */
export function remapCodexForkSignatures(sourceThreadId: string, forkThreadId: string, signatures: string[]): Map<string, string> {
  const source = getCodexSessionByThreadId(sourceThreadId);
  const fork = getCodexSessionByThreadId(forkThreadId);
  if (!source || !fork) throw new Error('找不到分叉卡片的原生历史');
  const records = (file: string) => {
    const raw = fs.readFileSync(file, 'utf8');
    return raw.slice(0, raw.lastIndexOf('\n') + 1).split('\n').filter(line => line.trim()).map(line => ({
      signature: crypto.createHash('sha1').update(line.trim()).digest('hex'), record: JSON.parse(line),
    }));
  };
  const sourceRecords = records(source.filePath);
  const forkRecords = records(fork.filePath);
  const mapped = new Map<string, string>();
  for (const signature of new Set(signatures)) {
    const original = sourceRecords.find(row => row.signature === signature);
    if (!original) throw new Error(`原生历史缺少卡片边界 ${signature}`);
    const matches = forkRecords.filter(row => row.record.type === original.record.type
      && isDeepStrictEqual(row.record.payload, original.record.payload));
    if (matches.length !== 1) throw new Error(`分支历史无法唯一对应卡片边界 ${signature}`);
    mapped.set(signature, matches[0]!.signature);
  }
  return mapped;
}

export async function forkCodexThreadAtCheckpoint(options: {
  threadId: string;
  signature: string;
  workingDirectory: string;
}): Promise<{ threadId: string }> {
  const source = getCodexSessionByThreadId(options.threadId);
  if (!source) throw new Error('找不到卡片对应的本地 Codex 历史。');
  const prefix = readCodexForkPrefix(source.filePath, options.threadId, options.signature);
  const snapshotHistory = createCodexForkSnapshot(prefix, options.threadId);
  const tempRoot = path.join(CODELARK_HOME, 'runtime', 'forks');
  fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(tempRoot, 'checkpoint-'));
  const snapshot = path.join(directory, path.basename(source.filePath).replace(options.threadId, snapshotHistory.threadId));
  fs.writeFileSync(snapshot, snapshotHistory.content, { mode: 0o600 });
  try {
    const endpoint = await prepareCodexLocalAppServer({
      executable: resolveCodexCliExecutable({ requireInstalled: true }),
      env: buildCodexTuiEnv(),
    });
    if (!endpoint) throw new Error('当前 Codex 不支持原生分叉接口，请升级 Codex CLI。');
    const client = await CodexAppServerClient.connect(endpoint);
    try {
      // Fork from the immutable prefix, not the live source thread which may advance.
      const result = await client.request<{ thread: { id: string } }>('thread/fork', {
        threadId: snapshotHistory.threadId,
        path: snapshot,
        cwd: options.workingDirectory,
        persistExtendedHistory: true,
        deferGoalContinuation: true,
      });
      const threadId = result.thread?.id;
      if (!threadId || threadId === options.threadId || threadId === snapshotHistory.threadId) {
        throw new Error('Codex 未返回独立的分支 thread。');
      }
      // Unsubscribe retains a writer until Codex's idle timeout. This unpublished,
      // idle fork must be released before a separate TUI can resume it immediately.
      await client.request('thread/archive', { threadId });
      try {
        await client.request('thread/unarchive', { threadId });
      } catch (error) {
        throw new Error(`Codex 分支 ${threadId} 已归档但恢复失败，请恢复该分支后继续。`, { cause: error });
      }
      return { threadId };
    } finally { client.close(); }
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
}
