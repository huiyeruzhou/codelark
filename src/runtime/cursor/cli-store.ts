import { DatabaseSync } from 'node:sqlite';

export interface CursorNativeBlock {
  type?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}

export interface CursorNativeMessage {
  role?: string;
  content?: string | CursorNativeBlock[];
}

interface CursorNativeSnapshot {
  root: string;
  messages: CursorNativeMessage[];
  messagesByRef: Map<string, CursorNativeMessage>;
  pendingMessages: CursorNativeMessage[];
  userPrompts: string[];
  promptsByTurn: Map<string, string[]>;
}

const snapshots = new Map<string, CursorNativeSnapshot>();

// Decode only length-delimited fields, following references from the current
// root. Blobs left behind by an earlier root are not acceptance evidence.
function byteFields(bytes: Uint8Array): Map<number, Buffer[]> {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    for (let shift = 0; shift < 56 && offset < bytes.length; shift += 7) {
      const byte = bytes[offset++]!;
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
    }
    throw new Error('Invalid Cursor state varint');
  };
  const fields = new Map<number, Buffer[]>();
  while (offset < bytes.length) {
    const tag = readVarint();
    const wire = tag % 8;
    if (wire === 0) readVarint();
    else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else if (wire === 2) {
      const length = readVarint();
      if (offset + length > bytes.length) throw new Error('Truncated Cursor state');
      const no = Math.floor(tag / 8);
      const values = fields.get(no) || [];
      values.push(Buffer.from(bytes.subarray(offset, offset + length)));
      fields.set(no, values);
      offset += length;
    } else throw new Error('Unsupported Cursor state wire type');
    if (offset > bytes.length) throw new Error('Truncated Cursor state');
  }
  return fields;
}

function messageText(message: CursorNativeMessage): string {
  return typeof message.content === 'string' ? message.content
    : (message.content || []).filter(block => block.type === 'text').map(block => block.text || '').join('\n');
}

function readCursorNativeSnapshot(storePath: string): CursorNativeSnapshot | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(storePath, { readOnly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value?: string | Uint8Array } | undefined;
    if (!row?.value) return null;
    const raw = typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8');
    const meta = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'hex').toString('utf8'));
    const root = meta.latestRootBlobId;
    if (typeof root !== 'string' || !/^[a-f\d]{64}$/i.test(root)) return null;
    const cached = snapshots.get(storePath);
    if (cached?.root === root) return cached;
    const getBlob = db.prepare('SELECT data FROM blobs WHERE id = ?');
    const rootRow = getBlob.get(root) as { data?: Uint8Array } | undefined;
    if (!(rootRow?.data instanceof Uint8Array)) return null;
    const messages: CursorNativeMessage[] = [];
    const messagesByRef = new Map<string, CursorNativeMessage>();
    const fields = byteFields(rootRow.data);
    const refId = (ref: Buffer) => {
      if (ref.length !== 32) throw new Error('Unsupported Cursor blob reference');
      return ref.toString('hex');
    };
    const readBlob = (ref: Buffer) => {
      const row = getBlob.get(refId(ref)) as { data?: Uint8Array } | undefined;
      if (!(row?.data instanceof Uint8Array)) throw new Error('Missing Cursor blob');
      return row.data;
    };
    for (const ref of (fields.get(1) || []).map(refId)) {
      let message = cached?.messagesByRef.get(ref);
      if (!message) {
        const messageRow = getBlob.get(ref) as { data?: string | Uint8Array } | undefined;
        if (!messageRow?.data) return null;
        const json = typeof messageRow.data === 'string' ? messageRow.data : Buffer.from(messageRow.data).toString('utf8');
        message = JSON.parse(json) as CursorNativeMessage;
        if (!['system', 'user', 'assistant', 'tool'].includes(message.role || '')) return null;
      }
      messagesByRef.set(ref, message);
      messages.push(message);
    }
    const pendingMessages: CursorNativeMessage[] = [];
    for (const bytes of fields.get(4) || []) {
      try { pendingMessages.push(JSON.parse(bytes.toString('utf8'))); }
      catch { /* Unknown pending entries must not hide committed messages. */ }
    }
    const promptsByTurn = new Map<string, string[]>();
    const userPrompts: string[] = [];
    // ConversationState.turns is saved when input is accepted, before the
    // model's rootPromptMessagesJson checkpoint catches up (sometimes minutes).
    for (const ref of fields.get(8) || []) {
      const id = refId(ref);
      let prompts = cached?.promptsByTurn.get(id);
      if (!prompts) {
        prompts = [];
        const agentTurn = byteFields(readBlob(ref)).get(1)?.[0];
        if (agentTurn) {
          const userRef = byteFields(agentTurn).get(1)?.[0];
          if (!userRef) throw new Error('Missing Cursor user message reference');
          const user = byteFields(readBlob(userRef));
          const textRef = user.get(18)?.[0];
          prompts.push(textRef ? Buffer.from(readBlob(textRef)).toString('utf8') : user.get(1)?.[0]?.toString('utf8') || '');
        }
      }
      promptsByTurn.set(id, prompts);
      userPrompts.push(...prompts);
    }
    // Older Cursor stores have only the model message list.
    if (!fields.has(8)) userPrompts.push(...messages.filter(m => m.role === 'user').map(messageText));
    if (snapshots.size >= 16) snapshots.delete(snapshots.keys().next().value!);
    const snapshot = { root, messages, messagesByRef, pendingMessages, userPrompts, promptsByTurn };
    snapshots.set(storePath, snapshot);
    return snapshot;
  } catch {
    // A missing, encrypted or newer store must not invent tool completion.
    return null;
  } finally {
    db?.close();
  }
}

