import '../../../setup/test-setup.js';
import { beforeEach, afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { FeishuAdapter } from '../../../../channels/feishu/adapter.js';
import { initBridgeTestContext, resetBridgeTestState } from '../../../helpers/bridge/test-bridge-utils.js';
import { prepareTextAttachmentPrompt } from '../../../../runtime/local-attachments.js';

beforeEach(() => { resetBridgeTestState(); initBridgeTestContext(); });
afterEach(() => resetBridgeTestState());
const item = (id: string, type: string, content: unknown, upper?: string) => ({ message_id: id, chat_id: 'oc_group', msg_type: type,
  body: { content: typeof content === 'string' ? content : JSON.stringify(content) }, upper_message_id: upper });
function setup(items: any[], fail = false) {
  const a = new FeishuAdapter({ id: 'feishu', provider: 'feishu', enabled: true, alias: 'test', config: {} });
  const downloads: any[] = [];
  (a as any).restClient = { im: { message: { get: async (p: any) => {
    assert.equal(p.params.card_msg_content_type, 'user_card_content'); return { data: { items } };
  } }, messageResource: { get: async (p: any) => {
    downloads.push(p);
    if (fail) throw Error('file unavailable');
    return { getReadableStream: () => Readable.from([p.params.type === 'image' ? Buffer.from([0xff, 0xd8, 0xff, 0x01]) : Buffer.from('LOG-CONTENT')]) };
  } } } };
  return { a, downloads };
}
async function incoming(a: FeishuAdapter, type = 'text', parent = 'om_root') {
  await (a as any).processIncomingEvent({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } }, message: {
    message_id: type === 'merge_forward' ? 'om_root' : 'om_reply', parent_id: type === 'merge_forward' ? undefined : parent,
    chat_id: 'oc_group', chat_type: 'group', message_type: type, content: type === 'text' ? '{"text":"请分析"}' : '{}', create_time: String(Date.now()),
  } });
  return a.consumeOne();
}
it('hydrates a quoted file with its name, original message resource and actual bytes', async () => {
  const { a, downloads } = setup([item('om_root', 'file', { file_key: 'file_key', file_name: 'bridge.log' })]);
  const msg = await incoming(a); assert(msg);
  assert.equal(msg.attachments?.[0].name, 'bridge.log');
  assert.equal(Buffer.from(msg.attachments![0].data, 'base64').toString(), 'LOG-CONTENT');
  assert.match(msg.contextText!, /message_type="file"/);
  assert.match(msg.contextText!, /attachment_ref/);
  const prompt = prepareTextAttachmentPrompt({ prompt: msg.contextText!, files: msg.attachments });
  assert.match(prompt, /name="bridge.log".*path="/);
  assert(prompt.indexOf('path=') < prompt.indexOf('</quoted_message>'));
  assert.doesNotMatch(msg.contextText!, /请使用 lark-cli/);
  assert.equal(downloads[0].path.message_id, 'om_root');
});
it('expands nested merged messages and preserves resource metadata with the Feishu download limitation', async () => {
  const items = [item('om_root', 'merge_forward', 'Merged and Forwarded Message'),
    item('om_nested', 'merge_forward', 'nested', 'om_root'),
    item('om_file', 'file', { file_key: 'file-key', file_name: 'report.txt' }, 'om_nested'),
    item('om_text', 'text', { text: 'ORDER-432' }, 'om_root'),
    item('om_post', 'post', { title: '截图', content: [[{ tag: 'text', text: '图片说明' }, { tag: 'img', image_key: 'image-key' }]] }, 'om_nested'),
    item('om_unrelated', 'text', { text: 'must not leak' }, 'om_outside')];
  for (const type of ['text', 'merge_forward']) {
    const { a, downloads } = setup(items); const msg = await incoming(a, type); assert(msg);
    const content = type === 'text' ? msg.contextText! : msg.text;
    assert.match(content, /ORDER-432/); assert.match(content, /图片说明/); assert.match(content, /report.txt/);
    assert.doesNotMatch(content, /must not leak/);
    assert.match(content, /\+messages-resources-download.*--message-id/);
    assert.match(content, /原消息读取：lark-cli api GET/);
    assert.equal(msg.attachments, undefined);
    assert.equal(downloads.length, 0);
    assert.match(content, /image-key/);
    assert.match(content, /飞书资源接口不支持下载合并转发子消息/);
  }
});

it('skips a known oversized attachment before issuing the resource request and retains download metadata', async () => {
  const { a, downloads } = setup([item('om_root', 'file', { file_key: 'huge-key', file_name: 'huge.zip', file_size: 21 * 1024 * 1024 })]);
  const msg = await incoming(a); assert(msg);
  assert.equal(downloads.length, 0);
  assert.equal(msg.attachments, undefined);
  assert.match(msg.contextText!, /超过自动下载上限/);
  assert.match(msg.contextText!, /file_key="huge-key"/);
  assert.match(msg.contextText!, /--message-id 'om_root'.*--file-key 'huge-key'.*--output '\.\/huge.zip'/);
});

it('stops a declared oversized response before reading bytes or falling back to writeFile', async () => {
  const { a } = setup([item('om_root', 'file', { file_key: 'huge-key' })]);
  let reads = 0;
  const stream = new Readable({ read() { reads++; this.push(Buffer.alloc(1)); this.push(null); } });
  (a as any).restClient.im.messageResource.get = async () => ({ headers: { 'content-length': String(21 * 1024 * 1024) },
    getReadableStream: () => stream, writeFile: () => assert.fail('must not download through fallback') });
  const msg = await incoming(a); assert(msg);
  assert.equal(reads, 0); assert(stream.destroyed);
  assert.match(msg.contextText!, /超过自动下载上限/);
});

it('keeps rich-text image paths between the surrounding paragraphs', async () => {
  const { a } = setup([item('om_root', 'post', { content: [[{ tag: 'text', text: 'BEFORE' }, { tag: 'img', image_key: 'img-inline' }, { tag: 'text', text: 'AFTER' }]] })]);
  const msg = await incoming(a); assert(msg);
  const prompt = prepareTextAttachmentPrompt({ prompt: msg.contextText!, files: msg.attachments });
  assert(prompt.indexOf('BEFORE') < prompt.indexOf('path='));
  assert(prompt.indexOf('path=') < prompt.indexOf('AFTER'));
  assert.doesNotMatch(prompt, /attachment_ref|local_attachments/);
});
it('preserves metadata on download failure and rejects cross-chat quotes before downloading', async () => {
  const file = item('om_root', 'file', { file_key: 'missing-key', file_name: 'missing.pdf' });
  const { a } = setup([file], true); const msg = await incoming(a); assert(msg);
  assert.match(msg.contextText!, /附件下载失败：missing.pdf/); assert.equal(msg.attachments, undefined);
  const crossed = setup([{ ...file, chat_id: 'oc_other' }]);
  const denied = await incoming(crossed.a); assert(denied);
  assert.match(denied.contextText!, /read_error="true"/); assert.equal(crossed.downloads.length, 0);
});
it('automatically resolves keys from accessible original messages, including another chat', async () => {
  const merged = [item('om_root', 'merge_forward', 'root'),
    item('om_file', 'file', { file_key: 'merged-key', file_name: 'report.txt' }, 'om_root')];
  for (const accessible of [true, false]) {
    const { a, downloads } = setup(merged);
    (a as any).restClient.im.message.get = async (p: any) => ({ data: { items: p.path.message_id === 'om_root' ? merged
      : [{ ...item('om_file', 'file', { file_key: 'original-key', file_name: 'report.txt' }), chat_id: 'oc_other', deleted: !accessible }] } });
    const msg = await incoming(a); assert(msg);
    if (accessible) {
      assert.equal(downloads[0].path.file_key, 'original-key');
      assert.equal(msg.attachments?.[0].name, 'report.txt');
    } else {
      assert.equal(downloads.length, 0);
      assert.match(msg.contextText!, /不支持下载合并转发子消息/);
    }
  }
});
it('bounds merged contents and keeps an explicit truncation marker', async () => {
  const { a } = setup([item('om_root', 'merge_forward', 'root'), ...Array.from({ length: 70 }, (_, i) => item(`om_${i}`, 'text', { text: `ENTRY-${i}` }, 'om_root'))]);
  const msg = await incoming(a); assert(msg);
  assert.match(msg.contextText!, /ENTRY-48/); assert.doesNotMatch(msg.contextText!, /ENTRY-49/);
  assert.match(msg.contextText!, /其余内容未展开/);
});
it('bounds failed attachment attempts and preserves post text', async () => {
  const { a, downloads } = setup([item('om_root', 'post', { title: 'FAILED-RESOURCES', content: [
    Array.from({ length: 25 }, (_, i) => ({ tag: 'img', image_key: `key-${i}` })),
  ] })], true);
  const msg = await incoming(a); assert(msg);
  assert.equal(downloads.length, 20);
  assert.match(msg.contextText!, /附件总量超限/);
  assert.match(msg.contextText!, /FAILED-RESOURCES/);
});
it('downloads quoted images and rich-text images using their original message and actual MIME type', async () => {
  for (const type of ['image', 'post']) {
    const body = type === 'image' ? { image_key: 'image-key' } : { content: [[{ tag: 'img', image_key: 'image-key' }]] };
    const { a, downloads } = setup([item('om_root', type, body)]);
    const msg = await incoming(a); assert(msg);
    assert.equal(downloads[0].path.message_id, 'om_root');
    assert.equal(msg.attachments?.[0].type, 'image/jpeg');
    assert.deepEqual(Buffer.from(msg.attachments![0].data, 'base64'), Buffer.from([0xff, 0xd8, 0xff, 0x01]));
  }
});
it('closes the quote wrapper when a long message exhausts the character budget', async () => {
  const { a } = setup([item('om_root', 'text', { text: 'x'.repeat(80_000) })]);
  const msg = await incoming(a); assert(msg);
  assert(msg.contextText!.length <= 64_000);
  assert.match(msg.contextText!, /已截断\]\n<\/quoted_message>$/);
});


