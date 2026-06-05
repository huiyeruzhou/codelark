/**
 * Delivery Layer — reliable outbound message delivery with chunking,
 * dedup, retry, error classification, and reference tracking.
 */

import type {
  CloudDocumentAddress,
  OutboundMessage,
  SendResult,
} from '../../domain/index.js';
import { PLATFORM_LIMITS as limits } from '../../domain/index.js';
import type { BaseChannelAdapter } from '../contracts.js';
import { getBridgeContext } from '../../bridge/host/context.js';
import { ChatRateLimiter } from '../../shared/security/rate-limiter.js';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const JITTER_MAX_MS = 500;
/** Delay between sending multiple chunks to avoid rate limits. */
const INTER_CHUNK_DELAY_MS = 300;
const DISABLE_OUTBOUND_RATE_LIMIT_ENV = 'CODELARK_DISABLE_OUTBOUND_RATE_LIMIT';
const DEFAULT_OUTBOUND_RATE_LIMIT_MAX_MESSAGES = 30;
const DEFAULT_OUTBOUND_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_OUTBOUND_RATE_LIMIT_WARN_MS = 3_000;
const OUTBOUND_RATE_LIMIT_NOTICE_COOLDOWN_MS = 60_000;

/** Shared rate limiter instance for ordinary outbound messages. */
let rateLimiter = new ChatRateLimiter({
  maxMessages: DEFAULT_OUTBOUND_RATE_LIMIT_MAX_MESSAGES,
  windowMs: DEFAULT_OUTBOUND_RATE_LIMIT_WINDOW_MS,
});
const rateLimitNoticeLastSentAt = new Map<string, number>();

// Periodically clean up idle rate limiter buckets (every 5 minutes).
// unref() so the timer doesn't prevent Node.js process exit (e.g. in tests).
setInterval(() => { rateLimiter.cleanup(); }, 5 * 60_000).unref();

function isOutboundRateLimitDisabled(): boolean {
  return process.env[DISABLE_OUTBOUND_RATE_LIMIT_ENV] === '1';
}

function isInteractiveOutboundMessage(message: OutboundMessage): boolean {
  return Boolean(message.inlineButtons || message.richCard || message.richCardUpdateMessageId);
}

function deliveryKind(message: OutboundMessage, cloudDocument: boolean): string {
  if (cloudDocument) return 'cloud_document';
  if (message.inlineButtons) return 'permission';
  if (message.richCardUpdateMessageId) return 'rich_card_update';
  if (message.richCard) return 'rich_card';
  if (message.attachments?.length) return 'attachment';
  return 'response';
}

/**
 * Split text into chunks that fit within a platform's message size limit.
 * Tries to split at line boundaries when possible.
 */
function chunkText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline within the limit
    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx <= 0 || splitIdx < maxLength * 0.5) {
      splitIdx = maxLength;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }

  return chunks;
}

/**
 * Compute exponential backoff delay with jitter.
 */
function backoffDelay(attempt: number): number {
  const base = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * JITTER_MAX_MS;
  return base + jitter;
}

// ── Error classification ──────────────────────────────────────

type ErrorCategory = 'rate_limit' | 'server_error' | 'client_error' | 'parse_error' | 'network';

/**
 * Classify a SendResult failure into an error category.
 * Uses httpStatus when available, falls back to error string matching.
 */
function classifyError(result: SendResult): ErrorCategory {
  const status = (result as { httpStatus?: number }).httpStatus;
  const error = result.error ?? '';

  if (status === 429) return 'rate_limit';
  if (status && status >= 500) return 'server_error';
  if (status && status >= 400 && status < 500) {
    // Check for HTML parse errors even though they are 400
    if (/can't parse entities|parse entities|find end of the entity/i.test(error)) {
      return 'parse_error';
    }
    return 'client_error';
  }

  // No HTTP status — fall back to string matching
  if (/can't parse entities|parse entities|find end of the entity/i.test(error)) {
    return 'parse_error';
  }
  if (/too many requests|rate limit|retry.after/i.test(error)) {
    return 'rate_limit';
  }

  return 'network';
}

/**
 * Determine if a failed SendResult should be retried.
 */
