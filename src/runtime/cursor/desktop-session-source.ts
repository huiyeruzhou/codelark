import crypto from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { BridgeMirrorRecord } from '../contracts.js';
import { listCursorDesktopThreads } from './desktop-bridge-client.js';

type ObjectValue = Record<string, any>;

function object(value: unknown): ObjectValue | null {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
}

export function statCursorDesktopStore(filePath: string) {
  try {
    const main = fs.statSync(filePath);
    if (!main.isFile()) return null;
    const stats = [main];
    try { stats.push(fs.statSync(`${filePath}-wal`)); } catch { /* No WAL yet. */ }
    return {
      size: stats.reduce((total, stat) => total + stat.size, 0),
      mtimeMs: Math.max(...stats.map((stat) => stat.mtimeMs)),
      identity: stats.map((stat) => `${stat.dev}:${stat.ino}`).join('|'),
    };
  } catch { return null; }
}

const TOOL_NAMES: Record<string, string> = {
  run_terminal_command_v2: 'Shell', read_file_v2: 'Read', edit_file_v2: 'Write',
  ripgrep_raw_search: 'Grep', glob_file_search: 'Glob', web_search: 'WebSearch',
  web_fetch: 'WebFetch', todo_write: 'TodoWrite',
};

function toolInput(tool: ObjectValue): ObjectValue {
  const input = object(tool.rawArgs) || object(tool.params) || {};
  // Preserve all native arguments, with aliases understood by the shared renderer.
  return { ...input,
    ...(!input.path && (input.targetFile || input.relativeWorkspacePath)
      ? { path: input.targetFile || input.relativeWorkspacePath } : {}),
    ...(!input.query && input.searchTerm ? { query: input.searchTerm } : {}),
  };
}

export function cursorDesktopToolResult(tool: ObjectValue): { content: string; isError: boolean } {
  const result = object(tool.result);
  const isError = ['error', 'failed', 'cancelled', 'canceled', 'rejected'].includes(tool.status)
    || result?.rejected === true || result?.isError === true || result?.is_error === true
    || result?.notInterrupted === false
    || (typeof result?.exitCode === 'number' && result.exitCode !== 0);
  if (result) {
    for (const key of ['output', 'content', 'markdown', 'text']) {
      if (typeof result[key] === 'string') return { content: result[key], isError };
    }
  }
  if (typeof tool.result === 'string' && !result && tool.result.trim()) {
    return { content: tool.result, isError };
  }
  // Cursor prunes some completed Read/Grep bodies. Report what it retained;
  // never re-read the current file and pretend it was the historical output.
  const retained = result || object(tool.additionalData);
  const unavailable = !retained || Object.keys(retained).length === 0 || retained.isPruned
    || ('totalLinesInFile' in retained && !('content' in retained));
  return {
    content: [
      unavailable ? `Cursor 工具${isError ? '未成功完成' : '已完成'}，未保留完整原始输出。` : '',
      retained && Object.keys(retained).length > 0 ? JSON.stringify(retained, null, 2) : '',
    ].filter(Boolean).join('\n'),
    isError,
  };
}

interface ConversationState {
  bubbles: Map<string, { version: string; body: ObjectValue }>;
  rendered: Map<string, { body: ObjectValue; turnId: string; records: BridgeMirrorRecord[] }>;
  signatures: Set<string>;
  records: BridgeMirrorRecord[];
  storeVersion?: string;
  contentVersion?: string;
  nextTurnId?: string | null;
}

export interface CursorDesktopSnapshot {
  records: BridgeMirrorRecord[];
  nextTurnId: string | null;
}

/** Read Cursor's persisted conversation, without requiring an app patch.
 * A revision ledger keeps late tool completions after the previously observed
 * cursor even when Cursor updates a bubble earlier in the conversation.
 */
export class CursorDesktopSessionSource {
  private conversations = new Map<string, ConversationState>();
  private lifecycle = new Map<string, { status?: string; contentVersion?: string; probedAt: number; confirmed: boolean }>();

  constructor(readonly filePath: string, private readonly options: {
    readStatus?: (threadId: string) => Promise<string | undefined>;
    pollIntervalMs?: number;
  } = {}) {}

