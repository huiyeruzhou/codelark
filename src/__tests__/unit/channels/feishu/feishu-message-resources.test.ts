import '../../../setup/test-setup.js';
import { beforeEach, afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { FeishuAdapter } from '../../../../channels/feishu/adapter.js';
import { initBridgeTestContext, resetBridgeTestState } from '../../../helpers/bridge/test-bridge-utils.js';

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
  assert.match(msg.contextText!, /已附加文件：bridge.log/);
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
    assert.doesNotMatch(content, /must not leak|请使用 lark-cli/);
    assert.equal(msg.attachments, undefined);
    assert.equal(downloads.length, 0);
    assert.match(content, /image-key/);
    assert.match(content, /飞书资源接口不支持下载合并转发子消息/);
  }
});
it('preserves metadata on download failure and rejects cross-chat quotes before downloading', async () => {
  const file = item('om_root', 'file', { file_key: 'missing-key', file_name: 'missing.pdf' });
  const { a } = setup([file], true); const msg = await incoming(a); assert(msg);
  assert.match(msg.contextText!, /附件下载失败：missing.pdf/); assert.equal(msg.attachments, undefined);
  const crossed = setup([{ ...file, chat_id: 'oc_other' }]);
  const denied = await incoming(crossed.a); assert(denied);
  assert.match(denied.contextText!, /read_error="true"/); assert.equal(crossed.downloads.length, 0);
});
it('resolves merged attachments through unchanged originals in the current chat only', async () => {
  const merged = [item('om_root', 'merge_forward', 'root'),
    item('om_file', 'file', { file_key: 'merged-key', file_name: 'report.txt' }, 'om_root')];
  for (const accessible of [true, false]) {
    const { a, downloads } = setup(merged);
    (a as any).restClient.im.message.get = async (p: any) => ({ data: { items: p.path.message_id === 'om_root' ? merged
      : [{ ...item('om_file', 'file', { file_key: 'original-key', file_name: 'report.txt' }), chat_id: accessible ? 'oc_group' : 'oc_other' }] } });
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
