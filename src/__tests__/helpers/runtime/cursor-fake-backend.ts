import http from 'node:http';
import http2 from 'node:http2';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { CursorPendingQuestion } from '../../../runtime/cursor/cli-store.js';

// Cursor Agent 2026.11 protocol subset. The real CLI owns execution, UI and
// SQLite writes. This server only replaces the remote model/orchestration API.
const join = (...values: Uint8Array[]) => Buffer.concat(values);
function varint(value: number): Buffer {
  const out: number[] = [];
  while (value > 127) { out.push((value & 127) | 128); value >>>= 7; }
  return Buffer.from([...out, value]);
}
function field(no: number, value: string | Uint8Array | number): Buffer {
  if (typeof value === 'number') return join(varint(no * 8), varint(value));
  const bytes = Buffer.from(value);
  return join(varint(no * 8 + 2), varint(bytes.length), bytes);
}
function fields(bytes: Uint8Array): Map<number, Buffer[]> {
  const result = new Map<number, Buffer[]>(); let offset = 0;
  const read = () => { let n = 0; for (let i = 0; i < 10 && offset < bytes.length; i++) { const b = bytes[offset++]!; n += (b & 127) * 2 ** (7 * i); if (!(b & 128)) return n; } throw Error('invalid protobuf'); };
  while (offset < bytes.length) {
    const tag = read(), wire = tag % 8, no = Math.floor(tag / 8);
    if (wire === 0) { const value = read(); result.set(no, [varint(value)]); continue; }
    if (wire === 1 || wire === 5) { offset += wire === 1 ? 8 : 4; continue; }
    if (wire !== 2) throw Error(`unsupported wire ${wire}`);
    const length = read(); if (offset + length > bytes.length) throw Error('truncated protobuf');
    const list = result.get(no) || []; list.push(Buffer.from(bytes.subarray(offset, offset + length))); result.set(no, list); offset += length;
  }
  return result;
}
const get = (bytes: Uint8Array, no: number) => fields(bytes).get(no)?.[0] || Buffer.alloc(0);
export interface FakeCursorAnswer { questionId: string; selectedOptionIds: string[]; freeformText: string }
export type FakeCursorStreamEvent = { type: 'text'; text: string }
  | { type: 'transport_error'; message: string; code?: 'canceled' | 'resource_exhausted' }
  | { type: 'execute_shell'; id: string; command: string; cwd: string }
  | { type: 'tool_started' | 'tool_completed'; id: string; command: string; output?: string };
export interface FakeCursorModel {
  /** Populate the native conversation graph used by ACP history replay. */
  persistConversationSteps?: boolean;
  allowQuestionCancellation?: boolean;
  authenticated?(): boolean;
  call(prompt: string): CursorPendingQuestion | { waitingForSteer: true; beforeCheckpoint?: Promise<void> } | { final: string; beforeFinish?: Promise<void>; beforeCheckpoint?: Promise<void>; deferModelContext?: boolean; toolProgress?: Promise<void>; stream?: AsyncIterable<FakeCursorStreamEvent> };
  continue?(answers: FakeCursorAnswer[]): string;
  steer?(text: string): string | { waitingForSteer: true };
}