export function readCursorNativeMessages(storePath: string): CursorNativeMessage[] | null {
  return readCursorNativeSnapshot(storePath)?.messages ?? null;
}

export function readCursorNativeUserPrompts(storePath: string): string[] | null {
  return readCursorNativeSnapshot(storePath)?.userPrompts ?? null;
}

export interface CursorQuestion {
  id: string;
  prompt: string;
  allowMultiple?: boolean;
  options: Array<{ id: string; label: string }>;
}

export interface CursorPendingQuestion {
  toolCallId: string;
  title: string;
  questions: CursorQuestion[];
}

/** Pending calls live in ConversationState field 4, before transcript checkpointing. */
export function readCursorPendingQuestion(storePath: string): CursorPendingQuestion | null {
  for (const message of readCursorNativeSnapshot(storePath)?.pendingMessages || []) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
  for (const block of message.content) {
    if (block.type !== 'tool-call' || block.toolName !== 'AskQuestion' || !block.toolCallId) continue;
    const args = block.args as Partial<CursorPendingQuestion> | undefined;
    if (!args || !Array.isArray(args.questions) || !args.questions.length) continue;
    if (!args.questions.every((q) => q && typeof q.id === 'string' && typeof q.prompt === 'string'
      && Array.isArray(q.options) && q.options.every((o) => o && typeof o.id === 'string' && typeof o.label === 'string'))) continue;
    return { toolCallId: block.toolCallId, title: typeof args.title === 'string' ? args.title : 'Cursor 需要你的回答', questions: args.questions };
  }
  }
  return null;
}

export function cursorNativeToolKey(name: string, input: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]),
    );
    return value;
  };
  return JSON.stringify([name, canonical(input ?? {})]);
}

export function cursorVisibleThinkingSummary(raw: string): string {
  const text = raw.trim();
  if (!/^Thinking Process\s*:/i.test(text)) return text;
  // Some summary models include their drafting process before the requested
  // bold heading + paragraph. Keep only that final summary, in a native
  // reasoning field; never apply this rule to ordinary assistant text.
  const summaries = Array.from(text.matchAll(/\*\*([^*\r\n]+)\*\*[ \t]*\r?\n\s*\r?\n[ \t]*([^\r\n]+)\s*$/gu));
  const summary = summaries.at(-1);
  return summary ? `**${summary[1]!.trim()}**\n\n${summary[2]!.trim()}` : '';
}
