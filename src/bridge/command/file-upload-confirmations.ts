import path from 'node:path';

import type { ChannelAddress, OutboundAttachment, OutboundRichCard } from '../../domain/index.js';
import { buildCommandCallbackData } from './callbacks.js';

export const LARGE_FILE_UPLOAD_THRESHOLD_BYTES = 20 * 1024 * 1024;
export const LARGE_FILE_UPLOAD_CONFIRMATION_TTL_MS = 10 * 60 * 1000;

interface PendingLargeFileUpload {
  id: string;
  address: ChannelAddress;
  attachment: OutboundAttachment;
  size: number;
  createdAt: number;
  expiresAt: number;
  timeout: ReturnType<typeof setTimeout>;
}

const pendingLargeFileUploads = new Map<string, PendingLargeFileUpload>();

function uploadKey(address: ChannelAddress, id: string): string {
  return [
    address.channelType,
    address.chatId,
    id,
  ].join(':');
}

function pruneExpired(nowMs = Date.now()): void {
  for (const [key, pending] of pendingLargeFileUploads) {
    if (nowMs >= pending.expiresAt) {
      deletePendingLargeFileUpload(key);
    }
  }
}

function deletePendingLargeFileUpload(key: string): boolean {
  const pending = pendingLargeFileUploads.get(key);
  if (!pending) return false;
  clearTimeout(pending.timeout);
  return pendingLargeFileUploads.delete(key);
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} bytes`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb >= 10 ? 1 : 2)} MB`;
}

export function formatLargeFileUploadSize(bytes: number): string {
  return formatFileSize(bytes);
}

export function registerPendingLargeFileUpload(
  address: ChannelAddress,
  attachment: OutboundAttachment,
  size: number,
  nowMs = Date.now(),
): string {
  pruneExpired(nowMs);
  const id = `${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const key = uploadKey(address, id);
  const expiresAt = nowMs + LARGE_FILE_UPLOAD_CONFIRMATION_TTL_MS;
  const timeout = setTimeout(() => {
    pendingLargeFileUploads.delete(key);
  }, LARGE_FILE_UPLOAD_CONFIRMATION_TTL_MS);
  timeout.unref?.();
  pendingLargeFileUploads.set(key, {
    id,
    address,
    attachment,
    size,
    createdAt: nowMs,
    expiresAt,
    timeout,
  });
  return id;
}

export function consumePendingLargeFileUpload(
  address: ChannelAddress,
  id: string,
  nowMs = Date.now(),
): PendingLargeFileUpload | null {
  pruneExpired(nowMs);
  const key = uploadKey(address, id);
  const pending = pendingLargeFileUploads.get(key);
  if (!pending) return null;
  deletePendingLargeFileUpload(key);
  return pending;
}

export function clearPendingLargeFileUpload(address: ChannelAddress, id: string): boolean {
  return deletePendingLargeFileUpload(uploadKey(address, id));
}

export function buildLargeFileUploadConfirmationCard(options: {
  id: string;
  attachment: OutboundAttachment;
  size: number;
}): OutboundRichCard {
  const fileName = options.attachment.name || path.basename(options.attachment.path) || 'attachment.bin';
  const size = formatFileSize(options.size);
  return {
    title: '确认上传大文件',
    template: 'orange',
    sections: [
      {
        markdown: [
          `文件 **${fileName}** 大小为 **${size}**，超过 20 MB。`,
          '确认后 CodeLark 会在后台上传到飞书云空间，并把文件链接发回当前聊天。',
          '如果超时未确认或取消，将不会上传。',
        ].join('\n'),
      },
      {
        fields: [
          ['文件', fileName],
          ['大小', size],
        ],
      },
    ],
    actions: [[
      {
        text: '上传并发链接',
        type: 'primary',
        callbackData: buildCommandCallbackData(`/file --confirm-large ${options.id}`),
      },
      {
        text: '取消',
        callbackData: buildCommandCallbackData(`/file --cancel-large ${options.id}`),
      },
    ]],
  };
}

export const _testOnly = {
  clear(): void {
    for (const pending of pendingLargeFileUploads.values()) {
      clearTimeout(pending.timeout);
    }
    pendingLargeFileUploads.clear();
  },
  pendingCount(nowMs = Date.now()): number {
    pruneExpired(nowMs);
    return pendingLargeFileUploads.size;
  },
};
