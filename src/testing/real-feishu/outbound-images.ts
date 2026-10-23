import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { solidColorPng } from './attachments.js';
import { userReadbackMessages } from './app-server-lifecycle.js';
import type { ConfigurationStoryContext } from './session-configuration.js';

/** Real user commands and model output, delivered by the running Bridge. */
export async function runOutboundImages(c: ConfigurationStoryContext): Promise<() => Promise<void>> {
  const { driver: d } = c;
  assert(d.workspace, 'Image delivery requires the isolated test workspace');
  const imagePath = path.join(d.workspace, 'delivery photo.PNG');
  const filePath = path.join(d.workspace, 'delivery report.txt');
  fs.writeFileSync(imagePath, solidColorPng([32, 128, 224]));
  fs.writeFileSync(filePath, `EXPLICIT_FILE_${d.runId}\n`);
  const before = new Set(userReadbackMessages(await c.read(d.chatId)).map(m => m.message_id));
  const initial = await c.state(d.chatId);
  assert(initial.threadId);
  const marker = `IMAGE_DELIVERY_${d.runId}`;
  const answer = `${marker}\n[报告](<${filePath}>)\n[附图](<${imagePath}>)\n![附图](<${imagePath}>)`;
  d.model.enqueue({ text: answer });
  const modelInput = await c.send(d.chatId, marker);
  await c.visible(d.chatId, marker);
  await c.wait('图片输出原生轮次完成', async () => (await c.thread(initial.threadId!)).turns.find(t =>
    t.status === 'completed' && t.items.some(i => i.type === 'userMessage' && JSON.stringify(i).includes(marker))));
  const newBotMessages = async () => userReadbackMessages(await c.read(d.chatId)).filter(m =>
    !before.has(m.message_id) && m.sender?.sender_type === 'app' && m.sender.id === d.botAppId);
  await c.wait('Markdown 附图实际发送', async () => (await newBotMessages()).find(m => m.msg_type === 'image'));
  const imageCommand = await c.command(d.chatId, '/file delivery photo.PNG', '已发送图片');
  await c.wait('/file 原生图片实际发送', async () => (await newBotMessages()).find(m => m.reply_to === imageCommand && m.msg_type === 'image'));
  const fileCommand = await c.command(d.chatId, '/file delivery report.txt', '已发送文件');
  await c.wait('/file 普通文件实际发送', async () => (await newBotMessages()).find(m => m.reply_to === fileCommand && m.msg_type === 'file'));
  const expected = new Map([[imageCommand, 'image'], [fileCommand, 'file']]);
  const verify = async () => {
    const messages = await newBotMessages();
    const resources = messages.filter(m => ['image', 'file'].includes(m.msg_type));
    // No other lifecycle step sends images/files; recheck at the end to catch
    // delayed final uploads and duplicate streaming deliveries.
    assert.equal(resources.length, 3, '非图片链接不能上传，同一图片不能重复或退化成文件');
    for (const [input, type] of expected) {
      const replies = resources.filter(m => m.reply_to === input);
      assert.equal(replies.length, 1, '每次显式附件发送必须且只能产生一条原生消息');
      assert.equal(replies[0].msg_type, type);
      assert.match(JSON.stringify(replies[0].content), type === 'image' ? /img_/ : /file_/);
    }
    const cards = messages.filter(m => m.msg_type === 'interactive' && String(m.content).includes(marker));
    assert.equal(cards.length, 1, '模型答案应保留在同一张卡片');
    const modelImages = resources.filter(m => m.reply_to === cards[0].message_id);
    assert.equal(modelImages.length, 1, 'Markdown 附图必须回复当前模型卡片');
    assert.equal(modelImages[0].msg_type, 'image');
    assert.match(JSON.stringify(modelImages[0].content), /img_/);
    const content = String(cards[0].content);
    assert(content.includes(marker) && content.includes(filePath) && content.includes(imagePath), '所有原链接保留在实际卡片正文，图片同时额外交付');
    assert(content.includes('[附图]('), '原始图片链接标签必须保留');
    assert(!content.includes('![附图]'), '本地图片写法转为普通超链接以兼容卡片');
    assert.equal((await c.state(d.chatId)).threadId, initial.threadId);
  };
  await verify();
  c.check('outbound_images_and_explicit_file_user_readback', { modelInput, imageCommand, fileCommand, imagePath, filePath });
  // Later lifecycle steps intentionally replace the thread, so only the
  // message invariants apply to the final readback.
  return async () => {
    const messages = await newBotMessages();
    const resources = messages.filter(m => ['image', 'file'].includes(m.msg_type));
    const card = messages.find(m => m.msg_type === 'interactive' && String(m.content).includes(marker));
    assert(card && String(card.content).includes(imagePath) && String(card.content).includes('[附图]('), '图片送达后的最终卡片必须仍保留原链接');
    assert.equal(resources.length, 3, '终态出现延迟上传或重复附件');
    c.check('outbound_images_no_late_duplicates', { messageIds: resources.map(m => m.message_id) });
  };
}