  /** Persisted composer.status can belong to an earlier generation. Only a
   * fresh Desktop observation may end the current turn; failures leave it open.
   * Bind the observation to the thread revision BEFORE the request, so a new
   * prompt/tool written during or after that request invalidates its terminal.
   */
  async refresh(threadId: string): Promise<boolean> {
    const previous = this.lifecycle.get(threadId);
    if (previous && Date.now() - previous.probedAt < (this.options.pollIntervalMs ?? 1000)) return false;
    this.read(threadId);
    const contentVersion = this.conversations.get(threadId)?.contentVersion;
    let status: string | undefined;
    try {
      status = this.options.readStatus
        ? await this.options.readStatus(threadId)
        : (await listCursorDesktopThreads()).find((thread) => thread.id === threadId)?.status;
    } catch { /* Unavailable live state must never fall back to stale root.status. */ }
    // Let Cursor persist the final bubbles before closing the card. A terminal
    // must survive two probes with unchanged thread content, not just one UI
    // event. Other threads writing the shared SQLite store must not delay it.
    const confirmed = previous?.status === status && previous?.contentVersion === contentVersion;
    this.lifecycle.set(threadId, { status, contentVersion, probedAt: Date.now(), confirmed });
    return previous?.status !== status || previous?.contentVersion !== contentVersion || previous?.confirmed !== confirmed;
  }