function shouldRetry(category: ErrorCategory): boolean {
  switch (category) {
    case 'server_error':
    case 'network':
      return true;
    case 'rate_limit':
    case 'client_error':
    case 'parse_error':
      // Rate-limit errors are not retried here. Local delivery already has
      // per-chat shaping; retry-after sleeps block higher-priority cards and
      // can amplify congestion.
      return false;
  }
}

function formatDurationSeconds(ms: number): string {
  return `${Math.max(1, Math.ceil(ms / 1000))} 秒`;
}

async function sendRateLimitNotice(
  adapter: BaseChannelAdapter,
  message: OutboundMessage,
  waitMs: number,
  sessionId?: string,
): Promise<void> {
  const key = `${message.address.channelType}:${message.address.chatId}`;
  const now = Date.now();
  const lastSentAt = rateLimitNoticeLastSentAt.get(key) || 0;
  if (now - lastSentAt < OUTBOUND_RATE_LIMIT_NOTICE_COOLDOWN_MS) return;
  rateLimitNoticeLastSentAt.set(key, now);

  const sessionText = sessionId ? `会话：${sessionId}` : '';
  const result = await adapter.send({
    address: message.address,
    text: [
      `当前聊天普通消息发送过快，后续普通回复已进入发送队列，预计等待 ${formatDurationSeconds(waitMs)}。`,
      `确认卡、按钮和选择卡会优先发送，不会被这个普通消息队列阻塞。`,
      sessionText,
    ].filter(Boolean).join('\n'),
    parseMode: 'plain',
    replyToMessageId: message.replyToMessageId,
  });
  if (!result.ok) {
    console.warn('[delivery] Failed to send outbound rate-limit notice:', {
      channelType: message.address.channelType,
      chatId: message.address.chatId,
      sessionId: sessionId ?? null,
      error: result.error ?? null,
      httpStatus: result.httpStatus ?? null,
    });
  }
}

async function acquireOutboundRateLimit(
  adapter: BaseChannelAdapter,
  message: OutboundMessage,
  cloudDocument: boolean,
  chunkIndex: number,
  sessionId?: string,
): Promise<void> {
  if (isOutboundRateLimitDisabled()) return;
  if (!cloudDocument && isInteractiveOutboundMessage(message)) return;

  const estimatedWaitMs = rateLimiter.estimateWaitMs(message.address.chatId);
  if (estimatedWaitMs >= DEFAULT_OUTBOUND_RATE_LIMIT_WARN_MS) {
    console.warn('[delivery] Outbound rate limiter will delay message:', {
      channelType: message.address.channelType,
      chatId: message.address.chatId,
      sessionId: sessionId ?? null,
      kind: deliveryKind(message, cloudDocument),
      chunkIndex,
      estimatedWaitMs,
    });
    await sendRateLimitNotice(adapter, message, estimatedWaitMs, sessionId);
  }

  const startedAt = Date.now();
  const waitedMs = await rateLimiter.acquire(message.address.chatId);
  const elapsedMs = Math.max(waitedMs, Date.now() - startedAt);
  if (elapsedMs >= DEFAULT_OUTBOUND_RATE_LIMIT_WARN_MS) {
    console.warn('[delivery] Outbound rate limiter delayed message:', {
      channelType: message.address.channelType,
      chatId: message.address.chatId,
      sessionId: sessionId ?? null,
      kind: deliveryKind(message, cloudDocument),
      chunkIndex,
      waitMs: elapsedMs,
    });
  }
}

function logRemoteRateLimit(scope: string, result: SendResult): void {
  console.warn('[delivery] Remote rate-limit response; not retrying locally:', {
    scope,
    httpStatus: result.httpStatus ?? null,
    retryAfter: (result as { retryAfter?: number }).retryAfter ?? null,
    error: result.error ?? null,
  });
}

export function _testOnlyResetDeliveryRateLimiterForTests(options?: { maxMessages?: number; windowMs?: number }): void {
  rateLimiter = new ChatRateLimiter({
    maxMessages: options?.maxMessages ?? DEFAULT_OUTBOUND_RATE_LIMIT_MAX_MESSAGES,
    windowMs: options?.windowMs ?? DEFAULT_OUTBOUND_RATE_LIMIT_WINDOW_MS,
  });
  rateLimitNoticeLastSentAt.clear();
}

/**
 * Compute retry delay for retryable network/server failures.
 */