export async function startFakeCursorBackend(model: FakeCursorModel) {
  const prompts: string[] = [], answers: FakeCursorAnswer[][] = [], errors: string[] = [];
  const requests: string[] = [];
  const streamEvents: Array<{ type: FakeCursorStreamEvent['type']; at: number }> = [];
  const shellResults: Array<{ command: string; stdout: string; stderr: string; exitCode: number }> = [];
  const steers: Array<{ text: string; injectionId: string; expectedRunId: string }> = [];
  const completedMessages: unknown[] = [];
  const acceptedInputs: string[] = [];
  const completedSteps = new Map<number, Buffer[]>();
  let nativeSessionId = '';
  const sessions = new Set<http2.ServerHttp2Session>();
  const unary = http.createServer((req, res) => {
    requests.push(req.url || '');
    req.resume(); let out: Buffer = Buffer.alloc(0);
    if (model.authenticated?.() === false) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'unauthenticated', message: 'Authentication failed: credentials are invalid or expired.' }));
      return;
    }
    if (/\/(GetUsableModels|GetDefaultModelForCli)$/.test(req.url || '')) out = field(1, join(field(1, 'regression-fake'), field(3, 'regression-fake'), field(4, 'Regression Fake')));
    if (req.url?.endsWith('/AvailableModels')) out = join(field(1, 'regression-fake'), field(2, join(field(1, 'regression-fake'), field(2, 1), field(5, 1), field(17, 'Regression Fake'),
      field(30, join(field(2, 'Regression Fake'), field(9, 'regression-fake'))))));
    res.writeHead(200, { 'content-type': 'application/proto' }); res.end(out);
  });
  const agent = http2.createServer();
  agent.on('session', (session) => { sessions.add(session); session.on('close', () => sessions.delete(session)); });
  agent.on('stream', (stream, headers) => {
    stream.on('error', (error) => errors.push(error.message));
    if (headers[':path'] !== '/agent.v1.AgentService/Run') { stream.resume(); stream.respond({ ':status': 200, 'content-type': 'application/proto' }); stream.end(); return; }
    stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
    const send = (bytes: Buffer, flag = 0) => { const header = Buffer.alloc(5); header[0] = flag; header.writeUInt32BE(bytes.length, 1); stream.write(join(header, bytes)); };
    let request: CursorPendingQuestion, args: Buffer, prompt = '', runId = '', nextBlob = 10;
    const blobAcks = new Map<number, () => void>();
    const execReplies = new Map<number, (result: Buffer) => void>();
    const persist = (messages: unknown[], pending: unknown[], then: () => void) => {
      const blobs: Array<{ ref: Buffer; data: Buffer }> = [];
      const put = (data: Buffer) => {
        const ref = createHash('sha256').update(data).digest(); blobs.push({ ref, data }); return ref;
      };
      const refs = messages.map(message => put(Buffer.from(JSON.stringify(message))));
      const turns = acceptedInputs.map((text, index) => {
        const user = put(join(field(1, text), field(2, `user-${index}`)));
        return put(field(1, join(field(1, user), ...(completedSteps.get(index) || []).map(step => field(2, put(step))))));
      });
      let remaining = blobs.length;
      const checkpoint = () => { send(field(3, join(...refs.map(ref => field(1, ref)), ...turns.map(ref => field(8, ref)), ...pending.map(p => field(4, JSON.stringify(p)))))); then(); };
      if (!remaining) { checkpoint(); return; }
      for (const { data, ref } of blobs) {
        const id = nextBlob++; blobAcks.set(id, () => { if (--remaining === 0) checkpoint(); });
        send(field(4, join(field(1, id), field(3, join(field(1, ref), field(2, data))))));
      }
    };
    const injectedMessages: unknown[] = [];
    let buffer: Buffer = Buffer.alloc(0);
    stream.on('data', chunk => {
      buffer = join(buffer, Buffer.from(chunk));
      try {
        while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
          const size = buffer.readUInt32BE(1), flags = buffer[0]!;
          const data = flags & 1 ? gunzipSync(buffer.subarray(5, 5 + size)) : buffer.subarray(5, 5 + size);
          buffer = buffer.subarray(5 + size); if (flags & 2) continue;
          const message = fields(data);
          if (message.has(1)) {
            const run = message.get(1)![0]!; nativeSessionId = get(run, 5).toString();
            prompt = get(get(get(get(run, 2), 1), 1), 1).toString(); prompts.push(prompt);
            acceptedInputs.push(prompt);
            const turnIndex = acceptedInputs.length - 1;
            runId = get(run, 25).toString();
            const response = model.call(prompt);
            if ('final' in response) {
              const user = { role: 'user', content: [{ type: 'text', text: `<timestamp>${new Date().toISOString()} (UTC)</timestamp>\n<user_query>\n${prompt}\n</user_query>` }] };
              const toolMessages = response.toolProgress ? [
                { role: 'assistant', content: [{ type: 'tool-call', toolName: 'Glob', toolCallId: 'progress-glob', args: { glob_pattern: '*.py' } }] },
                { role: 'tool', content: [{ type: 'tool-result', toolName: 'Glob', toolCallId: 'progress-glob', result: 'one.py' }] },
              ] : [];
              const progress = { role: 'assistant', content: [{ type: 'text', text: 'NATIVE_TOOL_PROGRESS' }] };
              const finish = () => {
                if (model.persistConversationSteps) {
                  const steps = completedSteps.get(turnIndex) || [];
                  completedSteps.set(turnIndex, [...steps, field(1, field(1, response.final))]);
                }
                completedMessages.push(user, ...toolMessages, ...(response.toolProgress ? [progress] : []), { role: 'assistant', content: [{ type: 'text', text: response.final }] });
                persist(completedMessages, [], () => {
                  if (!response.stream) send(field(1, field(1, field(1, response.final))));
                  send(field(1, field(14, Buffer.alloc(0)))); send(Buffer.from('{}'), 2); stream.end();
                });
              };
              const start = () => {
                if (response.stream) {
                  // Model events reach the real CLI before its final SQLite
                  // checkpoint. The test controls each yield, so polling the
                  // persisted transcript cannot accidentally satisfy realtime.
                  void (async () => {
                    for await (const event of response.stream!) {
                      if (stream.closed || stream.destroyed) return;
                      streamEvents.push({ type: event.type, at: Date.now() });
                      if (event.type === 'transport_error') {
                        // Connect end-stream error, consumed by the real CLI.
                        await new Promise<void>(resolve => persist([...completedMessages, user], [], resolve));
                        send(Buffer.from(JSON.stringify({ error: { code: event.code || 'canceled', message: event.message } })), 2);
                        stream.end(); return;
                      }
                      if (event.type === 'text') send(field(1, field(1, field(1, event.text))));
                      else if (event.type === 'execute_shell') {
                        // Only the model/orchestration server is fake: ask the
                        // real Cursor runtime to execute the isolated command.
                        await new Promise<void>(resolve => persist([...completedMessages, user], [], resolve));
                        const [command, ...argv] = event.command.split(/\s+/);
                        const parsed = field(2, join(field(1, command!), ...argv.map(value => field(2, join(field(1, 'word'), field(2, value)))), field(3, event.command)));
                        const shellArgs = join(field(1, event.command), field(2, event.cwd), field(3, 5_000), field(4, event.id), field(8, parsed), field(12, 1));
                        send(field(1, field(2, join(field(1, event.id), field(2, field(1, field(1, shellArgs)))))));
                        const result = await new Promise<Buffer>(resolve => {
                          const id = 100; execReplies.set(id, resolve);
                          send(field(2, join(field(1, id), field(15, event.id), field(2, shellArgs))));
                        });
                        const success = get(result, 1);
                        if (!success.length) throw Error(`real Cursor shell failed: ${result.toString('hex').slice(0, 160)}`);
                        shellResults.push({ command: event.command, stdout: get(success, 5).toString(), stderr: get(success, 6).toString(), exitCode: get(success, 3)[0] || 0 });
                        const tool = field(1, join(field(1, shellArgs), field(2, result)));
                        send(field(1, field(3, join(field(1, event.id), field(2, tool)))));
                        if (model.persistConversationSteps) completedSteps.set(turnIndex, [...(completedSteps.get(turnIndex) || []), field(2, tool)]);
                      }
                      else {
                        const shellArgs = join(field(1, event.command), field(4, event.id));
                        const result = event.type === 'tool_completed'
                          ? field(2, field(1, join(field(1, event.command), field(3, 0), field(5, event.output || '')))) : Buffer.alloc(0);
                        send(field(1, field(event.type === 'tool_started' ? 2 : 3,
                          join(field(1, event.id), field(2, field(1, join(field(1, shellArgs), result)))))));
                        if (model.persistConversationSteps && event.type === 'tool_completed') {
                          const steps = completedSteps.get(turnIndex) || [];
                          completedSteps.set(turnIndex, [...steps, field(2, field(1, join(field(1, shellArgs), result)))]);
                        }
                      }
                    }
                    await response.beforeFinish;
                    if (!stream.closed && !stream.destroyed) finish();
                  })().catch(error => errors.push(String(error)));
                  return;
                }
                if (response.beforeFinish) {
                  // Model context can lag a persisted input; beforeCheckpoint
                  // separately delays the entire first checkpoint, as in production.
                  persist(response.deferModelContext ? completedMessages : [...completedMessages, user, ...toolMessages], [], () => {
                    send(field(1, field(4, field(1, 'MANUAL_RUNNING'))));
                    const progressReady = response.toolProgress
                      ? response.toolProgress.then(() => new Promise<void>(resolve => persist([...completedMessages, user, ...toolMessages, progress], [], resolve)))
                      : Promise.resolve();
                    void progressReady.then(() => response.beforeFinish).then(finish).catch(error => errors.push(String(error)));
                  });
                } else finish();
              };
              if (response.beforeCheckpoint) void response.beforeCheckpoint.then(start).catch(error => errors.push(String(error)));
              else start();
              continue;
            }
            if ('waitingForSteer' in response) {
              const start = () => persist([{ role: 'user', content: [{ type: 'text', text: prompt }] }], [], () => {
                send(field(1, field(4, field(1, 'FIRST_STEP_RUNNING'))));
              });
              if (response.beforeCheckpoint) void response.beforeCheckpoint.then(start).catch(error => errors.push(String(error)));
              else start();
              continue;
            }
            request = response;
            args = join(field(1, request.title), ...request.questions.map(q => field(2, join(field(1, q.id), field(2, q.prompt), ...q.options.map(o => field(3, join(field(1, o.id), field(2, o.label)))), field(4, q.allowMultiple ? 1 : 0)))));
            const pending = { role: 'assistant', content: [{ type: 'tool-call', toolName: 'AskQuestion', toolCallId: request.toolCallId, args: { title: request.title, questions: request.questions } }] };
            persist([{ role: 'user', content: [{ type: 'text', text: prompt }] }], [pending], () => {
              send(field(1, field(2, join(field(1, request.toolCallId), field(2, field(23, field(1, args)))))));
              send(field(7, join(field(1, 1), field(3, join(field(1, args), field(2, request.toolCallId))))));
            });
          }
          if (message.has(2)) {
            const result = message.get(2)![0]!;
            const id = get(result, 1)[0];
            if (id !== undefined) { execReplies.get(id)?.(get(result, 2)); execReplies.delete(id); }
          }
          if (message.has(3)) {
            const kv = fields(message.get(3)![0]!); const id = kv.get(1)?.[0]?.[0];
            if (id !== undefined && kv.has(3)) { blobAcks.get(id)?.(); blobAcks.delete(id); }
          }
          if (message.has(6)) {
            const result = get(get(message.get(6)![0]!, 3), 1), success = get(result, 1);
            if (!success.length && model.allowQuestionCancellation) continue;
            if (!success.length) throw Error('fake model received rejected/empty AskQuestion result');
            const received = (fields(success).get(1) || []).map(row => ({ questionId: get(row, 1).toString(), selectedOptionIds: (fields(row).get(2) || []).map(v => v.toString()), freeformText: get(row, 3).toString() }));
            answers.push(received); const final = model.continue!(received);
            persist([
              { role: 'user', content: [{ type: 'text', text: prompt }] },
              { role: 'assistant', content: [{ type: 'tool-call', toolName: 'AskQuestion', toolCallId: request.toolCallId, args: { title: request.title, questions: request.questions } }] },
              { role: 'tool', content: [{ type: 'tool-result', toolName: 'AskQuestion', toolCallId: request.toolCallId, result: { answers: received } }] },
              { role: 'assistant', content: [{ type: 'text', text: final }] },
            ], [], () => {
              send(field(1, field(3, join(field(1, request.toolCallId), field(2, field(23, join(field(1, args), field(2, result))))))));
              send(field(1, field(1, field(1, final))));
              send(field(1, field(14, Buffer.alloc(0)))); send(Buffer.from('{}'), 2); stream.end();
            });
          }
          if (message.has(4)) {
            const injection = get(message.get(4)![0]!, 19);
            if (!injection.length) throw Error('expected an in-turn context injection, not cancellation or another turn');
            const injectionId = get(injection, 1).toString(), expectedRunId = get(injection, 2).toString();
            const user = get(get(injection, 3), 1), text = get(user, 1).toString();
            if (!runId || expectedRunId !== runId) throw Error('steer targeted a different native run');
            steers.push({ text, injectionId, expectedRunId });
            acceptedInputs.push(text);
            const final = model.steer!(text);
            send(field(1, field(23, join(field(1, injectionId), field(2, field(2, Buffer.alloc(0)))))));
            send(field(1, field(6, field(1, user))));
            injectedMessages.push({ role: 'user', content: [{ type: 'text', text: `<timestamp>test time</timestamp>\n<user_query>\n${text}\n</user_query>` }], providerOptions: { cursor: { turnSteer: true } } });
            persist([
              { role: 'user', content: [{ type: 'text', text: prompt }] },
              ...injectedMessages,
              ...(typeof final === 'string' ? [{ role: 'assistant', content: [{ type: 'text', text: final }] }] : []),
            ], [], () => {
              if (typeof final !== 'string') {
                send(field(1, field(4, field(1, 'WAITING_FOR_NEXT_STEER'))));
                return;
              }
              send(field(1, field(1, field(1, final))));
              send(field(1, field(14, Buffer.alloc(0)))); send(Buffer.from('{}'), 2); stream.end();
            });
          }
        }
      } catch (error) { errors.push(String(error)); stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR); }
    });
  });
  await Promise.all([new Promise<void>(r => unary.listen(0, '127.0.0.1', r)), new Promise<void>(r => agent.listen(0, '127.0.0.1', r))]);
  return {
    prompts, answers, steers, errors, requests, streamEvents, shellResults, get nativeSessionId() { return nativeSessionId; },
    args: ['--endpoint', `http://127.0.0.1:${(unary.address() as { port: number }).port}`, '--agent-endpoint', `http://127.0.0.1:${(agent.address() as { port: number }).port}`, '--auth-token', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJyZWdyZXNzaW9uLXVzZXIiLCJleHAiOjQxMDI0NDQ4MDB9.test', '--http-version', '2'],
    async close() { for (const session of sessions) session.destroy(); unary.closeAllConnections(); await Promise.all([new Promise<void>(r => unary.close(() => r())), new Promise<void>(r => agent.close(() => r()))]); },
  };
}