  read(threadId: string): CursorDesktopSnapshot | null {
    let db: DatabaseSync | undefined;
    try {
      const diskVersion = JSON.stringify(statCursorDesktopStore(this.filePath));
      const observation = this.lifecycle.get(threadId);
      const storeVersion = `${diskVersion}:${observation?.status}:${observation?.confirmed}:${observation?.contentVersion}`;
      const previous = this.conversations.get(threadId);
      if (previous?.storeVersion === storeVersion) return { records: previous.records, nextTurnId: previous.nextTurnId ?? null };
      db = new DatabaseSync(this.filePath, { readOnly: true });
      db.exec('BEGIN');
      const get = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
      const getBubble = db.prepare(`SELECT json_object(
        'type', json_extract(value, '$.type'), 'text', json_extract(value, '$.text'),
        'createdAt', json_extract(value, '$.createdAt'), 'completedAtMs', json_extract(value, '$.completedAtMs'),
        'toolFormerData', json_extract(value, '$.toolFormerData'), 'thinking', json_extract(value, '$.thinking'),
        'images', json_extract(value, '$.images'), 'attachedCodeChunks', json_extract(value, '$.attachedCodeChunks')
      ) AS value FROM cursorDiskKV WHERE key = ?`);
      const root = object((get.get(`composerData:${threadId}`) as { value?: unknown } | undefined)?.value);
      if (!root || !Array.isArray(root.fullConversationHeadersOnly)) return null;
      let state = this.conversations.get(threadId);
      if (!state) {
        if (this.conversations.size >= 16) this.conversations.delete(this.conversations.keys().next().value!);
        state = { bubbles: new Map(), rendered: new Map(), signatures: new Set(), records: [] };
        this.conversations.set(threadId, state);
      }
      const next: BridgeMirrorRecord[] = [];
      let turnId: string | null = null;
      let turnTextParts: string[] = [];
      let lastTimestamp = '';
      const push = (record: Omit<BridgeMirrorRecord, 'signature'>, identity: string) => {
        next.push({ ...record, signature: `cursor-desktop:${threadId}:${identity}:${digest(record)}` });
      };
      const finish = (timestamp: string, aborted = false) => {
        if (!turnId) return;
        // One terminal per turn, even if late persisted output changes its time.
        next.push({ type: aborted ? 'task_aborted' : 'task_complete', content: '', timestamp, turnId,
          signature: `${turnId}:end` });
      };
      const headers = root.fullConversationHeadersOnly as ObjectValue[];
      const liveIds = new Set<string>();
      for (let index = 0; index < headers.length; index += 1) {
        const header = headers[index]!;
        if (typeof header.bubbleId !== 'string') continue;
        const id = header.bubbleId;
        liveIds.add(id);
        const version = digest(header);
        const cached = state.bubbles.get(id);
        // In-flight and tail bubbles can change without a header revision.
        const stable = Boolean(header.completedAtMs) && index < headers.length - 80;
        const body = cached?.version === version && stable ? cached.body
          : object((getBubble.get(`bubbleId:${threadId}:${id}`) as { value?: unknown } | undefined)?.value)
            || object(root.conversationMap?.[id]);
        if (!body) continue;
        state.bubbles.set(id, { version, body });
        const timestamp = typeof body.createdAt === 'string' ? body.createdAt
          : typeof header.createdAt === 'string' ? header.createdAt : lastTimestamp;
        const completedAt = typeof body.completedAtMs === 'number'
          ? new Date(body.completedAtMs).toISOString() : timestamp;
        if (body.type === 1) {
          const text = typeof body.text === 'string' ? body.text : '';
          if (!text.trim() && !(body.images?.length || body.attachedCodeChunks?.length)) continue;
          finish(lastTimestamp || timestamp);
          turnId = `cursor-desktop:${threadId}:turn:${id}`;
          turnTextParts = [];
          push({ type: 'task_started', content: '', timestamp, turnId }, `${id}:start`);
          push({ type: 'message', role: 'user', content: text, timestamp, turnId }, `${id}:user`);
        } else if (turnId) {
          const cachedRecords = state.rendered.get(id);
          if (cachedRecords?.body === body && cachedRecords.turnId === turnId && body.toolFormerData) {
            next.push(...cachedRecords.records);
            lastTimestamp = [lastTimestamp, completedAt, timestamp].sort().at(-1) || '';
            continue;
          }
          const recordStart = next.length;
          const tool = object(body.toolFormerData);
          if (tool) {
            const toolId = `cursor-desktop:${threadId}:${id}`;
            const toolName = TOOL_NAMES[tool.name] || tool.name || 'tool';
            const input = toolInput(tool);
            push({ type: 'tool_started', content: '', timestamp, turnId, toolId, toolName, toolInput: input }, `${id}:tool`);
            if (['completed', 'error', 'failed', 'cancelled', 'canceled', 'rejected'].includes(tool.status)) {
              push({ type: 'tool_finished', timestamp: completedAt, turnId, toolId, toolName,
                showToolOutput: true,
                ...cursorDesktopToolResult(tool) }, `${id}:result`);
            }
          } else {
            const thinking = object(body.thinking)?.text;
            if (typeof thinking === 'string' && thinking.trim()) {
              push({ type: 'reasoning', reasoningKind: 'summary', content: thinking, timestamp, turnId }, `${id}:thinking`);
            }
            if (typeof body.text === 'string' && body.text.trim() && body.text.trim() !== '<|eos|>') {
              turnTextParts.push(body.text);
              push({ type: 'message', role: 'assistant', content: turnTextParts.join('\n\n'), timestamp, turnId,
                replacementKey: `${turnId}:text` }, `${id}:text`);
            }
          }
          state.rendered.set(id, { body, turnId, records: next.slice(recordStart) });
        }
        lastTimestamp = [lastTimestamp, completedAt, timestamp].sort().at(-1) || '';
      }
      state.contentVersion = digest(next.map((record) => record.signature));
      const liveStatus = observation?.confirmed && observation.contentVersion === state.contentVersion ? observation.status : undefined;
      if (liveStatus === 'completed' || liveStatus === 'error') {
        finish(lastTimestamp, liveStatus === 'error');
        turnId = null;
      } else if (turnId && state.signatures.has(`${turnId}:end`)) {
        turnId = null;
      }
      for (const id of state.bubbles.keys()) if (!liveIds.has(id)) {
        state.bubbles.delete(id);
        state.rendered.delete(id);
      }
      for (const record of next) {
        if (state.signatures.has(record.signature)) continue;
        // Historical revisions after a confirmed terminal must not reopen the
        // same IM stream. New user bubbles get their own distinct turn ID.
        if (record.turnId && state.signatures.has(`${record.turnId}:end`)) continue;
        state.signatures.add(record.signature);
        state.records.push(record);
      }
      state.storeVersion = storeVersion;
      state.nextTurnId = turnId;
      return { records: state.records, nextTurnId: turnId };
    } finally {
      db?.close();
    }
  }
}