function retryDelay(result: SendResult, attempt: number): number {
  const retryAfter = (result as { retryAfter?: number }).retryAfter;
  if (retryAfter && retryAfter > 0) {
    // Retry hints are represented in seconds; add a small buffer.
    return retryAfter * 1000 + 200;
  }
  return backoffDelay(attempt);
}

function buildCloudDocumentReplyText(message: OutboundMessage): string {
  const parts = [message.text.trim()];
  const attachmentCount = message.attachments?.length || 0;
  if (attachmentCount > 0) {
    parts.push(`暂不支持在云文档评论中发送本地附件，已省略 ${attachmentCount} 个附件。`);
  }
  return parts.filter(Boolean).join('\n\n');
}

function logDeliverySend(params: {
  message: OutboundMessage;
  cloudDocument: boolean;
  chunkIndex: number;
  chunkCount: number;
  startedAt: number;
  result: SendResult;
  sessionId?: string;
}): void {
  const durationMs = Math.max(0, Date.now() - params.startedAt);
  const payloadBytes = Buffer.byteLength(params.message.text, 'utf8');
  const fields = {
    event: 'perf.delivery.send',
    duration_ms: durationMs,
    durationMs,
    channel: params.message.address.channelType,
    channelType: params.message.address.channelType,
    chat: params.message.address.chatId,
    chatId: params.message.address.chatId,
    kind: deliveryKind(params.message, params.cloudDocument),
    cloud_document: params.cloudDocument,
    cloudDocument: params.cloudDocument,
    chunk_index: params.chunkIndex,
    chunkIndex: params.chunkIndex,
    chunk_count: params.chunkCount,
    chunkCount: params.chunkCount,
    payload_bytes: payloadBytes,
    payloadBytes,
    status: params.result.ok ? 'success' : 'error',
    ok: params.result.ok,
    ...(params.sessionId ? { session: params.sessionId, sessionId: params.sessionId } : {}),
    ...(params.result.messageId ? { message_id: params.result.messageId, messageId: params.result.messageId } : {}),
    ...(params.result.httpStatus ? { http_status: params.result.httpStatus, httpStatus: params.result.httpStatus } : {}),
    ...(params.result.error ? { error: params.result.error } : {}),
  };
  if (params.result.ok) {
    console.log('[delivery] Delivery send:', fields);
  } else {
    console.warn('[delivery] Delivery send failed:', fields);
  }
}

// ── Public API ────────────────────────────────────────────────

/**
 * Send a message through an adapter with chunking, dedup, retry, and auditing.
 */