it('shares the byte budget between a direct attachment and its quoted attachment', async () => {
  const size = 12 * 1024 * 1024;
  const { a, downloads } = setup([item('om_root', 'file', { file_key: 'quoted-key', file_name: 'quoted.bin', file_size: size })]);
  (a as any).restClient.im.messageResource.get = async (p: any) => {
    downloads.push(p);
    return { getReadableStream: () => Readable.from([Buffer.alloc(size)]) };
  };
  await (a as any).processIncomingEvent({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } }, message: {
    message_id: 'om_direct', parent_id: 'om_root', chat_id: 'oc_group', chat_type: 'group', message_type: 'file',
    content: JSON.stringify({ file_key: 'direct-key', file_name: 'direct.bin', file_size: size }), create_time: String(Date.now()),
  } });
  const msg = await a.consumeOne(); assert(msg);
  assert.equal(msg.attachments?.length, 1);
  assert.equal(msg.attachments[0].name, 'direct.bin');
  assert.equal(downloads.length, 1);
  assert.match(msg.contextText!, /file_key="quoted-key"/);
  assert.match(msg.contextText!, /超过自动下载上限/);
});

it('resolves merged original keys even when the download byte budget is exhausted', async () => {
  const merged = [item('om_root', 'merge_forward', 'root'), item('om_file', 'file', { file_key: 'merged-key' }, 'om_root')];
  const { a, downloads } = setup(merged);
  (a as any).restClient.im.message.get = async (p: any) => ({ data: { items: p.path.message_id === 'om_root' ? merged
    : [item('om_file', 'file', { file_key: 'original-key', file_name: 'deferred.bin' })] } });
  const content = await (a as any).buildQuotedMessageContext('om_root', [{ size: 20 * 1024 * 1024 }], 'oc_group');
  assert.equal(downloads.length, 0);
  assert.match(content, /file_key="original-key"/);
  assert.match(content, /--file-key 'original-key'/);
  assert.doesNotMatch(content, /替换为原消息/);
});
