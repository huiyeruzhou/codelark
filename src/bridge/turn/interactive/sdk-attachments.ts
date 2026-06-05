import fs from 'fs';
import path from 'path';

import type { FileAttachment } from '../../../domain/index.js';

export interface PersistedAttachmentMeta {
  id: string;
  name: string;
  type: string;
  size: number;
  filePath: string;
}

export interface PrepareSdkMessageAttachmentsResult {
  savedContent: string;
  llmFiles?: FileAttachment[];
  persistedFileMeta: PersistedAttachmentMeta[];
}

function formatAttachmentSize(size: number): string {
  if (!Number.isFinite(size) || size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function buildLocalAttachmentPromptSupplement(files: PersistedAttachmentMeta[]): string {
  const nonImageFiles = files.filter((file) => !file.type.startsWith('image/'));
  if (nonImageFiles.length === 0) return '';

  const hasVideo = nonImageFiles.some((file) => file.type.startsWith('video/'));
  const lines = [
    'Attached local files:',
    'The user included non-image attachments. They have already been downloaded locally.',
    'If they are relevant, inspect them directly from disk using the available local tools.',
  ];

  if (hasVideo) {
    lines.push('For video files, inspect metadata first and extract frames or audio only when needed.');
  }

  lines.push('');
  for (const [index, file] of nonImageFiles.entries()) {
    lines.push(
      `${index + 1}. ${file.name} (${file.type || 'application/octet-stream'}, ${formatAttachmentSize(file.size)})`,
    );
    lines.push(`   path: ${file.filePath}`);
  }

  return lines.join('\n');
}

export function buildConversationPromptText(text: string, files: PersistedAttachmentMeta[] = []): string {
  const attachmentSupplement = buildLocalAttachmentPromptSupplement(files);
  if (!attachmentSupplement) return text;
  return text.trim() ? `${text}\n\n${attachmentSupplement}` : attachmentSupplement;
}

export function prepareSdkMessageAttachments(params: {
  text: string;
  files?: FileAttachment[];
  workDir: string;
}): PrepareSdkMessageAttachmentsResult {
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
      const safeName = path.basename(file.name).replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = path.join(uploadDir, `${Date.now()}-${safeName}`);
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
    console.warn('[sdk-attachments] Failed to persist file attachments:', err instanceof Error ? err.message : err);
    return {
      savedContent: `[${files.length} attachment(s) attached] ${text}`,
      llmFiles: files,
      persistedFileMeta: [],
    };
  }
}
