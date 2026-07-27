import type { BaseChannelAdapter } from '../contracts.js';
import type { StructuredStreamingUiActionButton, StructuredStreamingUiMetadata } from '../contracts.js';
import type { StreamingHistoryItem, TaskProgressInfo, ToolCallInfo } from '../../domain/index.js';
import { renderFeedbackTextForChannel } from '../adapter-runtime/channel-runtime.js';

export interface StreamFeedbackTarget {
  adapter: BaseChannelAdapter;
  channelType: string;
  chatId: string;
  streamKey?: string;
  ensureStarted?(): void;
}

export async function resolveStructuredStreamingUiMessageId(
  target: Pick<StreamFeedbackTarget, 'adapter' | 'chatId' | 'streamKey'>,
): Promise<string | null> {
  try {
    if (typeof target.adapter.waitForStructuredStreamingUiMessageId === 'function') {
      return await target.adapter.waitForStructuredStreamingUiMessageId(target.chatId, target.streamKey);
    }
    return target.adapter.getStructuredStreamingUiMessageId?.(target.chatId, target.streamKey) || null;
  } catch {
    return target.adapter.getStructuredStreamingUiMessageId?.(target.chatId, target.streamKey) || null;
  }
}

export function pushStreamFeedbackText(
  target: StreamFeedbackTarget,
  text: string,
): void {
  if (typeof target.adapter.onStreamText !== 'function') return;
  target.ensureStarted?.();
  const rendered = renderFeedbackTextForChannel(target.channelType, text);
  if (!rendered) return;
  try {
    target.adapter.onStreamText(target.chatId, rendered, target.streamKey);
  } catch {
    // Streaming UI updates are best effort only.
  }
}

export function pushStreamFeedbackTools(
  target: StreamFeedbackTarget,
  tools: ToolCallInfo[],
): void {
  if (typeof target.adapter.onToolEvent !== 'function') return;
  target.ensureStarted?.();
  try {
    target.adapter.onToolEvent(target.chatId, tools, target.streamKey);
  } catch {
    // Streaming UI updates are best effort only.
  }
}

export function pushStreamFeedbackHistory(
  target: StreamFeedbackTarget,
  items: StreamingHistoryItem[],
): void {
  if (typeof target.adapter.onStreamHistory !== 'function') return;
  target.ensureStarted?.();
  try {
    target.adapter.onStreamHistory(target.chatId, items, target.streamKey);
  } catch {
    // Streaming UI updates are best effort only.
  }
}

export function pushStreamFeedbackTasks(
  target: StreamFeedbackTarget,
  tasks: TaskProgressInfo[],
): void {
  if (typeof target.adapter.onTaskEvent !== 'function') return;
  target.ensureStarted?.();
  try {
    target.adapter.onTaskEvent(target.chatId, tasks, target.streamKey);
  } catch {
    // Streaming UI updates are best effort only.
  }
}

export function pushStreamFeedbackStatus(
  target: StreamFeedbackTarget,
  text: string,
): boolean {
  if (typeof target.adapter.onStreamStatus !== 'function') return false;
  target.ensureStarted?.();
  const rendered = renderFeedbackTextForChannel(target.channelType, text);
  if (!rendered) return false;
  try {
    target.adapter.onStreamStatus(target.chatId, rendered, target.streamKey);
    return true;
  } catch {
    // Streaming UI updates are best effort only.
    return false;
  }
}

export function pushStreamFeedbackMetadata(
  target: StreamFeedbackTarget,
  metadata: StructuredStreamingUiMetadata,
): boolean {
  if (typeof target.adapter.onStreamMetadata !== 'function') return false;
  try {
    target.adapter.onStreamMetadata(target.chatId, metadata, target.streamKey);
    target.ensureStarted?.();
    return true;
  } catch {
    return false;
  }
}

export function pushStreamFeedbackActions(
  target: StreamFeedbackTarget,
  actions: StructuredStreamingUiActionButton[][],
): boolean {
  if (typeof target.adapter.onStreamActions !== 'function') return false;
  try {
    target.adapter.onStreamActions(target.chatId, actions, target.streamKey);
    target.ensureStarted?.();
    return true;
  } catch {
    return false;
  }
}

export async function finalizeStreamFeedback(
  target: StreamFeedbackTarget,
  status: 'completed' | 'interrupted' | 'error',
  text: string,
): Promise<boolean> {
  if (typeof target.adapter.onStreamEnd !== 'function') return false;
  const rendered = renderFeedbackTextForChannel(target.channelType, text);
  try {
    return await target.adapter.onStreamEnd(target.chatId, status, rendered, target.streamKey);
  } catch {
    return false;
  }
}
