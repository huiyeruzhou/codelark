import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectRealE2eDump } from '../../bridge/diagnostics/real-e2e-dump.js';
import { listCursorDesktopThreads } from '../../runtime/cursor/desktop-bridge-client.js';
import { CodexAppServerClient } from '../../runtime/codex/app-server-client.js';
import { readCodexSessionMirrorRecordStreamByFilePath } from '../../runtime/codex/session-index.js';

const exec = promisify(execFile);
export interface AttachmentTestOptions {
  home: string; channel: string; profile: string; appId: string; botId: string;
  runtime: 'codex' | 'cursor'; cursorThread?: string; chatId: string;
  runId: string; directory: string; timeoutMs: number;
}
export interface AttachmentEvidence {
  transport: 'websocket'; runtime: 'codex' | 'cursor'; chatId: string;
  initialThread: string; finalThread: string;
  replies: Array<{ inputId: string; replyId: string; userReadback: boolean; botAuthored: boolean }>;
  imageAnswer: boolean; fileAnswer: boolean; quotedFileAnswer: boolean; mergedAnswer: boolean;
  imageBytesEqual: boolean; fileBytesEqual: boolean;
  activeSteer: boolean; extraSdkStream: boolean; automaticOutput: boolean;
}

/** Shared by the executable acceptance test and its negative gate tests. */
export function assertAttachmentAcceptance(e: AttachmentEvidence): void {
  assert.equal(e.transport, 'websocket', 'event replay is not end-to-end acceptance');
  assert(e.initialThread && e.initialThread === e.finalThread, 'native conversation changed');
  assert(e.replies.length >= 5 && e.replies.every(r => r.inputId && r.replyId && r.userReadback && r.botAuthored), 'missing actual user readback of automatic bot replies');
  for (const field of ['imageAnswer', 'fileAnswer', 'quotedFileAnswer', 'mergedAnswer', 'imageBytesEqual', 'fileBytesEqual', 'automaticOutput', 'activeSteer'] as const) {
    assert(e[field], `attachment gate failed: ${field}`);
  }
  assert.equal(e.extraSdkStream, false, 'attachment opened an extra SDK stream');
}

export class AttachmentLarkClient {
  private sequence = 0;
  constructor(readonly profile: string, readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  async cli(args: string[]): Promise<any> {
    const { stdout } = await exec('npx', ['--no-install', 'lark-cli', '--profile', this.profile, ...args], { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 });
    const result = JSON.parse(stdout);
    if (result.ok === false || (result.code !== undefined && result.code !== 0)) throw new Error(`lark-cli: ${JSON.stringify(result.error || { code: result.code, msg: result.msg })}`);
    return result;
  }
  async api(method: string, endpoint: string, options: { as?: 'user' | 'bot'; data?: unknown; params?: unknown; file?: string; output?: string } = {}): Promise<any> {
    const args = ['api', method, endpoint, '--as', options.as || 'user'];
    const sequence = ++this.sequence;
    if (options.data !== undefined) {
      const request = path.join(this.directory, `request-${sequence}.json`);
      fs.writeFileSync(request, JSON.stringify(options.data), { mode: 0o600 });
      args.push('--data', `@${path.relative(process.cwd(), request)}`);
    }
    if (options.params) args.push('--params', JSON.stringify(options.params));
    if (options.file) args.push('--file', options.file);
    if (options.output) args.push('--output', path.relative(process.cwd(), options.output));
    const result = await this.cli(args);
    fs.writeFileSync(path.join(this.directory, `response-${sequence}.json`), JSON.stringify(result), { mode: 0o600 });
    return result;
  }
  async read(messageId: string): Promise<any> {
    const r = await this.api('GET', `/open-apis/im/v1/messages/${messageId}`, { params: { card_msg_content_type: 'user_card_content' } });
    const item = r.data?.items?.find((m: any) => m.message_id === messageId);
    assert(item, `user cannot read message ${messageId}`); return item;
  }
}

export function solidColorPng(rgb: [number, number, number]): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const input = Buffer.concat([Buffer.from(name), data]); let crc = 0xffffffff;
    for (const byte of input) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); input.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(64); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(64 * (1 + 64 * 3));
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) rgb.forEach((v, i) => { rows[y * 193 + 1 + x * 3 + i] = v; });
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

