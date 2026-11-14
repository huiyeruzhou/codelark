import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

/** Minimal persisted native schema, for parser/control unit tests only. */
export function cursorNativeStore(file: string) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
  const put = (data: Buffer) => {
    const id = createHash('sha256').update(data).digest('hex');
    db.prepare('INSERT OR IGNORE INTO blobs VALUES (?, ?)').run(id, data);
    return Buffer.from(id, 'hex');
  };
  const varint = (n: number) => {
    const bytes: number[] = [];
    while (n > 127) { bytes.push((n & 127) | 128); n >>>= 7; }
    return Buffer.from([...bytes, n]);
  };
  const field = (n: number, bytes: Buffer) => Buffer.concat([varint(n * 8 + 2), varint(bytes.length), bytes]);
  return {
    checkpoint(messages: unknown[], pending: unknown[] = [], inputs?: Array<string | { text: string; blob?: boolean }>) {
      const refs = messages.map((m) => Buffer.concat([Buffer.from([10, 32]), put(Buffer.from(JSON.stringify(m)))]));
      const requests = pending.map((m) => {
        const bytes = Buffer.from(typeof m === 'string' ? m : JSON.stringify(m));
        return Buffer.concat([Buffer.from([34]), varint(bytes.length), bytes]);
      });
      const turns = (inputs || []).map((input, index) => {
        const text = typeof input === 'string' ? input : input.text;
        const content = typeof input !== 'string' && input.blob ? field(18, put(Buffer.from(text))) : field(1, Buffer.from(text));
        const user = put(Buffer.concat([content, field(2, Buffer.from(`message-${index}`))]));
        return field(8, put(field(1, field(1, user))));
      });
      const id = put(Buffer.concat([...refs, ...requests, ...turns])).toString('hex');
      db.prepare("INSERT OR REPLACE INTO meta VALUES ('0', ?)").run(JSON.stringify({ latestRootBlobId: id }));
    },
    close: () => db.close(),
  };
}

export const cursorQuestionFixture = {
  title: '实验参数',
  questions: [
    { id: 'temperature', prompt: '选择温度', options: [{ id: 'low', label: '低温' }, { id: 'high', label: '高温' }] },
    { id: 'tag', prompt: '输入标签', options: [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta' }] },
  ],
};
export const pendingCursorQuestion = (id = 'question-1', args: unknown = cursorQuestionFixture) => ({
  role: 'assistant', content: [{ type: 'tool-call', toolName: 'AskQuestion', toolCallId: id, args }],
});
export const cursorQuestionScreen = (index = 0, multiple = false) => [
  `│ Question ${index + 1} of 2`,
  `│ › [${multiple ? 'x' : ' '}] 低温`, '│   [ ] 高温', '│   [ ] Other',
  '│ ↑/↓ option · ←/→ question · Space select · Enter next/submit · Esc to skip',
].join('\n');
