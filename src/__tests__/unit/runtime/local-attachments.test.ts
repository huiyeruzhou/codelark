import '../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareMessageAttachments, prepareTextAttachmentPrompt, buildConversationPromptText } from '../../../runtime/local-attachments.js';
import { attachmentPromptReference } from '../../../domain/message.js';

it('places paths inside the originating message, including images, without a trailing duplicate list', () => {
  const files = ['one', 'two'].map((id) => ({ id, name: 'same.png', type: 'image/png', size: 1, filePath: `/tmp/${id}.png` }));
  const input = `first\n${attachmentPromptReference('one')}\nsecond\n${attachmentPromptReference('two')}\nend`;
  const result = buildConversationPromptText(input, files);
  assert(result.indexOf('/tmp/one.png') < result.indexOf('second'));
  assert(result.indexOf('/tmp/two.png') > result.indexOf('second'));
  assert(result.endsWith('end'));
  assert.doesNotMatch(result, /attachment_ref|local_attachments/);
  assert.equal(result.split('/tmp/one.png').length, 2);
});
it('preserves distinct same-named files and exposes image paths to text-only transports', (t) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codelark-local-attachments-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const files=['one','two'].map((data,i)=>({id:String(i),name:'same.png',type:'image/png',size:data.length,data:Buffer.from(data).toString('base64')}));
  const prepared=prepareMessageAttachments({text:'view',files,workDir:root});
  assert.notEqual(prepared.llmFiles![0].filePath,prepared.llmFiles![1].filePath);
  assert.deepEqual(prepared.llmFiles!.map(f=>fs.readFileSync(f.filePath!,'utf8')),['one','two']);
  const prompt=prepareTextAttachmentPrompt({prompt:'查看两张图',files:prepared.llmFiles,workingDirectory:root});
  for(const file of prepared.llmFiles!) assert(prompt.includes(file.filePath!));
  assert.match(prompt,/图片使用看图工具/);
  assert.equal(fs.readdirSync(path.join(root,'.codepilot-uploads')).length,2,'already persisted files must be reused');
});
