import '../../setup/test-setup.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareMessageAttachments, prepareTextAttachmentPrompt } from '../../../runtime/local-attachments.js';
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