export async function deliver(
  adapter: BaseChannelAdapter,
  message: OutboundMessage,
  opts?: {
    sessionId?: string;
    dedupKey?: string;
    audit?: boolean;
  },
): Promise<SendResult> {
  const { store } = getBridgeContext();

  // Dedup check
  if (opts?.dedupKey) {
    if (store.checkDedup(opts.dedupKey)) {
      return { ok: true, messageId: undefined };
    }
  }

  // Periodically clean up expired dedup entries (1 in 100 chance)
  if (Math.random() < 0.01) {
    try { store.cleanupExpiredDedup(); } catch { /* best effort */ }
  }

  const cloudDocument = message.address.cloudDocument;
  const cloudDocumentReplyText = cloudDocument ? buildCloudDocumentReplyText(message) : '';
  if (cloudDocument && !adapter.sendCloudDocumentReply) {
    return { ok: false, error: 'Cloud document comment reply is not supported by this adapter' };
  }

  const limit = limits[adapter.provider] || limits[adapter.channelType] || 4096;
  const chunks = chunkText(cloudDocument ? cloudDocumentReplyText : message.text, limit);

  let lastMessageId: string | undefined;

  for (let i = 0; i < chunks.length; i++) {
    if (cloudDocument && !chunks[i].trim()) continue;

    const chunkMessage: OutboundMessage = {
      ...message,
      text: chunks[i],
      // Only attach inline buttons to the last chunk
      inlineButtons: i === chunks.length - 1 ? message.inlineButtons : undefined,
      richCard: i === chunks.length - 1 ? message.richCard : undefined,
      richCardUpdateMessageId: i === chunks.length - 1 ? message.richCardUpdateMessageId : undefined,
      // Pass through replyToMessageId for platforms that support threaded replies.
      replyToMessageId: message.replyToMessageId,
    };

    const sendStartedAt = Date.now();
    await acquireOutboundRateLimit(adapter, chunkMessage, Boolean(cloudDocument), i, opts?.sessionId);

    // Inter-chunk delay to avoid hitting rate limits on multi-chunk messages
    if (i > 0) {
      await new Promise(r => setTimeout(r, INTER_CHUNK_DELAY_MS));
    }

    const result = cloudDocument
      ? await sendCloudDocumentReplyWithRetry(adapter, cloudDocument, chunks[i])
      : await sendWithRetry(adapter, chunkMessage);
    logDeliverySend({
      message: chunkMessage,
      cloudDocument: Boolean(cloudDocument),
      chunkIndex: i,
      chunkCount: chunks.length,
      startedAt: sendStartedAt,
      result,
      sessionId: opts?.sessionId,
    });
    if (!result.ok) {
      return result;
    }
    lastMessageId = result.messageId;

    // Track outbound reference
    if (result.messageId && opts?.sessionId) {
      try {
        store.insertOutboundRef({
          channelType: adapter.channelType,
          chatId: message.address.chatId,
          bridgeSessionId: opts.sessionId,
          platformMessageId: result.messageId,
          purpose: message.inlineButtons && !cloudDocument ? 'permission' : 'response',
        });
      } catch { /* best effort */ }
    }
  }

  // Mark as delivered for dedup
  if (opts?.dedupKey) {
    try { store.insertDedup(opts.dedupKey); } catch { /* best effort */ }
  }

  if (opts?.audit !== false) {
    try {
      store.insertAuditLog({
        channelType: adapter.channelType,
        chatId: message.address.chatId,
        direction: 'outbound',
        messageId: lastMessageId || '',
        summary: (cloudDocument ? cloudDocumentReplyText : message.text).slice(0, 200),
      });
    } catch { /* best effort */ }
  }

  return { ok: true, messageId: lastMessageId };
}

async function sendCloudDocumentReplyWithRetry(
  adapter: BaseChannelAdapter,
  target: CloudDocumentAddress,
  text: string,
): Promise<SendResult> {
  if (!adapter.sendCloudDocumentReply) {
    return { ok: false, error: 'Cloud document comment reply is not supported by this adapter' };
  }

  let lastError: string | undefined;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const result = await adapter.sendCloudDocumentReply(target, text);
    if (result.ok) return result;

    lastError = result.error;
    const category = classifyError(result);
    if (category === 'rate_limit') {
      logRemoteRateLimit('cloud_document', result);
    }
    if (!shouldRetry(category)) {
      return result;
    }
    if (attempt < MAX_RETRIES - 1) {
      await new Promise(r => setTimeout(r, retryDelay(result, attempt)));
    }
  }

  return { ok: false, error: lastError || 'Max retries exceeded' };
}

/**
 * Send a single message with retry, error classification, and HTML fallback.
 */
async function sendWithRetry(
  adapter: BaseChannelAdapter,
  message: OutboundMessage,
  plainFallback?: string,
): Promise<SendResult> {
  let lastError: string | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const result = await adapter.send(message);
    if (result.ok) return result;

    lastError = result.error;
    const category = classifyError(result);
    if (category === 'rate_limit') {
      logRemoteRateLimit(deliveryKind(message, false), result);
    }

    // HTML parse error: immediately fallback to plain text (no retry needed)
    if (category === 'parse_error' && message.parseMode === 'HTML') {
      const fallbackText = plainFallback || message.text;
      const plainResult = await adapter.send({
        ...message,
        text: fallbackText,
        parseMode: 'plain',
      });
      if (plainResult.ok) return plainResult;
      lastError = plainResult.error;
      // If plain text also fails, classify that error and continue
      const plainCategory = classifyError(plainResult);
      if (plainCategory === 'rate_limit') {
        logRemoteRateLimit(`${deliveryKind(message, false)}:plain_fallback`, plainResult);
      }
      if (!shouldRetry(plainCategory)) {
        return plainResult;
      }
    }

    // Don't retry client errors or remote rate limits.
    if (!shouldRetry(category)) {
      return result;
    }

    // Wait before next retry.
    if (attempt < MAX_RETRIES - 1) {
      await new Promise(r => setTimeout(r, retryDelay(result, attempt)));
    }
  }

  return { ok: false, error: lastError || 'Max retries exceeded' };
}