export async function runAttachmentE2E(o: AttachmentTestOptions): Promise<AttachmentEvidence> {
  const lark = new AttachmentLarkClient(o.profile, o.directory);
  const report: AttachmentEvidence = { transport: 'websocket', runtime: o.runtime, chatId: o.chatId,
    initialThread: '', finalThread: '', replies: [], imageAnswer: false, fileAnswer: false,
    quotedFileAnswer: false, mergedAnswer: false, imageBytesEqual: false, fileBytesEqual: false,
    activeSteer: false, extraSdkStream: false, automaticOutput: false };
  const inputs: string[] = []; let stage = 'setup';
  let nativeClient: CodexAppServerClient | undefined;
  let nativeTurnId: string | undefined;
  let streamsBeforeAttachments: Set<string> | undefined;
  const save = (error?: unknown) => fs.writeFileSync(path.join(o.directory, 'report.json'), JSON.stringify({
    ...report, passed: !error && stage === 'complete', stage, inputs, error: error ? String(error) : undefined,
    runId: o.runId, boundary: 'real Lark user API -> WebSocket bridge -> native runtime -> automatic Feishu output -> user API readback',
  }, null, 2), { mode: 0o600 });
  const dump = () => collectRealE2eDump({ codelarkHome: o.home, channelType: o.channel, chatId: o.chatId, logTailBytes: 4 * 1024 * 1024, auditLimit: 500 });
  const wait = async <T>(label: string, probe: () => Promise<T | undefined>): Promise<T> => {
    const deadline = Date.now() + o.timeoutMs;
    while (Date.now() < deadline) { const result = await probe(); if (result !== undefined) return result; await new Promise(r => setTimeout(r, 1800)); }
    throw new Error(`Timed out: ${label}`);
  };
  const nativeRunning = async (): Promise<boolean> => {
    const current = dump();
    if (!current.runtimeThreadId) return false;
    if (current.runtime === 'cursor') return (await listCursorDesktopThreads()).find(t => t.id === current.runtimeThreadId)?.status === 'running';
    const endpoint = current.session?.runtime?.codex?.appServerEndpoint;
    if (!endpoint) return false;
    nativeClient ||= await CodexAppServerClient.connect(endpoint);
    // Paginated Desktop app-servers reject includeTurns. Read live activity via
    // RPC and the native turn ID from this exact thread's persisted event log.
    const response = await nativeClient.request<any>('thread/read', { threadId: current.runtimeThreadId, includeTurns: false });
    const nativePath = response.thread?.path;
    if (nativePath) nativeTurnId = readCodexSessionMirrorRecordStreamByFilePath(nativePath).filter(r => r.type === 'task_started').at(-1)?.turnId;
    assert(['idle', 'active'].includes(response.thread?.status?.type), 'native activity unavailable');
    return response.thread.status.type === 'active';
  };
  const list = async (): Promise<any[]> => {
    const all: any[] = []; let token: string | undefined;
    do {
      const response = await lark.api('GET', '/open-apis/im/v1/messages', { params: { container_id_type: 'chat', container_id: o.chatId, page_size: 50, sort_type: 'ByCreateTimeAsc', ...(token ? { page_token: token } : {}) } });
      all.push(...(response.data?.items || [])); token = response.data?.has_more ? response.data.page_token : undefined;
      assert(all.length < 1000, 'unexpected test-chat flood');
    } while (token);
    return all;
  };
  const send = async (type: string, content: unknown, parent?: string): Promise<string> => {
    const response = await lark.api('POST', parent ? `/open-apis/im/v1/messages/${parent}/reply` : '/open-apis/im/v1/messages', {
      ...(!parent ? { params: { receive_id_type: 'chat_id' } } : {}),
      data: { msg_type: type, content: JSON.stringify(content), ...(parent ? { reply_in_thread: false } : { receive_id: o.chatId }), uuid: crypto.randomUUID() },
    });
    const id = response.data?.message_id; assert(id); inputs.push(id); save(); return id;
  };
  const text = (value: string, parent?: string) => send('text', { text: `<at user_id="${o.botId}">bot</at> ${value}` }, parent);
  // Bot-authored fixtures do not trigger the model. Each quote/merge/steer gets
  // an unseen payload, so a remembered answer cannot satisfy its acceptance gate.
  const fileFixture = async (label: string) => {
    const nonce = `${label}-${crypto.randomBytes(8).toString('hex')}`;
    const file = path.join(o.directory, `${label}.txt`); fs.writeFileSync(file, `${nonce}\n`);
    const uploaded = await lark.api('POST', '/open-apis/im/v1/files', { as: 'bot', data: { file_type: 'stream', file_name: `${label}.txt` }, file: `file=${path.relative(process.cwd(), file)}` });
    const sent = await lark.api('POST', '/open-apis/im/v1/messages', { as: 'bot', params: { receive_id_type: 'chat_id' }, data: {
      receive_id: o.chatId, msg_type: 'file', content: JSON.stringify({ file_key: uploaded.data.file_key }),
    } });
    return { nonce, id: sent.data.message_id as string };
  };
  const botMessages = (messages: any[]) => messages.filter(m => m.sender?.sender_type === 'app' && m.sender?.id === o.appId);
  const response = async (inputId: string, before: Set<string>, expected: string[]): Promise<any> => {
    const result = await wait(`automatic answer to ${inputId}`, async () => {
      for (const m of botMessages(await list()).filter(m => !before.has(m.message_id))) {
        // List returns a compatibility placeholder for CardKit 2.0. Only the
        // per-message user_card_content read exposes its actual rendered body.
        if (m.msg_type !== 'interactive' && !expected.every(marker => String(m.body?.content || '').toLowerCase().includes(marker.toLowerCase()))) continue;
        const actual = await lark.read(m.message_id);
        if (expected.every(marker => String(actual.body?.content || '').toLowerCase().includes(marker.toLowerCase()))) return actual;
      }
      return undefined;
    });
    assert(dump().audit.some(a => a.direction === 'inbound' && a.messageId === inputId), 'missing real bridge inbound audit');
    await wait('native turn completed', async () => await nativeRunning() ? undefined : true);
    const finalReply = await lark.read(result.message_id);
    assert(expected.every(marker => String(finalReply.body?.content || '').toLowerCase().includes(marker.toLowerCase())), 'final message lost expected content');
    if (report.initialThread) assert.equal(dump().runtimeThreadId, report.initialThread, 'attachment changed the native conversation');
    report.replies.push({ inputId, replyId: result.message_id, userReadback: true, botAuthored: true }); save(); return result;
  };
  const roundtrip = async (prompt: string, expected: string[], parent?: string) => {
    const before = new Set((await list()).map(m => m.message_id));
    return response(await text(prompt, parent), before, expected);
  };
  const phase = (value: string) => { stage = value; save(); process.stderr.write(`[attachments-e2e] ${value}\n`); };
  try {
    await roundtrip('/require-at on', ['on']);
    await roundtrip(`/runtime ${o.runtime}`, [o.runtime]);
    if (o.runtime === 'cursor') {
      assert(o.cursorThread, 'Cursor Desktop requires an explicitly selected test thread');
      const target = (await listCursorDesktopThreads()).find(t => t.id === o.cursorThread);
      assert(target && /CodeLark.*E2E/i.test(target.title) && target.status !== 'running', 'select an idle, dedicated CodeLark E2E Desktop conversation');
      await roundtrip(`/thread ${o.cursorThread}`, [o.cursorThread]);
    } else {
      await roundtrip('/p tmux', ['tmux']);
    }
    await roundtrip('这是附件端到端测试。现在只回复 READY。', ['READY']);
    const initial = dump(); report.initialThread = initial.runtimeThreadId || '';
    streamsBeforeAttachments = new Set(initial.streamKeys);
    assert(initial.runtime === o.runtime && report.initialThread);
    if (o.runtime === 'cursor') assert(initial.session?.runtime?.cursor?.transport === 'desktop' && report.initialThread === o.cursorThread);
    else assert(initial.session?.runtime?.codex?.appServerEndpoint, 'Codex test must exercise the native app-server');

    const colors = [{ name: 'red', rgb: [255, 0, 0] }, { name: 'blue', rgb: [0, 0, 255] }, { name: 'green', rgb: [0, 255, 0] }] as const;
    const color = colors[crypto.randomInt(colors.length)];
    const png = solidColorPng([...color.rgb]);
    const nonce = `FILE-${crypto.randomBytes(8).toString('hex')}`;
    const payload = Buffer.from(`${nonce}\nattachment E2E\n`);
    const imagePath = path.join(o.directory, 'test image.png'), filePath = path.join(o.directory, 'test file.txt');
    fs.writeFileSync(imagePath, png); fs.writeFileSync(filePath, payload);
    const imageUpload = await lark.api('POST', '/open-apis/im/v1/images', { as: 'bot', data: { image_type: 'message' }, file: `image=${path.relative(process.cwd(), imagePath)}` });
    const fileUpload = await lark.api('POST', '/open-apis/im/v1/files', { as: 'bot', data: { file_type: 'stream', file_name: 'test file.txt' }, file: `file=${path.relative(process.cwd(), filePath)}` });

    phase('direct-image');
    let before = new Set((await list()).map(m => m.message_id));
    const imageId = await send('post', { zh_cn: { title: '', content: [[{ tag: 'at', user_id: o.botId }, { tag: 'text', text: '图片底色是什么？只回复英文颜色。' }], [{ tag: 'img', image_key: imageUpload.data.image_key, width: 64, height: 64 }]] } });
    await response(imageId, before, [color.name]); report.imageAnswer = true;
    assert(!botMessages(await list()).filter(m => !before.has(m.message_id)).some(m => String(m.body?.content || '').includes('当前暂不支持的内容')), 'valid image dimensions produced an unsupported-content warning');
    phase('user-file-citation'); before = new Set((await list()).map(m => m.message_id));
    const fileId = await send('file', { file_key: fileUpload.data.file_key });
    // A file bubble cannot carry an @mention. Users send it first, then cite
    // that message in an @bot question; the bare file must not start a turn.
    await wait('unmentioned file filtered', async () => dump().audit.some(a => a.messageId === fileId && a.summary.includes('[FILTERED]')) ? true : undefined);
    assert.equal(await nativeRunning(), false, 'unmentioned file unexpectedly started a model turn');
    assert.equal(botMessages(await list()).filter(m => !before.has(m.message_id)).length, 0, 'unmentioned file received an unexpected bot response');
    const citationId = await text('读取引用文件的第一行。', fileId);
    assert.equal((await lark.read(citationId)).parent_id, fileId, 'file question must be a real Feishu citation');
    await response(citationId, before, [nonce]); report.fileAnswer = true;
    phase('automatic-outbound-image-and-file'); before = new Set((await list()).map(m => m.message_id));
    const outboundId = await text('请把刚才收到的图片和文件原样发回来。');
    // Do not teach the model a directory, link syntax, or sending mechanism.
    // Actual outbound image/file bytes below are the acceptance criterion.
    await response(outboundId, before, []);
    for (const [kind, bytes] of [['image', png], ['file', payload]] as const) {
      const sent = await wait(`automatic outbound ${kind}`, async () => botMessages(await list()).find(m => !before.has(m.message_id) && m.msg_type === kind));
      const actual = await lark.read(sent.message_id), body = JSON.parse(actual.body.content);
      const output = path.join(o.directory, `returned-${kind}.bin`);
      await lark.api('GET', `/open-apis/im/v1/messages/${actual.message_id}/resources/${body[kind === 'image' ? 'image_key' : 'file_key']}`, { params: { type: kind }, output });
      assert.deepEqual(fs.readFileSync(output), bytes, `returned ${kind} bytes differ`);
      if (kind === 'image') report.imageBytesEqual = true; else report.fileBytesEqual = true;
    }
    report.automaticOutput = true;

    phase('quoted-file');
    const quoted = await fileFixture('QUOTED');
    await roundtrip('读取被引用文件的第一行。', [quoted.nonce], quoted.id); report.quotedFileAnswer = true;

    phase('nested-merged-message');
    const merged = await fileFixture('MERGED');
    const mergedColor = colors.find(c => c.name !== color.name)!;
    const mergedImage = path.join(o.directory, 'merged image.png'); fs.writeFileSync(mergedImage, solidColorPng([...mergedColor.rgb]));
    const mergedUpload = await lark.api('POST', '/open-apis/im/v1/images', { as: 'bot', data: { image_type: 'message' }, file: `image=${path.relative(process.cwd(), mergedImage)}` });
    const mergedImageMessage = await lark.api('POST', '/open-apis/im/v1/messages', { as: 'bot', params: { receive_id_type: 'chat_id' }, data: {
      receive_id: o.chatId, msg_type: 'image', content: JSON.stringify({ image_key: mergedUpload.data.image_key }),
    } });
    const merge = async (ids: string[]) => (await lark.api('POST', '/open-apis/im/v1/messages/merge_forward', { as: 'bot', params: { receive_id_type: 'chat_id' }, data: { receive_id: o.chatId, message_id_list: ids } })).data.message.message_id as string;
    const inner = await merge([mergedImageMessage.data.message_id, merged.id]); const outer = await merge([inner]);
    await lark.read(outer);
    await roundtrip('展开合并转发，读取其中的文件第一行，并用英文说出图片底色。', [merged.nonce, mergedColor.name], outer); report.mergedAnswer = true;

    phase('active-attachment-steer');
    const steered = await fileFixture('STEER-FILE');
    before = new Set((await list()).map(m => m.message_id));
    await text('请用 shell 工具执行 sleep 25，等待工具完成后再回复 WAIT-DONE。');
    await wait('native turn running', async () => await nativeRunning() ? true : undefined);
    const steeredTurnId = nativeTurnId;
    const streamsBeforeSteer = new Set(dump().streamKeys);
    const steerMarker = `STEER-${crypto.randomBytes(4).toString('hex')}`;
    const followupId = await text(`更新任务：读取引用文件，只回复第一行和 ${steerMarker}。`, steered.id);
    await response(followupId, before, [steered.nonce, steerMarker]);
    const final = dump(); report.finalThread = final.runtimeThreadId || '';
    report.extraSdkStream = final.streamKeys.some(k => !streamsBeforeAttachments!.has(k) && k.startsWith('im:'));
    assert(!final.streamKeys.some(k => !streamsBeforeSteer.has(k) && k.startsWith('im:')), 'steer opened another SDK stream');
    report.activeSteer = o.runtime === 'cursor'
      ? final.audit.some(a => a.messageId === followupId && /Cursor Desktop append.*delivery=steer/.test(a.summary))
      : Boolean(steeredTurnId) && steeredTurnId === nativeTurnId && !report.extraSdkStream && report.initialThread === report.finalThread;
    assertAttachmentAcceptance(report); phase('complete'); return report;
  } catch (error) {
    save(error);
    await text('/stop').catch(() => {});
    save(error); throw error;
  } finally { nativeClient?.close(); }
}
