import fs from 'node:fs';
import path from 'node:path';
import type { BridgeMirrorRecord } from '../contracts.js';

interface CachedActivity {
  checkedAt: number;
  directoryMtime: number;
  record: BridgeMirrorRecord | null;
}

const cache = new Map<string, CachedActivity>();

/** Read an existing Cursor tool event spool; never install or execute hooks. */
export function readCursorToolActivity(filePath: string, turnId: string | null, afterMs: number): BridgeMirrorRecord | null {
  if (!turnId) return null;
  const directory = `${filePath}.tool-events`;
  const now = Date.now();
  let cached = cache.get(directory);
  if (!cached || now - cached.checkedAt >= 2_000) {
    let directoryMtime: number;
    try { directoryMtime = fs.statSync(directory).mtimeMs; } catch { return null; }
    if (!cached || cached.directoryMtime !== directoryMtime) {
      let record: BridgeMirrorRecord | null = null;
      let retry = false;
      const sessionId = path.basename(filePath, '.jsonl');
      // Filenames start with capture nanoseconds. Only read recent candidates,
      // not every historical payload on each transcript poll.
      let names: string[];
      try { names = fs.readdirSync(directory).filter(name => /^\d+-\d+-(?:preToolUse|postToolUse|postToolUseFailure)\.json$/.test(name)).sort().reverse(); }
      catch { return null; }
      for (const name of names.slice(0, 16)) {
        try {
          const event = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
          if (event.conversation_id !== sessionId || event.session_id !== sessionId
            || path.resolve(event.transcript_path || '') !== path.resolve(filePath)) continue;
          if (!['preToolUse', 'postToolUse', 'postToolUseFailure'].includes(event.hook_event_name)
            || !name.endsWith(`-${event.hook_event_name}.json`)) continue;
          const timestampMs = Number(BigInt(name.split('-')[0]!) / 1_000_000n);
          if (!Number.isFinite(timestampMs) || timestampMs > now + 5_000) continue;
          const tool = typeof event.tool_name === 'string' ? event.tool_name.trim() : '';
          if (!tool) continue;
          const action = event.hook_event_name === 'preToolUse' ? '开始执行'
            : event.hook_event_name === 'postToolUseFailure' ? '执行失败' : '执行完成';
          const timestamp = new Date(timestampMs).toISOString();
          record = { signature: `cursor:tool-activity:${name}`, type: 'reasoning', reasoningKind: 'status',
            content: `最近工具活动：${tool} ${action}；会话正文尚未更新。`, timestamp, activityAt: timestamp };
          break;
        } catch { retry = true; /* A hook file may still be being written. */ }
      }
      cached = { checkedAt: now, directoryMtime: record && !retry ? directoryMtime : -1, record };
      if (cache.size >= 32) cache.delete(cache.keys().next().value!);
      cache.set(directory, cached);
    } else cached.checkedAt = now;
  }
  const record = cached.record;
  return record && Date.parse(record.timestamp!) > afterMs ? { ...record, turnId } : null;
}
