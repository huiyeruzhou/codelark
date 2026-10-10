import fs from 'fs';
import crypto from 'node:crypto';
import path from 'path';

import type { FileAttachment } from '../domain/index.js';

export interface PersistedAttachmentMeta {
  id: string;
  name: string;
  type: string;
  size: number;
  filePath: string;
}

export interface PreparedMessageAttachments {
  savedContent: string;
  llmFiles?: FileAttachment[];
  persistedFileMeta: PersistedAttachmentMeta[];
}

function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    .replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
}

export function buildLocalAttachmentPromptSupplement(files: PersistedAttachmentMeta[], includeImages = false): string {
  const nonImageFiles = files.filter((file) => includeImages || !file.type.startsWith('image/'));
  if (nonImageFiles.length === 0) return '';

  const hasVideo = nonImageFiles.some((file) => file.type.startsWith('video/'));
  const lines = [
    '<local_attachments>',
    '  <instruction>附件已下载到本地。请使用本地工具读取；图片使用看图工具。</instruction>',
  ];

  if (hasVideo) {
    lines.push('  <instruction>视频先检查元信息，需要时再提取画面或音频。</instruction>');
  }

  for (const file of nonImageFiles) {
    lines.push(`  <file name="${escapeXmlAttribute(file.name)}" mime_type="${escapeXmlAttribute(file.type || 'application/octet-stream')}" size_bytes="${file.size}" path="${escapeXmlAttribute(file.filePath)}" />`);
  }
  lines.push('</local_attachments>');

  return lines.join('\n');
}

export function buildConversationPromptText(text: string, files: PersistedAttachmentMeta[] = [], includeImages = false): string {
  const attachmentSupplement = buildLocalAttachmentPromptSupplement(files, includeImages);
  if (!attachmentSupplement) return text;
  return text.trim() ? `${text}\n\n${attachmentSupplement}` : attachmentSupplement;
}

export function prepareMessageAttachments(params: {
  text: string;
  files?: FileAttachment[];
  workDir: string;
}): PreparedMessageAttachments {
  const { text, files, workDir } = params;
  if (!files || files.length === 0) {
    return {
      savedContent: text,
      llmFiles: files,
      persistedFileMeta: [],
    };
  }

  if (!workDir) {
    return {
      savedContent: `[${files.length} attachment(s) attached] ${text}`,
      llmFiles: files,
      persistedFileMeta: [],
    };
  }

  try {
    const uploadDir = path.join(workDir, '.codepilot-uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    const fileMeta = files.map((file) => {
      if (file.filePath && fs.existsSync(file.filePath)) {
        return { id: file.id, name: file.name, type: file.type, size: fs.statSync(file.filePath).size, filePath: file.filePath };
      }
      const safeName = path.basename(file.name).replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = path.join(uploadDir, `${crypto.randomUUID()}-${safeName}`);
      const buffer = Buffer.from(file.data, 'base64');
      fs.writeFileSync(filePath, buffer);
      return { id: file.id, name: file.name, type: file.type, size: buffer.length, filePath };
    });
    return {
      savedContent: `<!--files:${JSON.stringify(fileMeta)}-->${text}`,
      llmFiles: files.map((file) => {
        const persisted = fileMeta.find((item) => item.id === file.id);
        return persisted ? { ...file, size: persisted.size, filePath: persisted.filePath } : file;
      }),
      persistedFileMeta: fileMeta,
    };
  } catch (err) {
    console.warn('[local-attachments] Failed to persist file attachments:', err instanceof Error ? err.message : err);
    return {
      savedContent: `[${files.length} attachment(s) attached] ${text}`,
      llmFiles: files,
      persistedFileMeta: [],
    };
  }
}

/** Text-only transports retain images and files as explicit, readable local paths. */
export function prepareTextAttachmentPrompt(params: { prompt: string; files?: FileAttachment[]; workingDirectory?: string }): string {
  if (!params.files?.length) return params.prompt;
  const prepared = prepareMessageAttachments({ text: params.prompt, files: params.files, workDir: params.workingDirectory || process.cwd() });
  if (prepared.persistedFileMeta.length !== params.files.length) throw new Error('附件保存失败，消息尚未发送，请重试。');
  return buildConversationPromptText(params.prompt || '请查看用户发送的附件。', prepared.persistedFileMeta, true);
}
