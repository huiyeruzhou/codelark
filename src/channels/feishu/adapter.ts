/**
 * Feishu (Lark) Adapter — implements BaseChannelAdapter for Feishu Bot API.
 *
 * Uses the official @larksuiteoapi/node-sdk WSClient for real-time event
 * subscription and REST Client for message sending / resource downloading.
 * Routes messages through an internal async queue consumed by the bridge runtime.
 *
 * Rendering strategy (aligned with Openclaw):
 * - Code blocks / tables → interactive card (schema 2.0 markdown)
 * - Other text → post (msg_type: 'post') with md tag
 * - Permission prompts → interactive card with action buttons
 *
 * card.action.trigger events are handled via EventDispatcher (Openclaw pattern):
 * button clicks are converted to synthetic text messages and routed through
 * the normal /perm command processing pipeline.
 */

import crypto from 'crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import * as lark from '@larksuiteoapi/node-sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type {
  ChannelAddress,
  ChannelChatKind,
  ChannelType,
  CloudDocumentAddress,
  InboundMessage,
  OutboundAttachment,
  OutboundMessage,
  SendResult,
  StreamingHistoryItem,
  TaskProgressInfo,
} from '../../domain/index.js';
import type { FileAttachment } from '../../domain/index.js';
import type { ToolCallInfo } from '../../domain/index.js';
import type { FeishuChannelConfig } from '../../channels/types.js';
import {
  feishuSiteToApiBaseUrl,
  normalizeFeishuSite,
} from './site.js';
import groupAuthorizationImageDataUrl from './assets/group-authorization-image.js';
import {
  BaseChannelAdapter,
  registerAdapterFactory,
  type AdapterRuntimeInstance,
  type CreateGroupChatOptions,
  type CreatedGroupChat,
  type GroupChatInfo,
  type StructuredStreamingUiMetadata,
  type StructuredStreamingUiSnapshot,
} from '../contracts.js';
import { getBridgeContext } from '../../bridge/host/context.js';
import { createConfigService } from '../../configuration/service.js';
import {
  htmlToFeishuMarkdown,
  preprocessFeishuMarkdown,
  hasComplexMarkdown,
  buildCardContent,
  buildCardTitleHeader,
  buildRichCardContent,
  buildPostContent,
  buildStreamingTaskContent,
  buildStreamingTextContent,
  buildStreamingTextLayoutSignature,
  buildStreamingHistoryElements,
  buildToolProgressElements,
  buildStreamingHistoryElementsFromItems,
  buildCardActionElements,
  buildMetadataTagElements,
  buildFinalCardJson,
  buildPermissionButtonCard,
  formatElapsed,
  type FeishuCardActionButton,
} from './markdown.js';
import { buildFencedCodeBlock } from '../../shared/markdown/fence.js';

/** Max number of message_ids to keep for dedup. */
const DEDUP_MAX = 1000;

/** Max file download size (20 MB). */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/** Feishu emoji type for completed tasks. */
const COMPLETED_EMOJI = 'DONE';
const execFileAsync = promisify(execFile);
/** Feishu emoji type for failed tasks. */
const ERROR_EMOJI = 'WAIL';
export const FEISHU_GROUP_AUTHORIZED_CALLBACK_DATA = 'clk-feishu-group-authorized';
const FEISHU_GROUP_MESSAGE_SCOPE = 'im:message.group_msg';
const GROUP_AUTHORIZATION_IMAGE_FILE_NAME = 'codelark-group-authorization.png';

/** State for an active CardKit v2 streaming card. */
interface FeishuCardState {
  chatId: string;
  cardId: string;
  messageId: string;
  replyToMessageId?: string;
  sequence: number;
  continuationIndex: number;
  startTime: number;
  taskItems: TaskProgressInfo[];
  toolCalls: ToolCallInfo[];
  historyItems: StreamingHistoryItem[];
  historyItemOffset: number;
  toolCallOffset: number;
  historyDriven: boolean;
  thinking: boolean;
  pendingText: string | null;
  pendingTasksText: string | null;
  pendingStatusText: string | null;
  terminalContextUsageText: string;
  renderedText: string | null;
  renderedTextLayoutSignature: string;
  renderedTasksText: string | null;
  renderedHistoryElementIds: string[];
  renderedHistoryElementJson: Record<string, string>;
  renderedToolSnapshots: Record<string, string>;
  renderedToolEventCounts: Record<string, number>;
  renderedStatusText: string | null;
  renderedHistorySignature: string;
  actionRows: FeishuCardActionButton[][];
  renderedActionSignature: string;
  metadata: StructuredStreamingUiMetadata;
  renderedMetadataSignature: string;
  renderedComponentCount: number;
  desiredRevision: number;
  shadowRevision: number;
  shadowTrust: StreamingRemoteShadowTrust;
  lastUpdateAt: number;
  throttleTimer: ReturnType<typeof setTimeout> | null;
  flushInFlight: Promise<void> | null;
  backgroundFlushInFlight: Promise<void> | null;
  flushQueued: boolean;
  lastFlushStartedAt: number | null;
  nextFlushEarliestAt: number | null;
  lastSuccessfulFlushAt: number | null;
  lastFlushErrorAt: number | null;
  lastFlushError: string | null;
  consecutiveFlushFailures: number;
  lastFullRefreshAttemptAt: number;
  lastSuccessfulFullRefreshAt: number | null;
  perf: FeishuCardPerfStats;
}

type StreamingCardFlushCarry = Pick<FeishuCardState, 'flushInFlight' | 'backgroundFlushInFlight' | 'flushQueued' | 'lastFlushStartedAt'>;

interface FeishuCardApiPerfStats {
  count: number;
  timeoutCount: number;
  errorCount: number;
  totalMs: number;
  maxMs: number;
}

interface FeishuCardPerfStats {
  startedAt: number;
  createCardMs: number | null;
  sendMessageMs: number | null;
  initialPayloadBytes: number;
  initialComponentCount: number;
  flushAttempts: number;
  flushSuccesses: number;
  flushFailures: number;
  flushTimeouts: number;
  flushQueuedCount: number;
  noopCount: number;
  batchUpdateCount: number;
  fullRefreshCount: number;
  fullRefreshReasons: Record<string, number>;
  api: Record<string, FeishuCardApiPerfStats>;
  maxPayloadBytes: number;
  maxComponentCount: number;
  finalPayloadBytes: number | null;
  finalComponentCount: number | null;
  finalizeWaitMs: number | null;
  settingsMs: number | null;
  finalUpdateMs: number | null;
  backgroundFinalize: boolean;
}

interface StreamingHistoryRenderState {
  elementIds: string[];
  elementJson: Record<string, string>;
  elementsById: Record<string, Record<string, unknown>>;
}

interface StreamingHistoryAppendOperation {
  kind: 'content' | 'create' | 'patch';
  elementId: string;
  targetElementId?: string;
  element: Record<string, unknown>;
  elementJson: string;
  content?: string;
  partialElement?: Record<string, unknown>;
  snapshot?: string;
  eventCount?: number;
}

interface StreamingHistoryAppendPlan {
  operations: StreamingHistoryAppendOperation[];
  requiresFullRefresh: boolean;
}

type StreamingRemoteShadowTrust = 'trusted' | 'weak' | 'unknown';

interface StreamingDesiredSnapshot {
  revision: number;
  rawContent: string;
  content: string;
  contentLayoutSignature: string;
  tasksText: string;
  statusText: string;
  actionRows: FeishuCardActionButton[][];
  actionSignature: string;
  metadata: StructuredStreamingUiMetadata;
  metadataSignature: string;
}

interface StreamingDesiredRenderSnapshot {
  desired: StreamingDesiredSnapshot;
  render: StreamingCardRenderResult;
  history: StreamingHistoryRenderState;
  historySignature: string;
}

interface StreamingUpdateOperation {
  kind: 'content' | 'create' | 'patch';
  elementId: string;
  targetElementId?: string;
  content?: string;
  element?: Record<string, unknown>;
  elementJson?: string;
  partialElement?: Record<string, unknown>;
  snapshot?: string;
  eventCount?: number;
  onSuccess: () => void;
}

interface StreamingFullRefreshPlan {
  kind: 'fullRefresh';
  reason: string;
  snapshot: StreamingDesiredSnapshot;
  diagnostics: StreamingSyncPlanDiagnostics;
}

interface StreamingBatchUpdatePlan {
  kind: 'batchUpdate';
  reason: string;
  snapshot: StreamingDesiredSnapshot;
  actions: StreamingUpdateOperation[];
  desiredHistory: StreamingHistoryRenderState;
  historySignature: string;
  trustAfterSuccess: StreamingRemoteShadowTrust;
  diagnostics: StreamingSyncPlanDiagnostics;
}

interface StreamingNoopPlan {
  kind: 'noop';
  reason: string;
  snapshot: StreamingDesiredSnapshot;
  diagnostics: StreamingSyncPlanDiagnostics;
}

type StreamingSyncPlan = StreamingFullRefreshPlan | StreamingBatchUpdatePlan | StreamingNoopPlan;

interface StreamingSyncPlanDiagnostics {
  desiredComponentCount: number;
  directRefreshThreshold: number;
  incrementalActionCount: number;
  incrementalActionKinds: string[];
  incrementalElementIds: string[];
  containsUserTextUpdate: boolean;
  directRefreshRule?: 'small_card' | 'user_text';
}

interface StreamingCardRenderResult {
  body: Record<string, unknown>;
  componentCount: number;
  historyItemOffset: number;
  toolCallOffset: number;
  historyItems?: StreamingHistoryItem[];
  tools: ToolCallInfo[];
}

interface StreamingCardPayloadStats {
  payloadBytes: number;
  payloadChars: number;
  markdownCount: number;
}

interface StreamingCardRolloverOffsets {
  historyItemOffset: number;
  toolCallOffset: number;
  reason: string;
  componentCount?: number;
  payload?: StreamingCardPayloadStats;
}

interface StreamingCardInitialState {
  content: string;
  tasksText: string;
  statusText: string;
  taskItems: TaskProgressInfo[];
  toolCalls: ToolCallInfo[];
  historyItems: StreamingHistoryItem[];
  historyDriven: boolean;
  metadata: StructuredStreamingUiMetadata;
  actionRows: FeishuCardActionButton[][];
  terminalContextUsageText: string;
  historyItemOffset: number;
  toolCallOffset: number;
  continuationIndex: number;
  startTime: number;
}

interface PendingStreamingCardCreateState {
  text?: string;
  statusText?: string;
  tasks?: TaskProgressInfo[];
  tools?: ToolCallInfo[];
  historyItems?: StreamingHistoryItem[];
  historyDriven?: boolean;
}

interface RichCardUpdateState {
  cardId: string;
  messageId: string;
  lastInteractionAt: number;
  sequence: number;
}

/** Streaming card congestion control intervals (ms). */
const CARD_FLUSH_BASE_INTERVAL_MS = 2_000;
const CARD_FLUSH_FIRST_FAILURE_INTERVAL_MS = 5_000;
const CARD_FLUSH_MAX_FAILURE_INTERVAL_MS = 10_000;
const CARD_REQUEST_TIMEOUT_MS = 60_000;
const CARD_FINALIZE_FLUSH_WAIT_EXTRA_MS = 1_000;
const CARD_FINALIZE_BLOCKING_BUDGET_MS = 10_000;
const CARD_FULL_REFRESH_INTERVAL_MS = 5 * 60_000;
const CARD_SLOW_BATCH_REFRESH_THRESHOLD_MS = 5_000;
const STREAMING_CARD_COMPONENT_LIMIT = 160;
const STREAMING_CARD_DIRECT_REFRESH_COMPONENT_THRESHOLD = 20;
const STREAMING_CARD_PAYLOAD_BYTES_LIMIT = 18_000;
const STREAMING_CARD_PAYLOAD_CHARS_LIMIT = 18_000;
const STREAMING_CARD_MARKDOWN_COUNT_LIMIT = 150;
const RICH_CARD_DEFAULT_UPDATE_TTL_MS = 60_000;
const INITIAL_STREAMING_STATUS = '处理中';
const EMPTY_STREAMING_TASKS = '';
const CARD_LOG_PREVIEW_MAX = 240;

type EnvLike = Record<string, string | undefined>;
type FeishuProxyTarget = {
  url: string;
  label: 'REST' | 'WS';
};
type FeishuWsClientOptions = {
  appId: string;
  appSecret: string;
  domain: string | lark.Domain;
  httpInstance?: lark.HttpInstance;
  agent?: unknown;
};

type FeishuResourceInfo = {
  fileKey: string | null;
  name?: string;
};

function normalizeFeishuChatKind(value: unknown): ChannelChatKind | null {
  if (value === 'p2p') return 'p2p';
  if (value === 'group' || value === 'topic') return 'group';
  return null;
}

function isFeishuChatMissingResponse(response: { code?: number; msg?: string }): boolean {
  const detail = `${response.code ?? ''} ${response.msg ?? ''}`.toLowerCase();
  return [
    'chat not found',
    'chat_id not found',
    'chat id not found',
    'chat does not exist',
    'chat_id does not exist',
    'chat id does not exist',
    'chat not exist',
    'chat_id not exist',
    'invalid chat_id',
    'invalid chat id',
    'chat disband',
    'chat has been disband',
    'bot removed',
    'bot has been removed',
    'bot is not in',
    'bot not in',
    'not in the chat',
    'not in chat',
  ].some((pattern) => detail.includes(pattern));
}

function sanitizeInboundResourceName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const basename = trimmed.replace(/\\/g, '/').split('/').filter(Boolean).pop() || trimmed;
  const cleaned = basename.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned || undefined;
}

function extractFeishuResourceInfo(content: string): FeishuResourceInfo {
  try {
    const parsed = JSON.parse(content);
    return {
      fileKey: parsed.image_key || parsed.file_key || parsed.imageKey || parsed.fileKey || null,
      name: sanitizeInboundResourceName(
        parsed.file_name
        || parsed.fileName
        || parsed.filename
        || parsed.name
        || parsed.file?.name
        || parsed.file?.file_name
        || parsed.file?.fileName,
      ),
    };
  } catch {
    return { fileKey: null };
  }
}

function firstEnvValue(env: EnvLike, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function findFeishuChatIdInJson(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFeishuChatIdInJson(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['chat_id', 'chatId']) {
    if (typeof record[key] === 'string' && record[key].startsWith('oc_')) {
      return record[key];
    }
  }
  for (const item of Object.values(record)) {
    const found = findFeishuChatIdInJson(item);
    if (found) return found;
  }
  return undefined;
}

function noProxyTokenMatchesHost(token: string, host: string, port?: string): boolean {
  const normalizedToken = token.trim().toLowerCase().replace(/^\*\./, '').replace(/^\./, '');
  if (!normalizedToken) return false;
  if (normalizedToken === '*') return true;

  const [tokenHost, tokenPort] = normalizedToken.split(':');
  if (tokenPort && tokenPort !== port) return false;

  const normalizedHost = host.toLowerCase();
  return normalizedHost === tokenHost || normalizedHost.endsWith(`.${tokenHost}`);
}

function shouldBypassProxy(targetUrl: string, env: EnvLike = process.env): boolean {
  const raw = firstEnvValue(env, ['NO_PROXY', 'no_proxy']);
  if (!raw) return false;

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }

  const tokens = raw.split(',').map((token) => token.trim()).filter(Boolean);
  return tokens.some((token) => noProxyTokenMatchesHost(token, parsed.hostname, parsed.port));
}

function feishuApiBaseUrl(site: 'feishu' | 'lark'): string {
  return site === 'lark'
    ? 'https://open.larksuite.com'
    : 'https://open.feishu.cn';
}

function feishuWsBaseUrl(site: 'feishu' | 'lark'): string {
  return site === 'lark'
    ? 'wss://pbbot-ws.larksuite.com'
    : 'wss://pbbot-ws.feishu.cn';
}

function createWsClient(options: ConstructorParameters<typeof lark.WSClient>[0]): lark.WSClient {
  const originalSetInterval = globalThis.setInterval;
  const unrefingSetInterval = ((handler: Parameters<typeof originalSetInterval>[0], timeout?: Parameters<typeof originalSetInterval>[1], ...args: any[]) => {
    const timer = originalSetInterval(handler, timeout, ...args);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  }) as typeof originalSetInterval;

  globalThis.setInterval = unrefingSetInterval;
  try {
    return new lark.WSClient(options);
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
}

function feishuProxyTargets(site: 'feishu' | 'lark'): FeishuProxyTarget[] {
  return [
    { label: 'REST', url: feishuApiBaseUrl(site) },
    { label: 'WS', url: feishuWsBaseUrl(site) },
  ];
}

function getProxyUrlForUrl(targetUrl: string, env: EnvLike = process.env): string | undefined {
  if (shouldBypassProxy(targetUrl, env)) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return undefined;
  }

  const protocol = parsed.protocol.toLowerCase();
  const keys = protocol === 'ws:'
    ? ['WS_PROXY', 'ws_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
    : protocol === 'wss:'
      ? ['WSS_PROXY', 'wss_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']
      : protocol === 'http:'
        ? ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
        : ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'];

  const proxyUrl = firstEnvValue(env, keys);
  if (!proxyUrl) return undefined;

  try {
    new URL(proxyUrl);
    return proxyUrl;
  } catch {
    console.warn('[feishu-adapter] Ignoring invalid proxy URL');
    return undefined;
  }
}

function getWsProxyUrl(site: 'feishu' | 'lark', env: EnvLike = process.env): string | undefined {
  return getProxyUrlForUrl(feishuWsBaseUrl(site), env);
}

function maskProxyUrl(proxyUrl: string): string {
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<invalid-proxy-url>';
  }
}

function createProxyAgent(proxyUrl: string): HttpsProxyAgent<string> {
  return new HttpsProxyAgent(proxyUrl);
}

function withHttpProxyOptions<D>(
  options: lark.HttpRequestOptions<D>,
  site: 'feishu' | 'lark',
  env: EnvLike,
): lark.HttpRequestOptions<D> {
  const targetUrl = options.url?.startsWith('http')
    ? options.url
    : `${feishuApiBaseUrl(site)}${options.url?.startsWith('/') ? '' : '/'}${options.url || ''}`;
  const proxyUrl = getProxyUrlForUrl(targetUrl, env);

  if (!proxyUrl) return options;

  const agent = createProxyAgent(proxyUrl);
  return {
    ...options,
    // Axios otherwise applies its own env proxy resolution on top of the agent.
    proxy: false,
    httpAgent: agent,
    httpsAgent: agent,
  } as lark.HttpRequestOptions<D>;
}

function buildHttpInstanceWithEnvProxy(
  site: 'feishu' | 'lark',
  env: EnvLike = process.env,
  baseHttpInstance: lark.HttpInstance = lark.defaultHttpInstance,
): lark.HttpInstance {
  const withProxy = <D>(options: lark.HttpRequestOptions<D>): lark.HttpRequestOptions<D> =>
    withHttpProxyOptions(options, site, env);

  return {
    request: (options: lark.HttpRequestOptions<unknown>) =>
      baseHttpInstance.request(withProxy(options)),
    get: (url: string, options: lark.HttpRequestOptions<unknown> = {}) =>
      baseHttpInstance.get(url, withProxy({ ...options, url, method: options.method || 'GET' })),
    delete: (url: string, options: lark.HttpRequestOptions<unknown> = {}) =>
      baseHttpInstance.delete(url, withProxy({ ...options, url, method: options.method || 'DELETE' })),
    head: (url: string, options: lark.HttpRequestOptions<unknown> = {}) =>
      baseHttpInstance.head(url, withProxy({ ...options, url, method: options.method || 'HEAD' })),
    options: (url: string, options: lark.HttpRequestOptions<unknown> = {}) =>
      baseHttpInstance.options(url, withProxy({ ...options, url, method: options.method || 'OPTIONS' })),
    post: (url: string, data?: unknown, options: lark.HttpRequestOptions<unknown> = {}) =>
      baseHttpInstance.post(url, data, withProxy({ ...options, url, data, method: options.method || 'POST' })),
    put: (url: string, data?: unknown, options: lark.HttpRequestOptions<unknown> = {}) =>
      baseHttpInstance.put(url, data, withProxy({ ...options, url, data, method: options.method || 'PUT' })),
    patch: (url: string, data?: unknown, options: lark.HttpRequestOptions<unknown> = {}) =>
      baseHttpInstance.patch(url, data, withProxy({ ...options, url, data, method: options.method || 'PATCH' })),
  } as lark.HttpInstance;
}

function buildWsClientOptions(
  appId: string,
  appSecret: string,
  domain: string | lark.Domain,
  site: 'feishu' | 'lark',
  env: EnvLike = process.env,
  httpInstance?: lark.HttpInstance,
): FeishuWsClientOptions {
  const options: FeishuWsClientOptions = {
    appId,
    appSecret,
    domain,
    httpInstance,
  };

  const proxyUrl = getWsProxyUrl(site, env);
  if (proxyUrl) {
    options.agent = new HttpsProxyAgent(proxyUrl);
  }

  return options;
}

function describeEnabledProxies(site: 'feishu' | 'lark', env: EnvLike = process.env): string[] {
  const descriptions: string[] = [];
  for (const target of feishuProxyTargets(site)) {
    const proxyUrl = getProxyUrlForUrl(target.url, env);
    if (proxyUrl) descriptions.push(`${target.label}=${maskProxyUrl(proxyUrl)}`);
  }
  return descriptions;
}

function truncateForCardLog(value: string, max = CARD_LOG_PREVIEW_MAX): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function shortHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function summarizeTextForCardLog(value: string): Record<string, unknown> {
  return {
    chars: value.length,
    bytes: Buffer.byteLength(value, 'utf8'),
    lines: value ? value.split(/\r\n|\r|\n/).length : 0,
    sha256: shortHash(value),
    preview: truncateForCardLog(value),
  };
}

function collectCardJsonDiagnostics(value: unknown, stats: {
  elementIds: string[];
  names: string[];
  markdownPreviews: Array<{ elementId?: string; preview: string }>;
  callbackCount: number;
  markdownCount: number;
  buttonCount: number;
  formSubmitButtonCount: number;
}): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectCardJsonDiagnostics(item, stats);
    return;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.element_id === 'string') stats.elementIds.push(record.element_id);
  if (typeof record.name === 'string') stats.names.push(record.name);
  if (record.tag === 'markdown') {
    stats.markdownCount += 1;
    if (typeof record.content === 'string' && stats.markdownPreviews.length < 6) {
      stats.markdownPreviews.push({
        elementId: typeof record.element_id === 'string' ? record.element_id : undefined,
        preview: truncateForCardLog(record.content, 100),
      });
    }
  }
  if (record.tag === 'button') stats.buttonCount += 1;
  if (record.tag === 'button' && record.form_action_type === 'submit') stats.formSubmitButtonCount += 1;
  if (typeof record.callback_data === 'string') stats.callbackCount += 1;
  for (const child of Object.values(record)) collectCardJsonDiagnostics(child, stats);
}

function summarizeCardJsonForLog(cardJson: string): Record<string, unknown> {
  const summary: Record<string, unknown> = summarizeTextForCardLog(cardJson);
  try {
    const parsed = JSON.parse(cardJson) as unknown;
    const stats = {
      elementIds: [] as string[],
      names: [] as string[],
      markdownPreviews: [] as Array<{ elementId?: string; preview: string }>,
      callbackCount: 0,
      markdownCount: 0,
      buttonCount: 0,
      formSubmitButtonCount: 0,
    };
    collectCardJsonDiagnostics(parsed, stats);
    summary.elementIds = [...new Set(stats.elementIds)];
    summary.names = [...new Set(stats.names)];
    summary.markdownPreviews = stats.markdownPreviews;
    summary.markdownCount = stats.markdownCount;
    summary.buttonCount = stats.buttonCount;
    summary.callbackCount = stats.callbackCount;
    summary.formSubmitButtonCount = stats.formSubmitButtonCount;
  } catch (err) {
    summary.parseError = err instanceof Error ? err.message : String(err);
  }
  return summary;
}

function createFeishuCardPerfStats(params: {
  now: number;
  createCardMs?: number | null;
  sendMessageMs?: number | null;
  initialPayloadBytes: number;
  initialComponentCount: number;
}): FeishuCardPerfStats {
  return {
    startedAt: params.now,
    createCardMs: params.createCardMs ?? null,
    sendMessageMs: params.sendMessageMs ?? null,
    initialPayloadBytes: params.initialPayloadBytes,
    initialComponentCount: params.initialComponentCount,
    flushAttempts: 0,
    flushSuccesses: 0,
    flushFailures: 0,
    flushTimeouts: 0,
    flushQueuedCount: 0,
    noopCount: 0,
    batchUpdateCount: 0,
    fullRefreshCount: 0,
    fullRefreshReasons: {},
    api: {},
    maxPayloadBytes: params.initialPayloadBytes,
    maxComponentCount: params.initialComponentCount,
    finalPayloadBytes: null,
    finalComponentCount: null,
    finalizeWaitMs: null,
    settingsMs: null,
    finalUpdateMs: null,
    backgroundFinalize: false,
  };
}

function recordFeishuCardApiPerf(
  perf: FeishuCardPerfStats,
  target: string,
  durationMs: number,
  phase: 'success' | 'timeout' | 'error',
): void {
  const stats = perf.api[target] || {
    count: 0,
    timeoutCount: 0,
    errorCount: 0,
    totalMs: 0,
    maxMs: 0,
  };
  stats.count += 1;
  stats.totalMs += durationMs;
  stats.maxMs = Math.max(stats.maxMs, durationMs);
  if (phase === 'timeout') {
    stats.timeoutCount += 1;
    perf.flushTimeouts += 1;
  } else if (phase === 'error') {
    stats.errorCount += 1;
  }
  perf.api[target] = stats;
}

function recordFeishuCardPayloadPerf(
  perf: FeishuCardPerfStats,
  payloadBytes: number,
  componentCount: number,
): void {
  perf.maxPayloadBytes = Math.max(perf.maxPayloadBytes, payloadBytes);
  perf.maxComponentCount = Math.max(perf.maxComponentCount, componentCount);
}

function summarizeFeishuCardPerfApi(perf: FeishuCardPerfStats): Array<FeishuCardApiPerfStats & { target: string; avgMs: number }> {
  return Object.entries(perf.api)
    .map(([target, stats]) => ({
      target,
      ...stats,
      avgMs: stats.count > 0 ? Math.round(stats.totalMs / stats.count) : 0,
    }))
    .sort((left, right) => right.totalMs - left.totalMs)
    .slice(0, 12);
}

const REAL_E2E_STREAM_CARD_CHECKPOINT_ENV = 'CODELARK_REAL_FEISHU_E2E_STREAM_CARD_CHECKPOINTS';
const REAL_E2E_STREAM_CARD_CHECKPOINT_PREFIX = '[real-feishu-e2e:stream-card-checkpoint] ';
const LOG_FEISHU_REQUEST_START_ENV = 'CODELARK_LOG_FEISHU_REQUEST_START';

function collectCardJsonMarkdownTexts(value: unknown, texts: string[] = []): string[] {
  if (!value || typeof value !== 'object') return texts;
  if (Array.isArray(value)) {
    for (const item of value) collectCardJsonMarkdownTexts(item, texts);
    return texts;
  }
  const record = value as Record<string, unknown>;
  if (record.tag === 'markdown' && typeof record.content === 'string') {
    texts.push(record.content);
  }
  for (const child of Object.values(record)) collectCardJsonMarkdownTexts(child, texts);
  return texts;
}

function emitRealE2eStreamCardCheckpoint(params: {
  kind: 'create' | 'refresh' | 'element' | 'final';
  streamKey: string;
  chatId?: string;
  cardId?: string;
  elementId?: string;
  status?: string;
  sequence?: number;
  cardJson?: string;
  markdownTexts?: string[];
}): void {
  if (process.env[REAL_E2E_STREAM_CARD_CHECKPOINT_ENV] !== '1') return;
  try {
    const parsed = params.cardJson ? JSON.parse(params.cardJson) as unknown : null;
    const markdownTexts = (params.markdownTexts || (parsed ? collectCardJsonMarkdownTexts(parsed) : []))
      .map((text) => truncateForCardLog(text, 1000));
    const cardSummary = params.cardJson ? summarizeCardJsonForLog(params.cardJson) : {};
    console.log(`${REAL_E2E_STREAM_CARD_CHECKPOINT_PREFIX}${JSON.stringify({
      kind: params.kind,
      streamKey: params.streamKey,
      ...(params.chatId ? { chatId: params.chatId } : {}),
      ...(params.cardId ? { cardId: params.cardId } : {}),
      ...(params.elementId ? { elementId: params.elementId } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(typeof params.sequence === 'number' ? { sequence: params.sequence } : {}),
      ...cardSummary,
      markdownTexts,
    })}`);
  } catch (err) {
    console.warn('[feishu-adapter] Failed to emit real E2E stream card checkpoint:', err instanceof Error ? err.message : err);
  }
}

function summarizeFeishuResponseForLog(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  const parts: string[] = [];

  if (typeof record.code !== 'undefined') parts.push(`code=${String(record.code)}`);
  if (typeof record.msg !== 'undefined') parts.push(`msg=${truncateForCardLog(String(record.msg), 120)}`);
  if (typeof record.request_id !== 'undefined') parts.push(`request_id=${String(record.request_id)}`);

  const data = record.data;
  if (data && typeof data === 'object') {
    const dataRecord = data as Record<string, unknown>;
    for (const key of ['message_id', 'card_id', 'reaction_id', 'image_key', 'file_key']) {
      if (typeof dataRecord[key] !== 'undefined') parts.push(`${key}=${String(dataRecord[key])}`);
    }
  }

  return parts.length > 0 ? parts.join(', ') : undefined;
}

function summarizeFeishuResponseFields(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object') return {};
  const record = result as Record<string, unknown>;
  const fields: Record<string, unknown> = {};

  if (typeof record.code !== 'undefined') fields.code = record.code;
  if (typeof record.msg !== 'undefined') fields.response_msg = truncateForCardLog(String(record.msg), 120);
  if (typeof record.request_id !== 'undefined') fields.request_id = String(record.request_id);

  const data = record.data;
  if (data && typeof data === 'object') {
    const dataRecord = data as Record<string, unknown>;
    for (const key of ['message_id', 'card_id', 'reaction_id', 'image_key', 'file_key']) {
      if (typeof dataRecord[key] !== 'undefined') fields[key] = String(dataRecord[key]);
    }
  }

  return fields;
}

function feishuApiErrorFromResponse(result: unknown, target: string): Error | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  if (typeof record.code === 'undefined' || record.code === 0) return null;
  const msg = typeof record.msg === 'string' && record.msg.trim() ? `, msg=${record.msg.trim()}` : '';
  return new Error(`Feishu API error for ${target}: code=${String(record.code)}${msg}`);
}

function assertFeishuApiOk(result: unknown, target: string): void {
  const error = feishuApiErrorFromResponse(result, target);
  if (error) throw error;
}

function isFeishuCardElementLimitError(error: unknown): boolean {
  const code = error && typeof error === 'object'
    ? (error as Record<string, unknown>).code
    : undefined;
  if (code === 300305 || code === 300315 || code === '300305' || code === '300315') {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error || '');
  return /(?:code=|code:\s*)3003(?:05|15)\b/.test(message)
    || /\belement exceeds the limit\b/i.test(message);
}

function isFeishuCardPayloadLimitError(error: unknown): boolean {
  const code = error && typeof error === 'object'
    ? (error as Record<string, unknown>).code
    : undefined;
  if (code === 200850 || code === '200850') return true;
  const message = error instanceof Error ? error.message : String(error || '');
  return /(?:code=|code:\s*)200850\b/.test(message);
}

function countCardMarkdownElements(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) {
    return value.reduce<number>((count, item) => count + countCardMarkdownElements(item), 0);
  }
  const record = value as Record<string, unknown>;
  const selfCount = record.tag === 'markdown' ? 1 : 0;
  return Object.values(record).reduce<number>((count, child) => count + countCardMarkdownElements(child), selfCount);
}

function measureStreamingCardPayload(body: Record<string, unknown>): StreamingCardPayloadStats {
  const json = JSON.stringify(body);
  return {
    payloadBytes: Buffer.byteLength(json, 'utf8'),
    payloadChars: json.length,
    markdownCount: countCardMarkdownElements(body),
  };
}

function describeStreamingCardPayloadPressure(payload: StreamingCardPayloadStats): string | null {
  if (payload.payloadBytes >= STREAMING_CARD_PAYLOAD_BYTES_LIMIT) return 'payload_bytes';
  if (payload.payloadChars >= STREAMING_CARD_PAYLOAD_CHARS_LIMIT) return 'payload_chars';
  if (payload.markdownCount >= STREAMING_CARD_MARKDOWN_COUNT_LIMIT) return 'markdown_count';
  return null;
}

function buildStreamingCardBody(
  content: string,
  tasksText: string,
  statusText: string,
  tools: ToolCallInfo[] = [],
  actionRows: FeishuCardActionButton[][] = [],
  chatId?: string,
  metadata: StructuredStreamingUiMetadata = {},
  historyItems?: StreamingHistoryItem[],
): Record<string, unknown> {
  const normalizedMetadata = normalizeStreamMetadata(metadata);
  const elements: Array<Record<string, unknown>> = [];
  elements.push(...buildMetadataTagElements(normalizedMetadata));
  elements.push(
    ...(historyItems
      ? buildStreamingHistoryElementsFromItems(content, historyItems, 'streaming_content')
      : buildStreamingRunningHistoryElements(content, tools, 'streaming_content')),
    {
      tag: 'markdown',
      content: tasksText,
      text_align: 'left',
      text_size: 'normal',
      element_id: 'streaming_tasks',
    },
    {
      tag: 'markdown',
      content: statusText,
      text_align: 'left',
      text_size: 'notation',
      element_id: 'streaming_status',
    },
  );
  const actionElements = buildCardActionElements(actionRows, chatId);
  if (actionElements.length > 0) {
    elements.push({ tag: 'hr' }, ...actionElements);
  }

  const header = buildCardTitleHeader(normalizedMetadata, { tagElementPrefix: 'streaming_tag' });
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      wide_screen_mode: true,
      summary: { content: '思考中...' },
    },
    ...(header ? { header } : {}),
    body: {
      elements,
    },
  };
}

function countFeishuCardComponents(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + countFeishuCardComponents(item), 0);
  }
  const record = value as Record<string, unknown>;
  let count = typeof record.tag === 'string' && record.tag.trim() ? 1 : 0;
  for (const child of Object.values(record)) {
    count += countFeishuCardComponents(child);
  }
  return count;
}

function countStreamingUpdateComponentDelta(update: { kind: 'content' | 'create' | 'patch'; element?: Record<string, unknown> }): number {
  return update.kind === 'create' && update.element ? countFeishuCardComponents(update.element) : 0;
}

function buildStreamingCardRender(params: {
  content: string;
  tasksText: string;
  statusText: string;
  tools: ToolCallInfo[];
  actionRows: FeishuCardActionButton[][];
  chatId?: string;
  metadata?: StructuredStreamingUiMetadata;
  historyItems?: StreamingHistoryItem[];
  historyItemOffset?: number;
  toolCallOffset?: number;
  maxComponents?: number;
}): StreamingCardRenderResult {
  let historyItemOffset = Math.max(0, params.historyItemOffset || 0);
  let toolCallOffset = Math.max(0, params.toolCallOffset || 0);
  const maxComponents = Math.max(1, params.maxComponents || STREAMING_CARD_COMPONENT_LIMIT);

  while (true) {
    const visibleHistoryItems = params.historyItems
      ? params.historyItems.slice(historyItemOffset)
      : undefined;
    const visibleTools = params.tools.slice(toolCallOffset);
    const body = buildStreamingCardBody(
      params.content,
      params.tasksText,
      params.statusText,
      visibleTools,
      params.actionRows,
      params.chatId,
      params.metadata,
      visibleHistoryItems,
    );
    const componentCount = countFeishuCardComponents(body);
    if (componentCount <= maxComponents) {
      return {
        body,
        componentCount,
        historyItemOffset,
        toolCallOffset,
        historyItems: visibleHistoryItems,
        tools: visibleTools,
      };
    }

    if (params.historyItems && historyItemOffset < Math.max(0, params.historyItems.length - 1)) {
      historyItemOffset += 1;
      continue;
    }
    if (!params.historyItems && toolCallOffset < params.tools.length) {
      toolCallOffset += 1;
      continue;
    }

    return {
      body,
      componentCount,
      historyItemOffset,
      toolCallOffset,
      historyItems: visibleHistoryItems,
      tools: visibleTools,
    };
  }
}

function extractTerminalContextUsage(statusText: string | null | undefined): string {
  const text = (statusText || '').trim();
  if (!text) return '';
  const pattern = /(?:^|[，,\n])\s*((?:\d+(?:\.\d+)?k\(\d+%\))(?:\s*·\s*)?(?:[↑↓]\d+(?:\.\d+)?k(?:\s+[↑↓]\d+(?:\.\d+)?k)?)?|(?:[↑↓]\d+(?:\.\d+)?k(?:\s+[↑↓]\d+(?:\.\d+)?k)?))(?=$|[，,\n])/g;
  const matches = [...text.matchAll(pattern)];
  return matches.at(-1)?.[1]?.trim() || '';
}

function resolveTerminalContextUsage(state: Pick<FeishuCardState, 'terminalContextUsageText' | 'pendingStatusText'>): string {
  return state.terminalContextUsageText || extractTerminalContextUsage(state.pendingStatusText);
}

function toolSnapshotSignature(tool: ToolCallInfo): string {
  return JSON.stringify(tool);
}

function collectMarkdownContents(element: Record<string, unknown>): string[] {
  const contents: string[] = [];
  if (element.tag === 'markdown' && typeof element.content === 'string' && element.content.trim()) {
    contents.push(element.content.trim());
  }
  const children = Array.isArray(element.elements) ? element.elements as Array<Record<string, unknown>> : [];
  for (const child of children) {
    contents.push(...collectMarkdownContents(child));
  }
  return contents;
}

function buildStreamingToolEventPanelElement(
  panel: Record<string, unknown>,
  elementId: string,
  eventIndex: number,
): Record<string, unknown> {
  const header = panel.header as { title?: { content?: unknown } } | undefined;
  const title = typeof header?.title?.content === 'string' ? header.title.content : `工具 ${eventIndex}`;
  const details = collectMarkdownContents(panel).join('\n\n').trim();
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'markdown', content: title },
    },
    border: { color: 'grey', corner_radius: '5px' },
    elements: [{
      tag: 'markdown',
      content: preprocessFeishuMarkdown(details || '工具状态已更新。'),
      text_align: 'left',
      text_size: 'notation',
    }],
    element_id: `${elementId}_e${eventIndex}`,
  };
}

function buildStreamingToolPaneElement(
  panel: Record<string, unknown>,
  elementId: string,
): Record<string, unknown> {
  return {
    ...panel,
    elements: [buildStreamingToolEventPanelElement(panel, elementId, 1)],
    element_id: elementId,
  };
}

function buildStreamingToolPaneElements(tools: ToolCallInfo[]): Array<Record<string, unknown>> {
  return buildToolProgressElements(tools, { maxItems: null }).map((panel, index) =>
    buildStreamingToolPaneElement(panel, `stream_tool_${index + 1}`));
}

function buildRenderedToolSnapshots(tools: ToolCallInfo[]): Record<string, string> {
  const snapshots: Record<string, string> = {};
  tools.forEach((tool, index) => {
    snapshots[`stream_tool_${index + 1}`] = toolSnapshotSignature(tool);
  });
  return snapshots;
}

function buildRenderedToolEventCounts(tools: ToolCallInfo[]): Record<string, number> {
  const eventCounts: Record<string, number> = {};
  tools.forEach((_tool, index) => {
    eventCounts[`stream_tool_${index + 1}`] = 1;
  });
  return eventCounts;
}

function visibleStreamingHistoryItems(state: FeishuCardState): StreamingHistoryItem[] | undefined {
  return state.historyDriven ? state.historyItems.slice(state.historyItemOffset) : undefined;
}

function visibleStreamingToolCalls(state: FeishuCardState): ToolCallInfo[] {
  return state.toolCalls.slice(state.toolCallOffset);
}

function buildStreamingRunningHistoryElements(
  content: string,
  tools: ToolCallInfo[] = [],
  elementId = 'streaming_content',
): Array<Record<string, unknown>> {
  const elements = buildStreamingHistoryElements(content, [], elementId);
  const historyPanel = elements.find((element) => element.element_id === 'stream_history');
  if (historyPanel) {
    const historyChildren = Array.isArray(historyPanel.elements)
      ? historyPanel.elements as Array<Record<string, unknown>>
      : [];
    historyPanel.elements = [...historyChildren, ...buildStreamingToolPaneElements(tools)];
  }
  return elements;
}

function buildStreamingHistoryRenderState(
  content: string,
  tools: ToolCallInfo[] = [],
  elementId = 'streaming_content',
  historyItems?: StreamingHistoryItem[],
): StreamingHistoryRenderState {
  const elements = historyItems
    ? buildStreamingHistoryElementsFromItems(content, historyItems, elementId)
    : buildStreamingRunningHistoryElements(content, tools, elementId);
  const historyPanel = elements.find((element) => element.element_id === 'stream_history');
  const historyChildren = Array.isArray(historyPanel?.elements)
    ? historyPanel.elements as Array<Record<string, unknown>>
    : [];
  const elementIds: string[] = [];
  const elementJson: Record<string, string> = {};
  const elementsById: Record<string, Record<string, unknown>> = {};
  for (const element of historyChildren) {
    const elementIdValue = typeof element.element_id === 'string' ? element.element_id.trim() : '';
    if (!elementIdValue) continue;
    elementIds.push(elementIdValue);
    elementJson[elementIdValue] = JSON.stringify(element);
    elementsById[elementIdValue] = element;
  }
  return { elementIds, elementJson, elementsById };
}

function buildStreamingToolAppendOperations(
  state: FeishuCardState,
  desired: StreamingHistoryRenderState,
  tools: ToolCallInfo[],
): StreamingHistoryAppendPlan {
  const operations: StreamingHistoryAppendOperation[] = [];
  let requiresFullRefresh = false;
  tools.forEach((tool, index) => {
    if (requiresFullRefresh) return;
    const elementId = `stream_tool_${index + 1}`;
    const element = desired.elementsById[elementId];
    const elementJson = desired.elementJson[elementId];
    if (!element || !elementJson) return;
    const snapshot = toolSnapshotSignature(tool);
    if (!state.renderedToolSnapshots[elementId]) {
      operations.push({
        kind: 'create',
        elementId,
        targetElementId: 'stream_history',
        element,
        elementJson,
        snapshot,
        eventCount: 1,
      });
      return;
    }
    if (state.renderedToolSnapshots[elementId] === snapshot) return;
    requiresFullRefresh = true;
  });
  return { operations: requiresFullRefresh ? [] : operations, requiresFullRefresh };
}

function isToolPanelElementId(elementId: string): boolean {
  return /^stream_tool(?:_panel)?_\d+$/.test(elementId);
}

function buildStreamingHistoryAppendOperations(
  state: FeishuCardState,
  desired: StreamingHistoryRenderState,
): StreamingHistoryAppendPlan {
  const operations: StreamingHistoryAppendOperation[] = [];
  const existingIds = state.renderedHistoryElementIds;
  if (
    existingIds.length > desired.elementIds.length
    || existingIds.some((elementId, index) => desired.elementIds[index] !== elementId)
  ) {
    return { operations: [], requiresFullRefresh: true };
  }

  for (const elementId of desired.elementIds) {
    const element = desired.elementsById[elementId];
    const elementJson = desired.elementJson[elementId];
    if (!element || !elementJson) continue;

    if (!state.renderedHistoryElementJson[elementId]) {
      operations.push({
        kind: 'create',
        elementId,
        targetElementId: 'stream_history',
        element,
        elementJson,
      });
      continue;
    }

    if (state.renderedHistoryElementJson[elementId] === elementJson) continue;
    const markdownContent = markdownElementContent(element);
    if (markdownContent !== null) {
      operations.push({
        kind: 'content',
        elementId,
        targetElementId: elementId,
        element,
        elementJson,
        content: markdownContent,
      });
      continue;
    }

    if (!isToolPanelElementId(elementId)) {
      return { operations: [], requiresFullRefresh: true };
    }

    return { operations: [], requiresFullRefresh: true };
  }
  return { operations, requiresFullRefresh: false };
}

function markdownElementContent(element: Record<string, unknown> | undefined): string | null {
  if (element?.tag !== 'markdown') return null;
  return typeof element.content === 'string' ? element.content : '';
}

function streamingUpdateTouchesUserText(update: Pick<StreamingUpdateOperation, 'content' | 'element'>): boolean {
  const content = typeof update.content === 'string'
    ? update.content
    : markdownElementContent(update.element);
  return typeof content === 'string' && /^\s*\*\*用户\*\*：/.test(content);
}

function streamingUpdatesHaveBatchUpdateCandidate(updates: Array<Pick<StreamingUpdateOperation, 'kind'>>): boolean {
  for (let index = 0; index < updates.length; index += 1) {
    const update = updates[index]!;
    if (update.kind !== 'create' && update.kind !== 'patch') continue;
    const batchableUpdates: Array<Pick<StreamingUpdateOperation, 'kind'>> = [];
    for (let batchIndex = index; batchIndex < updates.length; batchIndex += 1) {
      const item = updates[batchIndex]!;
      if (item.kind !== 'create' && item.kind !== 'patch') break;
      batchableUpdates.push(item);
    }
    if (
      batchableUpdates.length > 1
      || batchableUpdates.some((item) => item.kind === 'patch')
    ) {
      return true;
    }
    index += batchableUpdates.length - 1;
  }
  return false;
}

function streamingHistorySignature(items: StreamingHistoryItem[]): string {
  return JSON.stringify(items.map((item) => {
    if (item.type === 'markdown') {
      return ['markdown', item.role, item.content, item.elementId || ''];
    }
    return ['tool_panel', item.tools.map((tool) => [
      tool.id,
      tool.name,
      tool.status,
      tool.input || '',
      tool.output || '',
      JSON.stringify(tool.detail || null),
    ])];
  }));
}

function renderedHistoryMatchesDesired(
  state: FeishuCardState,
  desired: StreamingHistoryRenderState,
): boolean {
  if (state.renderedHistoryElementIds.length !== desired.elementIds.length) return false;
  return desired.elementIds.every((elementId, index) =>
    state.renderedHistoryElementIds[index] === elementId
    && state.renderedHistoryElementJson[elementId] === desired.elementJson[elementId]);
}

function createInitialCardHistoryItems(): StreamingHistoryItem[] {
  return [
    { type: 'markdown', role: 'thinking', content: '💭 Thinking...' },
  ];
}

function normalizeCardActionRows(actionRows: FeishuCardActionButton[][]): FeishuCardActionButton[][] {
  return actionRows
    .map((row) => row
      .filter((button) => button.text && button.callbackData)
      .map((button) => ({
        text: button.text,
        callbackData: button.callbackData,
        type: button.type || 'default',
        disabled: Boolean(button.disabled),
      })))
    .filter((row) => row.length > 0);
}

function cardActionRowsSignature(actionRows: FeishuCardActionButton[][]): string {
  return JSON.stringify(normalizeCardActionRows(actionRows));
}

function normalizeStreamMetadata(metadata: StructuredStreamingUiMetadata = {}): StructuredStreamingUiMetadata {
  return {
    title: metadata.title?.trim() || undefined,
    tags: (metadata.tags || []).map((tag) => tag.trim()).filter(Boolean).slice(0, 6),
    template: metadata.template || 'blue',
    tagColor: metadata.tagColor || 'blue',
  };
}

function streamMetadataSignature(metadata: StructuredStreamingUiMetadata = {}): string {
  return JSON.stringify(normalizeStreamMetadata(metadata));
}

function summarizeCardActionRows(actionRows: FeishuCardActionButton[][]): {
  rowCount: number;
  buttonCount: number;
  labels: string[];
  callbackPrefixes: string[];
  disabledCount: number;
} {
  const normalized = normalizeCardActionRows(actionRows);
  const buttons = normalized.flat();
  return {
    rowCount: normalized.length,
    buttonCount: buttons.length,
    labels: buttons.map((button) => button.text),
    callbackPrefixes: buttons.map((button) => button.callbackData.split(':').slice(0, 2).join(':')),
    disabledCount: buttons.filter((button) => button.disabled).length,
  };
}

/** Shape of the SDK's im.message.receive_v1 event data. */
type FeishuMessageEventData = {
  sender: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    chat_id: string;
    thread_id?: string;
    chat_type: string;
    message_type: string;
    content: string;
    create_time: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; union_id?: string; user_id?: string };
      name: string;
    }>;
  };
};

type FeishuDocumentFileType = CloudDocumentAddress['fileType'];
type FeishuChatRemovedReason = 'bot_removed' | 'chat_disbanded';

interface FeishuCommentReplyElement {
  type?: string;
  text_run?: { text?: string };
  docs_link?: { url?: string };
  person?: { user_id?: string };
}

interface FeishuCommentReply {
  reply_id?: string;
  content?: { elements?: FeishuCommentReplyElement[] };
}

interface FeishuCommentItem {
  comment_id?: string;
  quote?: string;
  is_whole?: boolean;
  reply_list?: { replies?: FeishuCommentReply[] };
}

interface FeishuCommentContext {
  question: string;
  quote?: string;
  isWhole: boolean;
  targetReplyId?: string;
  mentionedBotInContent: boolean;
  contentMentionDiagnostics: FeishuCommentContentMentionDiagnostics;
}

interface FeishuCommentTarget {
  fileToken: string;
  fileType: FeishuDocumentFileType;
  commentId: string;
  replyId?: string;
  eventId?: string;
  operatorId?: string;
  mentioned: boolean;
  mentionDiagnostics?: FeishuCommentMentionDiagnostics;
}

interface FeishuCommentMentionDiagnostics {
  mentionedBotFlag: unknown;
  mentionedBotSnakeFlag: unknown;
  mentionListSource: string | null;
  mentionListLength: number;
  mentionCandidates: Array<{
    index: number;
    keys: string[];
    candidates: Array<{
      path: string;
      sha256: string;
      matchedBotId: boolean;
    }>;
  }>;
  toUserId?: {
    sha256: string;
    matchedBotId: boolean;
  };
  botIdsKnown: number;
  botIdHashes: string[];
}

interface FeishuCommentContentMentionDiagnostics {
  targetReplyId?: string;
  elementCount: number;
  personCandidates: Array<{
    path: string;
    sha256: string;
    matchedBotId: boolean;
  }>;
}

const SUPPORTED_DOCUMENT_COMMENT_TYPES = new Set<string>(['doc', 'docx', 'sheet', 'file']);

function normalizeDocumentFileType(value: unknown): FeishuDocumentFileType | null {
  return typeof value === 'string' && SUPPORTED_DOCUMENT_COMMENT_TYPES.has(value)
    ? value as FeishuDocumentFileType
    : null;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function isLikelyFeishuIdKey(key: string): boolean {
  return /^(?:open_id|openId|union_id|unionId|user_id|userId|bot_id|botId|member_id|memberId|id)$/.test(key);
}

function collectFeishuIdCandidates(
  value: unknown,
  pathLabel: string,
  depth = 0,
): Array<{ path: string; value: string }> {
  if (depth > 4 || value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectFeishuIdCandidates(item, `${pathLabel}[${index}]`, depth + 1));
  }
  if (typeof value !== 'object') return [];

  const candidates: Array<{ path: string; value: string }> = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${pathLabel}.${key}`;
    if (typeof child === 'string' && child.trim() && isLikelyFeishuIdKey(key)) {
      candidates.push({ path: childPath, value: child.trim() });
    } else if (child && typeof child === 'object') {
      candidates.push(...collectFeishuIdCandidates(child, childPath, depth + 1));
    }
    if (candidates.length >= 30) break;
  }
  return candidates;
}

function decodeFeishuCommentTextEntities(text: string): string {
  let decoded = text;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = decoded
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(x[0-9a-fA-F]+|\d+);/g, (match, rawCode: string) => {
        const codePoint = rawCode.toLowerCase().startsWith('x')
          ? Number.parseInt(rawCode.slice(1), 16)
          : Number.parseInt(rawCode, 10);
        if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) return match;
        return String.fromCodePoint(codePoint);
      });
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function commentTextFromElements(elements: FeishuCommentReplyElement[] | undefined): string {
  if (!elements) return '';
  return elements
    .map((element) => {
      if (element.type === 'text_run') return decodeFeishuCommentTextEntities(element.text_run?.text || '');
      if (element.type === 'docs_link') return decodeFeishuCommentTextEntities(element.docs_link?.url || '');
      return '';
    })
    .join('')
    .trim();
}

function stripMarkdownForDocumentComment(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[-*]\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/```[a-zA-Z]*\n?/g, '')
    .replace(/```/g, '')
    .trim();
}

type FeishuErrorData = {
  code?: number;
  msg?: string;
  log_id?: string;
  error?: {
    log_id?: string;
    troubleshooter?: string;
  };
};

function findFeishuErrorData(value: unknown, depth = 0): FeishuErrorData | undefined {
  if (!value || depth > 4) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const data = findFeishuErrorData(item, depth + 1);
      if (data) return data;
    }
    return undefined;
  }
  if (typeof value !== 'object') return undefined;

  const record = value as Record<string, unknown>;
  const directCode = record.code;
  const directMsg = record.msg;
  if (typeof directCode === 'number' || typeof directMsg === 'string') {
    return record as FeishuErrorData;
  }

  return findFeishuErrorData(record.response, depth + 1)
    || findFeishuErrorData(record.data, depth + 1)
    || findFeishuErrorData(record.error, depth + 1);
}

function feishuErrorCode(err: unknown): number | undefined {
  return findFeishuErrorData(err)?.code;
}

function feishuErrorHttpStatus(err: unknown): number | undefined {
  const response = (err as { response?: { status?: number } })?.response;
  return typeof response?.status === 'number' ? response.status : undefined;
}

function feishuErrorSummary(err: unknown, fallback: string): string {
  const data = findFeishuErrorData(err);
  const parts: string[] = [];
  if (typeof data?.code === 'number') parts.push(`code=${data.code}`);
  if (data?.msg) parts.push(`msg=${data.msg}`);
  const logId = data?.error?.log_id || data?.log_id;
  if (logId) parts.push(`log_id=${logId}`);
  if (data?.error?.troubleshooter) parts.push(`troubleshooter=${data.error.troubleshooter}`);
  if (parts.length > 0) return parts.join('; ');
  return err instanceof Error ? err.message : fallback;
}

function normalizePostCodeLanguage(value: unknown): string {
  const language = typeof value === 'string' ? value.trim() : '';
  if (!language) return 'text';
  return /^[A-Za-z0-9_+#.-]+$/.test(language) ? language : 'text';
}

function appendPostBlock(parts: string[], block: string): void {
  if (!block) return;
  const previous = parts.at(-1) || '';
  if (previous && !previous.endsWith('\n')) {
    parts.push('\n');
  }
  parts.push(block);
  parts.push('\n');
}

interface FeishuPostParseResult {
  extractedText: string;
  imageKeys: string[];
  warnings: string[];
}

interface FeishuFetchedMessageItem {
  message_id?: string;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  msg_type?: string;
  body?: {
    content?: string;
  };
}

const POST_ELEMENT_FIELDS: Record<string, Set<string>> = {
  a: new Set(['tag', 'text', 'href', 'style']),
  at: new Set(['tag', 'user_id', 'user_name', 'style']),
  code_block: new Set(['tag', 'language', 'text']),
  img: new Set(['tag', 'image_key', 'file_key', 'imageKey']),
  text: new Set(['tag', 'text', 'style', 'un_escape']),
};

function describeUnsupportedPostElementFields(element: Record<string, unknown>, index: number): string[] {
  const tag = typeof element.tag === 'string' ? element.tag : '';
  const knownFields = tag ? POST_ELEMENT_FIELDS[tag] : undefined;
  if (!knownFields) return [];
  const unsupported = Object.keys(element).filter((key) => !knownFields.has(key));
  if (unsupported.length === 0) return [];
  return [`第 ${index + 1} 个 ${tag} 元素包含暂未支持的字段：${unsupported.join(', ')}`];
}

function parseFeishuPostContent(content: string): FeishuPostParseResult {
  const imageKeys: string[] = [];
  const textParts: string[] = [];
  const warnings: string[] = [];

  try {
    const parsed = JSON.parse(content);
    // Post content structure: { title, content: [[{tag, text/image_key}]] }
    const title = typeof parsed.title === 'string'
      ? parsed.title.replace(/\s+/g, ' ').trim()
      : '';
    if (title) textParts.push(`# ${title}\n\n`);

    const paragraphs = parsed.content;
    if (Array.isArray(paragraphs)) {
      for (const paragraph of paragraphs) {
        if (!Array.isArray(paragraph)) continue;
        for (const [index, element] of paragraph.entries()) {
          if (!element || typeof element !== 'object') {
            warnings.push(`第 ${index + 1} 个富文本元素结构暂不支持`);
            appendPostBlock(textParts, '[unsupported Feishu post element]');
            continue;
          }
          warnings.push(...describeUnsupportedPostElementFields(element as Record<string, unknown>, index));
          if (element.tag === 'text' && element.text) {
            textParts.push(element.text);
          } else if (element.tag === 'a' && element.text) {
            textParts.push(element.text);
          } else if (element.tag === 'at' && element.user_id) {
            // Mention in post — handled by isBotMentioned for group policy
          } else if (element.tag === 'img') {
            const key = element.image_key || element.file_key || element.imageKey;
            if (key) imageKeys.push(key);
          } else if (element.tag === 'code_block' && typeof element.text === 'string') {
            appendPostBlock(
              textParts,
              buildFencedCodeBlock(element.text, normalizePostCodeLanguage(element.language)),
            );
          } else {
            const tag = typeof element.tag === 'string' && element.tag ? element.tag : 'unknown';
            warnings.push(`暂不支持飞书富文本元素：${tag}`);
            appendPostBlock(textParts, `[unsupported Feishu post element: ${tag}]`);
          }
        }
        textParts.push('\n');
      }
    } else if (parsed.content !== undefined) {
      warnings.push('飞书富文本 content 字段结构暂不支持');
    }
  } catch {
    warnings.push('飞书富文本 JSON 解析失败');
  }

  return {
    extractedText: textParts.join('').replace(/[ \t]+\n/g, '\n').trim(),
    imageKeys,
    warnings,
  };
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function extractInteractiveCardJson(content: string): unknown {
  const parsed = parseJsonObject(content);
  if (!parsed) return content;

  const data = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
    ? parsed.data as Record<string, unknown>
    : null;
  const card = parsed.card && typeof parsed.card === 'object' && !Array.isArray(parsed.card)
    ? parsed.card as Record<string, unknown>
    : null;

  return data?.user_dsl
    || data?.card
    || data?.card_json
    || parsed.user_dsl
    || card
    || parsed;
}

function formatInteractiveCardPromptBlock(content: string): string {
  return [
    '<interactive_card>',
    safeJsonStringify(extractInteractiveCardJson(content)),
    '</interactive_card>',
  ].join('\n');
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatQuotedMessageContext(messageId: string, messageType: string, body: string): string {
  const typeLabel = messageType || 'unknown';
  let rendered = '';

  if (messageType === 'text') {
    const parsed = parseJsonObject(body);
    rendered = typeof parsed?.text === 'string' ? parsed.text : body;
  } else if (messageType === 'post') {
    rendered = parseFeishuPostContent(body).extractedText;
  } else if (messageType === 'interactive') {
    rendered = formatInteractiveCardPromptBlock(body);
  } else if (messageType) {
    rendered = `[暂不支持解析被引用的飞书消息类型：${messageType}]`;
  } else {
    rendered = '[无法识别被引用的飞书消息类型]';
  }

  return [
    `<quoted_message platform="feishu" message_id="${escapeXmlAttribute(messageId)}" message_type="${escapeXmlAttribute(typeLabel)}">`,
    rendered.trim() || '[被引用消息为空]',
    '</quoted_message>',
  ].join('\n');
}


/** MIME type guesses by message_type. */
const MIME_BY_TYPE: Record<string, string> = {
  image: 'image/png',
  file: 'application/octet-stream',
  audio: 'audio/ogg',
  video: 'video/mp4',
  media: 'application/octet-stream',
};

function inferImageFileName(url: string, contentType: string): string {
  try {
    const pathname = new URL(url).pathname;
    const baseName = path.basename(pathname);
    if (/\.(?:jpe?g|png|webp|gif|tiff?|bmp|ico)$/i.test(baseName)) {
      return baseName;
    }
  } catch {
    // fall through to content-type based fallback
  }

  const normalized = contentType.split(';', 1)[0]?.trim().toLowerCase();
  const ext = normalized === 'image/jpeg'
    ? 'jpg'
    : normalized === 'image/webp'
      ? 'webp'
      : normalized === 'image/gif'
        ? 'gif'
        : normalized === 'image/tiff'
          ? 'tiff'
          : normalized === 'image/bmp'
            ? 'bmp'
            : normalized === 'image/x-icon' || normalized === 'image/vnd.microsoft.icon'
              ? 'ico'
              : 'png';
  return `avatar.${ext}`;
}

function dataUrlToImageBlob(dataUrl: string): Blob {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error('Invalid embedded group authorization image data URL.');
  const [, contentType, base64] = match;
  const data = Buffer.from(base64, 'base64');
  if (data.length === 0) throw new Error('Embedded group authorization image is empty.');
  return new Blob([data], { type: contentType || 'image/png' });
}

export class FeishuAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType;
  readonly provider = 'feishu';
  readonly alias?: string;
  private readonly channelConfig: FeishuChannelConfig;

  private running = false;
  private wsClient: lark.WSClient | null = null;
  private restClient: lark.Client | null = null;
  private seenMessageIds = new Map<string, boolean>();
  private botOpenId: string | null = null;
  private botId: string | null = null;
  private botName: string | null = null;
  private botAvatarUrl: string | null = null;
  /** All known bot IDs (open_id, user_id, union_id) for mention matching. */
  private botIds = new Set<string>();
  /** Track last incoming message ID per chat for replying with streaming cards. */
  private lastIncomingMessageId = new Map<string, string>();
  /** Active streaming card state per stream key. */
  private activeCards = new Map<string, FeishuCardState>();
  /** In-flight card creation promises per stream key — prevents duplicate creation. */
  private cardCreatePromises = new Map<string, Promise<boolean>>();
  /** Desired stream state that arrives while the first CardKit card is still being created. */
  private pendingCardCreateStates = new Map<string, PendingStreamingCardCreateState>();
  /** Scheduled card creation promises per stream key — coalesces retries while congested. */
  private scheduledCardCreatePromises = new Map<string, Promise<boolean>>();
  private cardCreateRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private cardCreateNextEarliestAt = new Map<string, number>();
  private cardCreateConsecutiveFailures = new Map<string, number>();
  /** Action rows to apply when a streaming card is created or refreshed. */
  private streamActionRows = new Map<string, FeishuCardActionButton[][]>();
  /** Metadata to apply when a streaming card is created or refreshed. */
  private pendingStreamMetadata = new Map<string, StructuredStreamingUiMetadata>();
  /** Recently sent rich command cards that can be updated in-place. */
  private richCardUpdates = new Map<string, RichCardUpdateState>();
  private groupAuthorizationImageKeyPromise: Promise<string | null> | null = null;
  /** Cached tenant token for upload APIs. */
  private tenantTokenCache:
    | { token: string; expiresAt: number; appId: string; appSecret: string; domain: string }
    | null = null;
  private tenantTokenRequest: Promise<string> | null = null;
  private cardRequestTimeoutMs = CARD_REQUEST_TIMEOUT_MS;
  private cardFinalizeFlushWaitExtraMs = CARD_FINALIZE_FLUSH_WAIT_EXTRA_MS;
  private cardFinalizeBlockingBudgetMs = CARD_FINALIZE_BLOCKING_BUDGET_MS;
  private cardFullRefreshIntervalMs = CARD_FULL_REFRESH_INTERVAL_MS;
  private cardFlushBaseIntervalMs = CARD_FLUSH_BASE_INTERVAL_MS;
  private cardFlushFirstFailureIntervalMs = CARD_FLUSH_FIRST_FAILURE_INTERVAL_MS;
  private cardFlushMaxFailureIntervalMs = CARD_FLUSH_MAX_FAILURE_INTERVAL_MS;

  constructor(instance?: AdapterRuntimeInstance) {
    super();
    this.channelType = instance?.id || 'feishu';
    this.alias = instance?.alias;
    this.channelConfig = (instance?.config || {}) as FeishuChannelConfig;
  }

  private get appId(): string {
    return this.channelConfig.appId?.trim() || '';
  }

  private get appSecret(): string {
    return this.channelConfig.appSecret?.trim() || '';
  }

  private get site(): 'feishu' | 'lark' {
    return normalizeFeishuSite(this.channelConfig.site);
  }

  private get displayBotName(): string {
    return this.botName?.trim() || this.alias?.trim() || this.channelType;
  }

  private formatBotPrefixedGroupName(name: string): string {
    const requestedName = name.trim();
    const prefix = `[${this.displayBotName}]`;
    return requestedName.startsWith(prefix) ? requestedName : `${prefix}${requestedName}`;
  }

  private isStreamingEnabled(): boolean {
    return this.channelConfig.streamingEnabled !== false;
  }

  private shouldRequireMentionForGroup(): boolean {
    return this.channelConfig.requireMention === true;
  }

  private isGroupAuthorized(): boolean {
    return this.channelConfig.groupAuthorized === true;
  }

  private developerAuthUrl(): string {
    const appId = this.appId || this.botOpenId || '';
    return appId
      ? `https://open.feishu.cn/app/${encodeURIComponent(appId)}/auth`
      : 'https://open.feishu.cn/app/';
  }

  private async getGroupAuthorizationImageKey(): Promise<string | null> {
    if (!this.groupAuthorizationImageKeyPromise) {
      this.groupAuthorizationImageKeyPromise = (async () => {
        try {
          const image = dataUrlToImageBlob(groupAuthorizationImageDataUrl);
          return await this.uploadImageBlob('message', image, GROUP_AUTHORIZATION_IMAGE_FILE_NAME);
        } catch (error) {
          this.groupAuthorizationImageKeyPromise = null;
          console.warn(
            '[feishu-adapter] Failed to upload group authorization reference image:',
            error instanceof Error ? error.message : error,
          );
          return null;
        }
      })();
    }
    return this.groupAuthorizationImageKeyPromise;
  }

  private async buildGroupAuthorizationCard(): Promise<NonNullable<OutboundMessage['richCard']>> {
    const scopeJson = JSON.stringify({ scopes: { tenant: [FEISHU_GROUP_MESSAGE_SCOPE] } }, null, 2);
    const imageKey = await this.getGroupAuthorizationImageKey();
    return {
      title: '群聊消息权限确认',
      template: 'orange',
      sections: [
        {
          markdown: [
            '如果您从默认向导中新建机器人，该机器人可能没有权限获取群聊中的所有消息（只能收到 @ 机器人的消息）。',
            '',
            `请**复制下方的代码块**并参考图片在[开发者后台](${this.developerAuthUrl()})中授予机器人该权限，如您已经授权，请点击下方按钮。`,
          ].join('\n'),
        },
        {
          title: '需要授予的权限',
          code: {
            language: 'json',
            text: scopeJson,
          },
        },
        ...(imageKey
          ? [{
              image: {
                imageKey,
                alt: '飞书群聊消息权限授权参考图',
                mode: 'fit_horizontal' as const,
              },
            }]
          : []),
      ],
      actions: [[{
        text: '我已授权',
        callbackData: FEISHU_GROUP_AUTHORIZED_CALLBACK_DATA,
        type: 'primary',
      }]],
    };
  }

  private persistGroupAuthorized(): void {
    this.channelConfig.groupAuthorized = true;
    createConfigService({ migrate: false }).set(
      { kind: 'home' },
      {
        channels: [{
          id: this.channelType,
          provider: 'feishu',
          config: { groupAuthorized: true },
        }],
      },
    );
  }

  supportsStructuredStreamingUi(chatId: string): boolean {
    return this.isStreamingEnabled() && !this.isCloudDocumentChatId(chatId);
  }

  private isCloudDocumentChatId(chatId: string): boolean {
    return chatId.startsWith('doc:');
  }

  private resolveStreamKey(chatId: string, streamKey?: string): string {
    return streamKey?.trim() || chatId;
  }

  private previewLogValue(value: unknown, maxLength = 240): string {
    let raw = '';
    if (typeof value === 'string') {
      raw = value;
    } else {
      try {
        raw = JSON.stringify(value);
      } catch {
        raw = String(value);
      }
    }
    const normalized = raw.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}...`;
  }

  private summarizeSenderIds(sender: FeishuMessageEventData['sender']): string[] {
    return [
      sender.sender_id?.open_id,
      sender.sender_id?.user_id,
      sender.sender_id?.union_id,
    ].filter((value): value is string => Boolean(value));
  }

  private logIncomingMessageEvent(data: FeishuMessageEventData): void {
    const mentions = Array.isArray(data.message.mentions)
      ? data.message.mentions.map((mention) =>
        mention.id?.open_id || mention.id?.user_id || mention.id?.union_id || mention.name || mention.key)
      : [];
    console.log('[feishu-adapter] Incoming message event:', {
      messageId: data.message.message_id,
      chatId: data.message.chat_id,
      chatType: data.message.chat_type,
      messageType: data.message.message_type,
      senderType: data.sender.sender_type,
      senderIds: this.summarizeSenderIds(data.sender),
      mentionCount: mentions.length,
      mentions,
      createTime: data.message.create_time,
      rawContentPreview: this.previewLogValue(data.message.content),
    });
  }

  private logQueuedInboundMessage(params: {
    messageId: string;
    chatId: string;
    messageType: string;
    text: string;
    attachmentCount: number;
    callbackData?: string;
  }): void {
    console.log('[feishu-adapter] Enqueued inbound message:', {
      messageId: params.messageId,
      chatId: params.chatId,
      messageType: params.messageType,
      attachmentCount: params.attachmentCount,
      callbackData: params.callbackData || '',
      textPreview: this.previewLogValue(params.text),
    });
  }

  private runDetachedEventTask(label: string, task: () => Promise<void>): void {
    try {
      void task().catch((err) => {
        console.error(
          `[feishu-adapter] Detached ${label} task failed:`,
          err instanceof Error ? err.stack || err.message : err,
        );
      });
    } catch (err) {
      console.error(
        `[feishu-adapter] Detached ${label} task failed:`,
        err instanceof Error ? err.stack || err.message : err,
      );
    }
  }

  private async fetchMessageById(messageId: string): Promise<FeishuFetchedMessageItem | null> {
    if (!this.restClient || !messageId.trim()) return null;
    const getter = (this.restClient as any).im?.message?.get;
    if (typeof getter !== 'function') return null;
    try {
      const res = await this.withFeishuRequestTimeout<{
        data?: { items?: FeishuFetchedMessageItem[] };
      }>(messageId, 'im.message.get:quoted-message', () => getter({
        path: { message_id: messageId },
        params: { user_id_type: 'open_id' },
      }));
      return res?.data?.items?.[0] || null;
    } catch (error) {
      console.warn('[feishu-adapter] Failed to fetch quoted message:', messageId, error instanceof Error ? error.message : error);
      return null;
    }
  }

  private async buildQuotedMessageContext(parentMessageId?: string): Promise<string | undefined> {
    const messageId = parentMessageId?.trim();
    if (!messageId) return undefined;

    const item = await this.fetchMessageById(messageId);
    if (!item) {
      return [
        `<quoted_message platform="feishu" message_id="${escapeXmlAttribute(messageId)}" message_type="unknown" read_error="true">`,
        '[无法读取被引用消息内容]',
        '</quoted_message>',
      ].join('\n');
    }

    const fetchedMessageId = item.message_id || messageId;
    const messageType = item.msg_type || '';
    const body = item.body?.content || '';
    return formatQuotedMessageContext(fetchedMessageId, messageType, body);
  }

  // ── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[feishu-adapter] Cannot start:', configError);
      return;
    }

    const appId = this.appId;
    const appSecret = this.appSecret;
    const site = this.site;
    const domain = site === 'lark'
      ? lark.Domain.Lark
      : lark.Domain.Feishu;
    const httpInstance = buildHttpInstanceWithEnvProxy(site);
    const enabledProxies = describeEnabledProxies(site);
    if (enabledProxies.length > 0) {
      console.log('[feishu-adapter] Env proxy enabled:', enabledProxies.join(', '));
    }

    // Create REST client
    this.restClient = new lark.Client({
      appId,
      appSecret,
      domain,
      httpInstance,
    });

    // Resolve bot identity for @mention detection
    await this.resolveBotIdentity(appId, appSecret, domain);

    this.running = true;

    // Create EventDispatcher and register event handlers.
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data) => {
        this.runDetachedEventTask('incoming message', () =>
          this.handleIncomingEvent(data as FeishuMessageEventData),
        );
      },
      'card.action.trigger': (async (data: unknown) => {
        return await this.handleCardAction(data);
      }) as any,
      'drive.notice.comment_add_v1': (data: unknown) => {
        this.runDetachedEventTask('cloud document comment', () =>
          this.handleCloudDocumentCommentEvent(data),
        );
      },
      'im.chat.member.bot.deleted_v1': (data: unknown) => {
        this.runDetachedEventTask('chat removed', () =>
          this.handleChatRemovedEvent(data, 'bot_removed', 'im.chat.member.bot.deleted_v1'),
        );
      },
      'im.chat.disbanded_v1': (data: unknown) => {
        this.runDetachedEventTask('chat removed', () =>
          this.handleChatRemovedEvent(data, 'chat_disbanded', 'im.chat.disbanded_v1'),
        );
      },
    });

    // Create and start WSClient. `httpInstance` covers endpoint discovery,
    // while `agent` covers the final WSS socket.
    const wsClientOptions = buildWsClientOptions(appId, appSecret, domain, site, process.env, httpInstance);
    this.wsClient = createWsClient(wsClientOptions as ConstructorParameters<typeof lark.WSClient>[0]);

    // Monkey-patch WSClient.handleEventData to support card action events (type: "card").
    // The SDK's WSClient only processes type="event" messages. Card action callbacks
    // arrive as type="card" and would be silently dropped without this patch.
    const wsClientAny = this.wsClient as any;
    if (typeof wsClientAny.handleEventData === 'function') {
      const origHandleEventData = wsClientAny.handleEventData.bind(wsClientAny);
      wsClientAny.handleEventData = (data: any) => {
        const msgType = data.headers?.find?.((h: any) => h.key === 'type')?.value;
        if (msgType === 'card') {
          console.log('[feishu-adapter] handleEventData type: card (patched → event)');
          const patchedData = {
            ...data,
            headers: data.headers.map((h: any) =>
              h.key === 'type' ? { ...h, value: 'event' } : h,
            ),
          };
          return origHandleEventData(patchedData);
        }
        return origHandleEventData(data);
      };
    }

    this.wsClient.start({ eventDispatcher: dispatcher });

    console.log('[feishu-adapter] Started (botOpenId:', this.botOpenId || 'unknown', ')');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Close WebSocket connection (SDK exposes close())
    if (this.wsClient) {
      try {
        this.wsClient.close({ force: true });
      } catch (err) {
        console.warn('[feishu-adapter] WSClient close error:', err instanceof Error ? err.message : err);
      }
      this.wsClient = null;
    }
    this.restClient = null;

    // Reject all waiting consumers
    this.rejectPendingInboundConsumers();

    // Clean up active cards
    for (const [, state] of this.activeCards) {
      if (state.throttleTimer) clearTimeout(state.throttleTimer);
    }
    this.activeCards.clear();
    this.cardCreatePromises.clear();
    this.scheduledCardCreatePromises.clear();
    this.clearAllCardCreateRetryTimers();
    this.cardCreateNextEarliestAt.clear();
    this.cardCreateConsecutiveFailures.clear();
    this.streamActionRows.clear();
    this.pendingStreamMetadata.clear();
    this.richCardUpdates.clear();

    // Clear state
    this.seenMessageIds.clear();
    this.lastIncomingMessageId.clear();

    console.log('[feishu-adapter] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Queue ───────────────────────────────────────────────────

  consumeOne(): Promise<InboundMessage | null> {
    return this.consumeInboundMessage(this.running);
  }

  async createGroupChat(options: CreateGroupChatOptions): Promise<CreatedGroupChat> {
    const configError = this.validateConfig();
    if (configError) throw new Error(configError);

    if (options.createAs === 'user') {
      return this.createGroupChatAsLarkCliUser(options);
    }

    const restClient = this.restClient || new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.site === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      httpInstance: buildHttpInstanceWithEnvProxy(this.site),
    });

    const requestedName = options.name.trim();
    if (!requestedName) throw new Error('Group name is required.');
    const groupName = this.formatBotPrefixedGroupName(requestedName);
    const userIds = Array.from(new Set([
      ...(options.ownerUserId ? [options.ownerUserId] : []),
      ...(options.userIds || []),
    ].map((value) => value.trim()).filter(Boolean)));

    const data: {
      name: string;
      avatar?: string;
      owner_id?: string;
      user_id_list?: string[];
      bot_id_list?: string[];
      group_message_type: 'chat';
    } = {
      name: groupName,
      group_message_type: 'chat',
    };
    const avatarImageKey = await this.tryUploadGroupAvatarImageKey();
    if (avatarImageKey) data.avatar = avatarImageKey;
    if (options.ownerUserId) data.owner_id = options.ownerUserId;
    if (userIds.length > 0) data.user_id_list = userIds;
    if (this.botId) data.bot_id_list = [this.botId];

    const res = await this.withFeishuRequestTimeout<{
      code?: number;
      msg?: string;
      data?: { chat_id?: string; name?: string };
    }>('create-group', 'im.chat.create', () => restClient.im.chat.create({
      params: {
        user_id_type: 'open_id',
        set_bot_manager: true,
        uuid: crypto.randomUUID(),
      },
      data,
    }));

    if (res?.code && res.code !== 0) {
      throw new Error(res.msg || `Feishu create group failed: code=${res.code}`);
    }
    const chatId = res?.data?.chat_id;
    if (!chatId) {
      throw new Error('Feishu create group returned no chat_id.');
    }

    return {
      chatId,
      chatKind: 'group',
      name: res.data?.name || groupName,
    };
  }

  async notifyGroupChatCreated(address: ChannelAddress, _group: CreatedGroupChat): Promise<void> {
    if (this.isGroupAuthorized()) return;
    const result = await this.send({
      address,
      text: '群聊消息权限确认',
      richCard: await this.buildGroupAuthorizationCard(),
    });
    if (!result.ok) {
      console.warn('[feishu-adapter] Failed to send group authorization card:', result.error || result.httpStatus);
    }
  }

  private async createGroupChatAsLarkCliUser(options: CreateGroupChatOptions): Promise<CreatedGroupChat> {
    const requestedName = options.name.trim();
    if (!requestedName) throw new Error('Group name is required.');
    const groupName = this.formatBotPrefixedGroupName(requestedName);
    const appId = this.appId;
    if (!appId) throw new Error('Feishu App ID 未配置，无法邀请 bridge bot 入群。');

    const args = [
      'lark-cli',
      'im',
      '+chat-create',
      '--as',
      'user',
      '--chat-mode',
      'group',
      '--type',
      'private',
      '--name',
      groupName,
      '--bots',
      appId,
      '--format',
      'json',
    ];

    try {
      const env = { ...process.env };
      delete env.NODE_OPTIONS;
      const { stdout, stderr } = await execFileAsync('npx', args, {
        env,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });
      if (stderr.trim()) {
        console.warn('[feishu-adapter] lark-cli user chat create stderr:', stderr.trim());
      }
      const parsed = JSON.parse(stdout || '{}');
      const chatId = findFeishuChatIdInJson(parsed);
      if (!chatId) {
        throw new Error(`lark-cli 未返回 chat_id: ${stdout.slice(0, 1000)}`);
      }
      return {
        chatId,
        chatKind: 'group',
        name: groupName,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error([
        `使用 lark-cli user 身份创建云文档群聊失败：${message}`,
        '请确认当前机器已执行 lark-cli auth login，并具备 im:chat / im:message.send_as_user 等用户身份权限。',
      ].join('\n'));
    }
  }

  async getGroupChatInfo(chatId: string): Promise<GroupChatInfo | null> {
    const configError = this.validateConfig();
    if (configError) throw new Error(configError);

    const restClient = this.restClient || new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.site === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      httpInstance: buildHttpInstanceWithEnvProxy(this.site),
    });

    const res = await this.withFeishuRequestTimeout<{
      code?: number;
      msg?: string;
      data?: { chat_id?: string; chat_mode?: string; name?: string };
    }>(chatId, 'im.chat.get', () => restClient.im.chat.get({
      path: { chat_id: chatId },
      params: { user_id_type: 'open_id' },
    }));

    if (res?.code && res.code !== 0) {
      if (isFeishuChatMissingResponse(res)) return null;
      throw new Error(res.msg || `Feishu get chat failed: code=${res.code}`);
    }
    const resolvedChatId = res?.data?.chat_id || chatId;
    const chatKind = normalizeFeishuChatKind(res?.data?.chat_mode);
    if (!chatKind) {
      console.warn(`[feishu-adapter] Feishu chat ${chatId} returned no usable chat_mode; treating it as unavailable for startup reconciliation.`);
      return null;
    }
    return {
      chatId: resolvedChatId,
      chatKind,
      name: res?.data?.name,
    };
  }

  async renameGroupChat(chatId: string, name: string): Promise<GroupChatInfo> {
    const configError = this.validateConfig();
    if (configError) throw new Error(configError);

    const requestedName = name.trim();
    if (!requestedName) throw new Error('Group name is required.');
    const groupName = this.formatBotPrefixedGroupName(requestedName);

    const restClient = this.restClient || new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.site === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      httpInstance: buildHttpInstanceWithEnvProxy(this.site),
    });

    const res = await this.withFeishuRequestTimeout<{
      code?: number;
      msg?: string;
      data?: { chat_id?: string; name?: string };
    }>(chatId, 'im.chat.update', () => restClient.im.chat.update({
      path: { chat_id: chatId },
      params: { user_id_type: 'open_id' },
      data: { name: groupName },
    }));

    if (res?.code && res.code !== 0) {
      throw new Error(res.msg || `Feishu update group failed: code=${res.code}`);
    }

    return {
      chatId: res?.data?.chat_id || chatId,
      chatKind: 'group',
      name: res?.data?.name || groupName,
    };
  }

  async sendCloudDocumentReply(target: CloudDocumentAddress, text: string): Promise<SendResult> {
    const configError = this.validateConfig();
    if (configError) return { ok: false, error: configError };

    const restClient = this.restClient || new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.site === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      httpInstance: buildHttpInstanceWithEnvProxy(this.site),
    });
    const safeText = stripMarkdownForDocumentComment(text).slice(0, 2000) || '（无回复内容）';
    const content: {
      elements: FeishuCommentReplyElement[];
    } = {
      elements: [
        {
          type: 'text_run',
          text_run: { text: safeText },
        },
      ],
    };

    try {
      try {
        await this.withFeishuRequestTimeout(target.fileToken, 'drive.fileCommentReply.create', () => (restClient as any).request({
          method: 'POST',
          url: `/open-apis/drive/v1/files/${encodeURIComponent(target.fileToken)}/comments/${encodeURIComponent(target.commentId)}/replies?file_type=${encodeURIComponent(target.fileType)}`,
          data: { content },
        }));
        return { ok: true };
      } catch (err) {
        const code = feishuErrorCode(err);
        if (code !== 1069302) {
          return {
            ok: false,
            error: feishuErrorSummary(err, '飞书文档评论回复失败'),
            httpStatus: feishuErrorHttpStatus(err),
          };
        }
        if (!target.isWhole) {
          return {
            ok: false,
            error: feishuErrorSummary(err, '飞书文档评论回复失败'),
            httpStatus: feishuErrorHttpStatus(err),
          };
        }
      }

      if (target.fileType !== 'doc' && target.fileType !== 'docx') {
        return {
          ok: false,
          error: `飞书 ${target.fileType} 类型评论不支持创建 fallback 顶层评论。`,
        };
      }
      const fallbackFileType: 'doc' | 'docx' = target.fileType;

      try {
        const fallbackElements: Array<
          | { type: 'mention_user'; mention_user: string }
          | { type: 'text'; text: string }
        > = [
          ...(target.operatorId
            ? [{ type: 'mention_user' as const, mention_user: target.operatorId }]
            : []),
          { type: 'text', text: `${target.operatorId ? ' ' : ''}${safeText}` },
        ];
        await this.withFeishuRequestTimeout(target.fileToken, 'drive.fileComment.create:fallback', () => (restClient as any).request({
          method: 'POST',
          url: `/open-apis/drive/v1/files/${encodeURIComponent(target.fileToken)}/new_comments`,
          data: {
            file_type: fallbackFileType,
            reply_elements: fallbackElements,
          },
        }));
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: feishuErrorSummary(err, '飞书文档评论创建失败'),
          httpStatus: feishuErrorHttpStatus(err),
        };
      }
    } finally {
      if (target.typingReactionReplyId) {
        await this.removeCloudDocumentTypingReaction(target, target.typingReactionReplyId);
      }
    }
  }

  // ── Streaming lifecycle hooks ──────────────────────────────

  /**
   * Create the streaming card as early as possible.
   * Called by bridge-manager via onMessageStart().
   */
  onMessageStart(chatId: string, streamKey?: string): void {
    if (this.isCloudDocumentChatId(chatId)) return;
    const messageId = this.lastIncomingMessageId.get(chatId);

    // Create streaming card (fire-and-forget — fallback to traditional if fails)
    if (messageId && this.isStreamingEnabled()) {
      this.createStreamingCard(chatId, messageId, streamKey).catch(() => {});
    }
  }

  /**
   * Clean up card state.
   * Called by bridge-manager via onMessageEnd().
   */
  onMessageEnd(chatId: string, streamKey?: string): void {
    if (this.isCloudDocumentChatId(chatId)) return;
    // Clean up any orphaned card state (normally cleaned by finalizeCard)
    this.cleanupCard(chatId, streamKey);
  }

  // ── Card Action Handler ─────────────────────────────────────

  /**
   * Handle card.action.trigger events (button clicks on permission cards).
   * Converts button clicks to synthetic InboundMessage with callbackData.
   * Must return within 3 seconds (Feishu timeout), so uses a 2.5s race.
   */
  private async handleCardAction(data: unknown): Promise<unknown> {
    const FALLBACK_TOAST = { toast: { type: 'info' as const, content: '已收到' } };

    try {
      const event = data as any;
      const value = event?.action?.value ?? {};
      const actionTag = event?.action?.tag;
      const optionValue = typeof event?.action?.option === 'string' ? event.action.option : '';
      const callbackData = actionTag === 'select_static' && optionValue
        ? optionValue
        : value.callback_data;

      // Extract chat/user context
      const chatId = event?.context?.open_chat_id || event?.context?.chat_id || value.chatId || '';
      const messageId = event?.context?.open_message_id
        || event?.context?.message_id
        || event?.open_message_id
        || event?.message_id
        || event?.action?.open_message_id
        || event?.action?.message_id
        || value.open_message_id
        || value.message_id
        || '';
      const userId = event?.operator?.open_id || event?.open_id || '';

      console.log('[feishu-adapter] Card action trigger received:', {
        chatId,
        messageId,
        userId,
        actionValueKeys: Object.keys(value),
        actionTag,
        hasCallbackData: Boolean(callbackData),
      });

      if (!callbackData) {
        console.warn('[feishu-adapter] Card action missing callback_data:', {
          chatId,
          messageId,
          actionValuePreview: this.previewLogValue(value),
          rawPreview: this.previewLogValue(event),
        });
        return FALLBACK_TOAST;
      }

      console.log('[feishu-adapter] Incoming card action event:', {
        chatId,
        messageId,
        userId,
        callbackData: this.previewLogValue(callbackData),
      });

      if (!chatId) return FALLBACK_TOAST;

      if (String(callbackData).trim() === FEISHU_GROUP_AUTHORIZED_CALLBACK_DATA) {
        try {
          this.persistGroupAuthorized();
          return {
            toast: {
              type: 'success' as const,
              content: '已记录授权状态',
            },
          };
        } catch (error) {
          console.error('[feishu-adapter] Failed to persist group authorization state:', error instanceof Error ? error.message : error);
          return {
            toast: {
              type: 'warning' as const,
              content: '授权状态保存失败，请稍后重试',
            },
          };
        }
      }

      const callbackMsg: import('../../domain/index.js').InboundMessage = {
        messageId: messageId || `card_action_${Date.now()}`,
        address: {
          channelType: this.channelType,
          channelProvider: this.provider,
          channelAlias: this.alias,
          chatId,
          userId,
        },
        text: '',
        timestamp: Date.now(),
        callbackData,
        callbackMessageId: messageId,
        raw: data,
      };
      this.enqueueInboundMessage(callbackMsg);
      this.logQueuedInboundMessage({
        messageId: callbackMsg.messageId,
        chatId,
        messageType: 'card.action.trigger',
        text: callbackMsg.text,
        attachmentCount: 0,
        callbackData,
      });

      return {
        toast: {
          type: 'info' as const,
          content: String(callbackData).startsWith('clk-thread-select:') ? '已选择' : '已收到，正在处理...',
        },
      };
    } catch (err) {
      console.error('[feishu-adapter] Card action handler error:', err instanceof Error ? err.message : err);
      return FALLBACK_TOAST;
    }
  }

  // ── Streaming Card (CardKit v2) ────────────────────────────────

  /**
   * Create a new streaming card and send it as a message.
   * Returns true if card was created successfully.
   */
  private createStreamingCard(chatId: string, replyToMessageId?: string, streamKey?: string): Promise<boolean> {
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    if (!this.restClient || this.activeCards.has(cardKey)) return Promise.resolve(false);

    // In-flight guard: if creation is already in progress, return the existing promise
    const existing = this.cardCreatePromises.get(cardKey);
    if (existing) return existing;

    const waitMs = this.getCardCreateWaitMs(cardKey);
    if (waitMs > 0) {
      const scheduled = this.scheduledCardCreatePromises.get(cardKey);
      if (scheduled) return scheduled;

      const promise = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          this.cardCreateRetryTimers.delete(cardKey);
          this.scheduledCardCreatePromises.delete(cardKey);
          this.createStreamingCard(chatId, replyToMessageId, cardKey).then(resolve, () => resolve(false));
        }, waitMs);
        timer.unref?.();
        this.cardCreateRetryTimers.set(cardKey, timer);
      });
      this.scheduledCardCreatePromises.set(cardKey, promise);
      return promise;
    }

    const promise = this._doCreateStreamingCard(chatId, replyToMessageId, cardKey)
      .then((ok) => {
        this.markCardCreateResult(cardKey, ok);
        return ok;
      })
      .catch((err) => {
        this.markCardCreateResult(cardKey, false);
        console.warn('[feishu-adapter] Streaming card create promise failed:', err instanceof Error ? err.message : err);
        return false;
      })
      .finally(() => this.cardCreatePromises.delete(cardKey));
    this.cardCreatePromises.set(cardKey, promise);
    return promise;
  }

  private getCongestedCardIntervalMs(consecutiveFailures: number): number {
    const maxIntervalMs = Math.max(1, this.cardFlushMaxFailureIntervalMs);
    if (consecutiveFailures >= 2) return maxIntervalMs;
    if (consecutiveFailures >= 1) return Math.min(maxIntervalMs, Math.max(1, this.cardFlushFirstFailureIntervalMs));
    return Math.min(maxIntervalMs, Math.max(1, this.cardFlushBaseIntervalMs));
  }

  private getCardCreateWaitMs(cardKey: string): number {
    const nextEarliestAt = this.cardCreateNextEarliestAt.get(cardKey) || 0;
    return Math.max(0, nextEarliestAt - Date.now());
  }

  private clearCardCreateRetryTimer(cardKey: string): void {
    const timer = this.cardCreateRetryTimers.get(cardKey);
    if (timer) clearTimeout(timer);
    this.cardCreateRetryTimers.delete(cardKey);
    this.scheduledCardCreatePromises.delete(cardKey);
  }

  private clearAllCardCreateRetryTimers(): void {
    this.cardCreateRetryTimers.forEach((timer) => clearTimeout(timer));
    this.cardCreateRetryTimers.clear();
  }

  private pendingCardCreateState(cardKey: string): PendingStreamingCardCreateState {
    const existing = this.pendingCardCreateStates.get(cardKey);
    if (existing) return existing;
    const next: PendingStreamingCardCreateState = {};
    this.pendingCardCreateStates.set(cardKey, next);
    return next;
  }

  private applyPendingCardCreateState(cardKey: string, state: FeishuCardState): void {
    const pending = this.pendingCardCreateStates.get(cardKey);
    if (!pending) return;
    this.pendingCardCreateStates.delete(cardKey);

    let dirty = false;
    if (typeof pending.text === 'string') {
      state.pendingText = pending.text;
      if (pending.text.trim()) state.thinking = false;
      dirty = true;
    }
    if (typeof pending.statusText === 'string') {
      state.pendingStatusText = pending.statusText || INITIAL_STREAMING_STATUS;
      const contextUsage = extractTerminalContextUsage(state.pendingStatusText);
      if (contextUsage) state.terminalContextUsageText = contextUsage;
      dirty = true;
    }
    if (pending.tasks) {
      state.taskItems = pending.tasks;
      state.pendingTasksText = buildStreamingTaskContent(pending.tasks) || EMPTY_STREAMING_TASKS;
      dirty = true;
    }
    if (pending.tools) {
      state.toolCalls = pending.tools;
      dirty = true;
    }
    if (pending.historyItems) {
      state.historyItems = pending.historyItems;
      state.historyDriven = pending.historyDriven ?? true;
      dirty = true;
    }
    if (!dirty) return;

    this.markStreamingDesiredDirty(state);
    this.scheduleCardFlush(cardKey);
  }

  private markCardCreateResult(cardKey: string, ok: boolean): void {
    const now = Date.now();
    if (ok) {
      this.cardCreateConsecutiveFailures.delete(cardKey);
      this.cardCreateNextEarliestAt.set(cardKey, now + this.getCongestedCardIntervalMs(0));
      return;
    }
    this.pendingCardCreateStates.delete(cardKey);
    const failures = (this.cardCreateConsecutiveFailures.get(cardKey) || 0) + 1;
    this.cardCreateConsecutiveFailures.set(cardKey, failures);
    this.cardCreateNextEarliestAt.set(cardKey, now + this.getCongestedCardIntervalMs(failures));
  }

  private async _doCreateStreamingCard(
    chatId: string,
    replyToMessageId?: string,
    streamKey?: string,
    initialState?: StreamingCardInitialState,
    flushCarry?: StreamingCardFlushCarry,
  ): Promise<boolean> {
    if (!this.restClient) return false;
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    const cardkit = (this.restClient as any).cardkit?.v1;
    if (!cardkit?.card) {
      console.warn('[feishu-adapter] CardKit v1 API is unavailable in the current Feishu SDK client');
      return false;
    }

    try {
      // Step 1: Create card via CardKit v1
      const actionRows = this.streamActionRows.get(cardKey) || [];
      const actionSummary = summarizeCardActionRows(actionRows);
      if (actionSummary.buttonCount > 0) {
        console.log('[feishu-adapter] Creating streaming card with actions:', {
          streamKey: cardKey,
          chatId,
          ...actionSummary,
        });
      }
      const initialRenderedHistoryItems = createInitialCardHistoryItems();
      const initialContent = initialState?.content ?? '💭 Thinking...';
      const initialTasksText = initialState?.tasksText ?? EMPTY_STREAMING_TASKS;
      const initialStatusText = initialState?.statusText ?? INITIAL_STREAMING_STATUS;
      const initialTools = initialState?.toolCalls ?? [];
      const initialHistoryItems = initialState
        ? initialState.historyDriven ? initialState.historyItems : undefined
        : initialRenderedHistoryItems;
      const initialMetadata = initialState?.metadata ?? this.pendingStreamMetadata.get(cardKey);
      const initialActionRows = initialState?.actionRows ?? actionRows;
      const render = buildStreamingCardRender({
        content: initialContent,
        tasksText: initialTasksText,
        statusText: initialStatusText,
        tools: initialTools,
        actionRows: initialActionRows,
        chatId,
        metadata: initialMetadata,
        historyItems: initialHistoryItems,
        historyItemOffset: initialState?.historyItemOffset,
        toolCallOffset: initialState?.toolCallOffset,
      });
      const cardBody = render.body;
      const initialCardJson = JSON.stringify(cardBody);
      const initialPayloadBytes = Buffer.byteLength(initialCardJson, 'utf8');
      console.log('[feishu-adapter] Streaming card create payload:', {
        streamKey: cardKey,
        chatId,
        componentCount: render.componentCount,
        ...summarizeCardJsonForLog(initialCardJson),
      });
      emitRealE2eStreamCardCheckpoint({
        kind: 'create',
        streamKey: cardKey,
        chatId,
        status: 'thinking',
        cardJson: initialCardJson,
      });

      const createStartedAt = Date.now();
      const createResp = await this.withFeishuRequestTimeout<{ data?: { card_id?: string } }>(cardKey, 'card.create', () => cardkit.card.create({
        data: { type: 'card_json', data: initialCardJson },
      }));
      const createCardMs = Date.now() - createStartedAt;
      const cardId = createResp?.data?.card_id;
      if (!cardId) {
        console.warn('[feishu-adapter] Card create returned no card_id');
        return false;
      }

      // Step 2: Send card as IM message
      const cardContent = JSON.stringify({ type: 'card', data: { card_id: cardId } });
      const sendStartedAt = Date.now();
      const msgResp = replyToMessageId
        ? await this.withFeishuRequestTimeout(cardKey, 'im.message.reply:interactive', () => this.restClient!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content: cardContent, msg_type: 'interactive' },
        }))
        : await this.withFeishuRequestTimeout(cardKey, 'im.message.create:interactive', () => this.restClient!.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: cardContent,
          },
        }));
      const sendMessageMs = Date.now() - sendStartedAt;

      const messageId = msgResp?.data?.message_id;
      if (!messageId) {
        console.warn('[feishu-adapter] Card message send returned no message_id');
        return false;
      }

      // Store card state
      const now = Date.now();
      const metadata = normalizeStreamMetadata(initialMetadata);
      const renderedHistory = buildStreamingHistoryRenderState(
        initialContent,
        render.tools,
        'streaming_content',
        render.historyItems,
      );
      const perf = createFeishuCardPerfStats({
        now,
        createCardMs,
        sendMessageMs,
        initialPayloadBytes,
        initialComponentCount: render.componentCount,
      });
      recordFeishuCardApiPerf(perf, 'card.create', createCardMs, 'success');
      recordFeishuCardApiPerf(
        perf,
        replyToMessageId ? 'im.message.reply:interactive' : 'im.message.create:interactive',
        sendMessageMs,
        'success',
      );
      const state: FeishuCardState = {
        chatId,
        cardId,
        messageId,
        replyToMessageId,
        sequence: 0,
        continuationIndex: initialState?.continuationIndex ?? 1,
        startTime: initialState?.startTime ?? now,
        taskItems: initialState?.taskItems ?? [],
        toolCalls: initialTools,
        historyItems: initialState?.historyItems ?? [],
        historyItemOffset: render.historyItemOffset,
        toolCallOffset: render.toolCallOffset,
        historyDriven: initialState?.historyDriven ?? false,
        thinking: initialState ? false : true,
        pendingText: initialState ? initialContent : null,
        pendingTasksText: initialTasksText,
        pendingStatusText: initialStatusText,
        terminalContextUsageText: initialState?.terminalContextUsageText ?? '',
        renderedText: buildStreamingTextContent(initialContent),
        renderedTextLayoutSignature: buildStreamingTextLayoutSignature(initialContent),
        renderedTasksText: initialTasksText,
        renderedHistoryElementIds: renderedHistory.elementIds,
        renderedHistoryElementJson: renderedHistory.elementJson,
        renderedToolSnapshots: buildRenderedToolSnapshots(render.tools),
        renderedToolEventCounts: buildRenderedToolEventCounts(render.tools),
        renderedStatusText: initialStatusText,
        renderedHistorySignature: streamingHistorySignature(initialState?.historyDriven ? render.historyItems || [] : []),
        actionRows: initialActionRows,
        renderedActionSignature: cardActionRowsSignature(initialActionRows),
        metadata,
        renderedMetadataSignature: streamMetadataSignature(metadata),
        renderedComponentCount: render.componentCount,
        desiredRevision: 0,
        shadowRevision: 0,
        shadowTrust: 'trusted',
        lastUpdateAt: 0,
        throttleTimer: null,
        flushInFlight: flushCarry?.flushInFlight ?? null,
        backgroundFlushInFlight: flushCarry?.backgroundFlushInFlight ?? null,
        flushQueued: flushCarry?.flushQueued ?? false,
        lastFlushStartedAt: flushCarry?.lastFlushStartedAt ?? null,
        nextFlushEarliestAt: null,
        lastSuccessfulFlushAt: null,
        lastFlushErrorAt: null,
        lastFlushError: null,
        consecutiveFlushFailures: 0,
        lastFullRefreshAttemptAt: now,
        lastSuccessfulFullRefreshAt: null,
        perf,
      };
      this.activeCards.set(cardKey, state);

      const latestActionRows = this.streamActionRows.get(cardKey) || [];
      if (!initialState && cardActionRowsSignature(latestActionRows) !== cardActionRowsSignature(actionRows)) {
        state.actionRows = latestActionRows;
        this.scheduleCardFlush(cardKey);
      }
      if (!initialState) {
        this.applyPendingCardCreateState(cardKey, state);
      }

      console.log(`[feishu-adapter] Streaming card created: streamKey=${cardKey}, cardId=${cardId}, msgId=${messageId}`);
      return true;
    } catch (err) {
      console.warn('[feishu-adapter] Failed to create streaming card:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  /**
   * Update streaming card content with throttling.
   */
  private updateCardContent(chatId: string, text: string, streamKey?: string): void {
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    const state = this.activeCards.get(cardKey);
    if (!state || !this.restClient) return;

    // Clear thinking state once text arrives
    if (state.thinking && text.trim()) {
      state.thinking = false;
    }
    state.pendingText = text;
    this.markStreamingDesiredDirty(state);

    this.scheduleCardFlush(cardKey);
  }

  private updateCardStatus(chatId: string, statusText: string, streamKey?: string): void {
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    const state = this.activeCards.get(cardKey);
    if (!state || !this.restClient) return;
    state.pendingStatusText = statusText || INITIAL_STREAMING_STATUS;
    const contextUsage = extractTerminalContextUsage(state.pendingStatusText);
    if (contextUsage) {
      state.terminalContextUsageText = contextUsage;
    }
    this.markStreamingDesiredDirty(state);
    this.scheduleCardFlush(cardKey);
  }

  private updateCardActions(chatId: string, actionRows: FeishuCardActionButton[][], streamKey?: string): void {
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    const normalized = normalizeCardActionRows(actionRows);
    this.streamActionRows.set(cardKey, normalized);
    console.log('[feishu-adapter] Streaming card actions updated:', {
      streamKey: cardKey,
      chatId,
      ...summarizeCardActionRows(normalized),
      activeCard: this.activeCards.has(cardKey),
    });
    const state = this.activeCards.get(cardKey);
    if (!state || !this.restClient) return;
    state.actionRows = normalized;
    this.markStreamingDesiredDirty(state);
    this.scheduleCardFlush(cardKey);
  }

  private updateCardMetadata(chatId: string, metadata: StructuredStreamingUiMetadata, streamKey?: string): void {
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    const normalized = normalizeStreamMetadata(metadata);
    this.pendingStreamMetadata.set(cardKey, normalized);
    const state = this.activeCards.get(cardKey);
    if (!state || !this.restClient) return;
    state.metadata = normalized;
    this.markStreamingDesiredDirty(state);
    this.scheduleCardFlush(cardKey);
  }

  private updateTaskProgress(chatId: string, tasks: TaskProgressInfo[], streamKey?: string): void {
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    const state = this.activeCards.get(cardKey);
    if (!state) return;
    state.taskItems = tasks;
    state.pendingTasksText = buildStreamingTaskContent(tasks) || EMPTY_STREAMING_TASKS;
    this.markStreamingDesiredDirty(state);
    this.scheduleCardFlush(cardKey);
  }

  private enqueueCardFlush(streamKey: string): void {
    const state = this.activeCards.get(streamKey);
    if (!state) return;
    if (state.flushInFlight || state.backgroundFlushInFlight) {
      this.markCardFlushQueued(state);
      return;
    }

    state.lastFlushStartedAt = Date.now();
    const flushPromise = this.flushCardUpdate(streamKey)
      .catch((err: unknown) => {
        console.warn('[feishu-adapter] cardElement.content failed:', err instanceof Error ? err.message : err);
      })
      .finally(() => {
        const current = this.activeCards.get(streamKey);
        if (!current) return;
        if (current.flushInFlight !== flushPromise) return;
        current.flushInFlight = null;
        if (current.flushQueued) {
          current.flushQueued = false;
          this.scheduleCardFlush(streamKey);
        }
      });
    state.flushInFlight = flushPromise;
  }

  private scheduleCardFlush(streamKey: string): void {
    const state = this.activeCards.get(streamKey);
    if (!state) return;
    if (state.flushInFlight || state.backgroundFlushInFlight) {
      this.markCardFlushQueued(state);
      return;
    }

    const waitMs = Math.max(0, (state.nextFlushEarliestAt || 0) - Date.now());
    if (waitMs > 0) {
      if (!state.throttleTimer) {
        state.throttleTimer = setTimeout(() => {
          const current = this.activeCards.get(streamKey);
          if (current) current.throttleTimer = null;
          this.scheduleCardFlush(streamKey);
        }, waitMs);
        state.throttleTimer.unref?.();
      }
      return;
    }

    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }
    this.enqueueCardFlush(streamKey);
  }

  private currentStreamingCardRender(
    state: FeishuCardState,
    content: string,
    tasksText: string,
    statusText: string,
    actionRows: FeishuCardActionButton[][],
    metadata: StructuredStreamingUiMetadata,
    maxComponents = STREAMING_CARD_COMPONENT_LIMIT,
  ): StreamingCardRenderResult {
    return buildStreamingCardRender({
      content,
      tasksText,
      statusText,
      tools: state.toolCalls,
      actionRows,
      chatId: state.chatId,
      metadata,
      historyItems: state.historyDriven ? state.historyItems : undefined,
      historyItemOffset: state.historyItemOffset,
      toolCallOffset: state.toolCallOffset,
      maxComponents,
    });
  }

  private shouldRolloverStreamingCard(
    state: FeishuCardState,
    content: string,
    tasksText: string,
    statusText: string,
    actionRows: FeishuCardActionButton[][],
    metadata: StructuredStreamingUiMetadata,
  ): StreamingCardRolloverOffsets | null {
    const fullRender = this.currentStreamingCardRender(
      state,
      content,
      tasksText,
      statusText,
      actionRows,
      metadata,
      Number.MAX_SAFE_INTEGER,
    );
    const payload = measureStreamingCardPayload(fullRender.body);
    const payloadReason = describeStreamingCardPayloadPressure(payload);
    if (fullRender.componentCount < STREAMING_CARD_COMPONENT_LIMIT && !payloadReason) return null;

    const reason = fullRender.componentCount >= STREAMING_CARD_COMPONENT_LIMIT
      ? 'component_count'
      : payloadReason!;
    if (state.historyDriven && state.historyItems.length > 0) {
      const renderedAbsoluteCount = state.historyItemOffset + Math.max(1, state.renderedHistoryElementIds.length);
      const nextOffset = Math.min(renderedAbsoluteCount, Math.max(0, state.historyItems.length - 1));
      if (nextOffset > state.historyItemOffset) {
        return {
          historyItemOffset: nextOffset,
          toolCallOffset: state.toolCallOffset,
          reason,
          componentCount: fullRender.componentCount,
          payload,
        };
      }
    }

    if (!state.historyDriven && state.toolCalls.length > 0) {
      const renderedToolCount = Object.keys(state.renderedToolSnapshots)
        .filter((elementId) => /^stream_tool_\d+$/.test(elementId))
        .length;
      const nextOffset = renderedToolCount < state.toolCalls.length
        ? Math.min(state.toolCallOffset + renderedToolCount, Math.max(0, state.toolCalls.length - 1))
        : state.toolCallOffset;
      return {
        historyItemOffset: state.historyItemOffset,
        toolCallOffset: nextOffset,
        reason,
        componentCount: fullRender.componentCount,
        payload,
      };
    }

    return null;
  }

  private streamingCardContinuationOffsets(
    state: FeishuCardState,
  ): { historyItemOffset: number; toolCallOffset: number } {
    if (state.historyDriven && state.historyItems.length > 0) {
      const renderedAbsoluteCount = state.historyItemOffset + Math.max(1, state.renderedHistoryElementIds.length);
      return {
        historyItemOffset: Math.min(renderedAbsoluteCount, Math.max(0, state.historyItems.length - 1)),
        toolCallOffset: state.toolCallOffset,
      };
    }
    if (!state.historyDriven && state.toolCalls.length > 0) {
      const renderedToolCount = Object.keys(state.renderedToolSnapshots)
        .filter((elementId) => /^stream_tool_\d+$/.test(elementId))
        .length;
      return {
        historyItemOffset: state.historyItemOffset,
        toolCallOffset: renderedToolCount < state.toolCalls.length
          ? Math.min(state.toolCallOffset + renderedToolCount, Math.max(0, state.toolCalls.length - 1))
          : state.toolCallOffset,
      };
    }
    return {
      historyItemOffset: state.historyItemOffset,
      toolCallOffset: state.toolCallOffset,
    };
  }

  private async rolloverStreamingCard(
    streamKey: string,
    state: FeishuCardState,
    offsets: { historyItemOffset: number; toolCallOffset: number },
    content: string,
    tasksText: string,
    statusText: string,
    actionRows: FeishuCardActionButton[][],
    metadata: StructuredStreamingUiMetadata,
    reason = 'component_count',
  ): Promise<boolean> {
    const cardkit = (this.restClient as any)?.cardkit?.v1;
    if (!cardkit?.card?.settings) return false;

    try {
      state.sequence += 1;
      const settingsResult = await this.withFeishuRequestTimeout(streamKey, 'card.settings:rollover', () => cardkit.card.settings({
        path: { card_id: state.cardId },
        data: {
          settings: JSON.stringify({ streaming_mode: false }),
          sequence: state.sequence,
        },
      }));
      assertFeishuApiOk(settingsResult, 'card.settings:rollover');
      await this.finalizeRolloverSourceCard(streamKey, state);
    } catch (error) {
      this.markCardFlushFailure(state, error);
      console.warn('[feishu-adapter] Failed to close saturated streaming card before rollover:', error instanceof Error ? error.message : error);
      return false;
    }

    const nextInitialState: StreamingCardInitialState = {
      content,
      tasksText,
      statusText,
      taskItems: state.taskItems,
      toolCalls: state.toolCalls,
      historyItems: state.historyItems,
      historyDriven: state.historyDriven,
      metadata,
      actionRows,
      terminalContextUsageText: state.terminalContextUsageText,
      historyItemOffset: offsets.historyItemOffset,
      toolCallOffset: offsets.toolCallOffset,
      continuationIndex: state.continuationIndex + 1,
      startTime: state.startTime,
    };

    const flushCarry: StreamingCardFlushCarry = {
      flushInFlight: state.flushInFlight,
      backgroundFlushInFlight: state.backgroundFlushInFlight,
      flushQueued: state.flushQueued,
      lastFlushStartedAt: state.lastFlushStartedAt,
    };
    const created = await this._doCreateStreamingCard(
      state.chatId,
      state.replyToMessageId,
      streamKey,
      nextInitialState,
      flushCarry,
    );
    if (created) {
      console.log('[feishu-adapter] Streaming card rolled over after threshold:', {
        streamKey,
        previousCardId: state.cardId,
        nextIndex: nextInitialState.continuationIndex,
        historyItemOffset: offsets.historyItemOffset,
        toolCallOffset: offsets.toolCallOffset,
        reason,
      });
      return true;
    }

    this.activeCards.set(streamKey, state);
    return false;
  }

  private async forceStreamingCardContinuationRollover(
    streamKey: string,
    state: FeishuCardState,
    content: string,
    tasksText: string,
    statusText: string,
    actionRows: FeishuCardActionButton[][],
    metadata: StructuredStreamingUiMetadata,
    reason: string,
  ): Promise<boolean> {
    // 飞书 200850/payload 限制不是组件数问题；从“上一个已渲染 group”后续接，保留当前正在更新的 group。
    const offsets = this.streamingCardContinuationOffsets(state);
    console.log('[feishu-adapter] Streaming card forcing continuation rollover:', {
      streamKey,
      cardId: state.cardId,
      reason,
      historyItemOffset: offsets.historyItemOffset,
      toolCallOffset: offsets.toolCallOffset,
    });
    return this.rolloverStreamingCard(
      streamKey,
      state,
      offsets,
      content,
      tasksText,
      statusText,
      actionRows,
      metadata,
      reason,
    );
  }

  private async finalizeRolloverSourceCard(
    streamKey: string,
    state: FeishuCardState,
  ): Promise<void> {
    const cardElement = (this.restClient as any)?.cardkit?.v1?.cardElement;
    if (typeof cardElement?.content !== 'function') return;
    const statusText = [
      '已续接到下一条',
      formatElapsed(Date.now() - state.startTime),
      resolveTerminalContextUsage(state),
    ].filter(Boolean).join(' · ');
    try {
      state.sequence += 1;
      const result = await this.withFeishuRequestTimeout(streamKey, 'cardElement.content:streaming_status:rollover', () => cardElement.content({
        path: { card_id: state.cardId, element_id: 'streaming_status' },
        data: { content: statusText, sequence: state.sequence },
      }));
      assertFeishuApiOk(result, 'cardElement.content:streaming_status:rollover');
      state.renderedStatusText = statusText;
      this.markCardFlushSuccess(state);
    } catch (error) {
      this.markCardFlushFailure(state, error);
      console.warn('[feishu-adapter] Failed to finalize saturated streaming card status before rollover:', error instanceof Error ? error.message : error);
    }
  }

  private async resetSaturatedStreamingCard(
    streamKey: string,
    state: FeishuCardState,
    content: string,
    tasksText: string,
    statusText: string,
    actionRows: FeishuCardActionButton[][],
    metadata: StructuredStreamingUiMetadata,
    desiredRevision = state.desiredRevision,
  ): Promise<boolean> {
    const offsets = this.streamingCardContinuationOffsets(state);
    const rolled = await this.rolloverStreamingCard(
      streamKey,
      state,
      offsets,
      content,
      tasksText,
      statusText,
      actionRows,
      metadata,
      'saturated_card',
    );
    if (rolled) return true;
    return this.flushFullCardRefresh(streamKey, state, content, tasksText, statusText, actionRows, metadata, desiredRevision);
  }

  private markStreamingDesiredDirty(state: FeishuCardState): void {
    state.desiredRevision += 1;
  }

  private snapshotStreamingDesiredState(state: FeishuCardState): StreamingDesiredSnapshot {
    const rawContent = state.pendingText || '';
    const actionRows = state.actionRows || [];
    const metadata = normalizeStreamMetadata(state.metadata);
    return {
      revision: state.desiredRevision,
      rawContent,
      content: buildStreamingTextContent(rawContent),
      contentLayoutSignature: buildStreamingTextLayoutSignature(rawContent),
      tasksText: state.pendingTasksText || EMPTY_STREAMING_TASKS,
      statusText: state.pendingStatusText || INITIAL_STREAMING_STATUS,
      actionRows,
      actionSignature: cardActionRowsSignature(actionRows),
      metadata,
      metadataSignature: streamMetadataSignature(metadata),
    };
  }

  private buildDesiredRenderSnapshot(
    state: FeishuCardState,
    snapshot: StreamingDesiredSnapshot,
  ): StreamingDesiredRenderSnapshot {
    const render = this.currentStreamingCardRender(
      state,
      snapshot.rawContent,
      snapshot.tasksText,
      snapshot.statusText,
      snapshot.actionRows,
      snapshot.metadata,
    );
    return {
      desired: snapshot,
      render,
      history: buildStreamingHistoryRenderState(
        snapshot.rawContent,
        render.tools,
        'streaming_content',
        render.historyItems,
      ),
      historySignature: streamingHistorySignature(render.historyItems || []),
    };
  }

  private logStreamingSyncPlan(streamKey: string, state: FeishuCardState, plan: StreamingSyncPlan): void {
    console.log('[feishu-adapter] Streaming sync plan:', {
      event: 'perf.card.sync_plan',
      streamKey,
      stream_key: streamKey,
      cardId: state.cardId,
      card_id: state.cardId,
      desiredRevision: plan.snapshot.revision,
      desired_revision: plan.snapshot.revision,
      shadowRevision: state.shadowRevision,
      shadow_revision: state.shadowRevision,
      shadowTrust: state.shadowTrust,
      shadow_trust: state.shadowTrust,
      kind: plan.kind,
      operation: plan.kind,
      reason: plan.reason,
      full_refresh_reason: plan.kind === 'fullRefresh' ? plan.reason : undefined,
      actionCount: plan.kind === 'batchUpdate' ? plan.actions.length : 0,
      action_count: plan.kind === 'batchUpdate' ? plan.actions.length : 0,
      incrementalActionCount: plan.diagnostics.incrementalActionCount,
      incremental_action_count: plan.diagnostics.incrementalActionCount,
      incrementalActionKinds: plan.diagnostics.incrementalActionKinds,
      incremental_action_kinds: plan.diagnostics.incrementalActionKinds,
      incrementalElementIds: plan.diagnostics.incrementalElementIds,
      incremental_element_ids: plan.diagnostics.incrementalElementIds,
      desiredComponentCount: plan.diagnostics.desiredComponentCount,
      desired_component_count: plan.diagnostics.desiredComponentCount,
      directRefreshThreshold: plan.diagnostics.directRefreshThreshold,
      direct_refresh_threshold: plan.diagnostics.directRefreshThreshold,
      directRefreshRule: plan.diagnostics.directRefreshRule,
      direct_refresh_rule: plan.diagnostics.directRefreshRule,
      containsUserTextUpdate: plan.diagnostics.containsUserTextUpdate,
      contains_user_text_update: plan.diagnostics.containsUserTextUpdate,
      trustAfterSuccess: plan.kind === 'batchUpdate' ? plan.trustAfterSuccess : undefined,
      trust_after_success: plan.kind === 'batchUpdate' ? plan.trustAfterSuccess : undefined,
    });
  }

  private planStreamingSync(
    state: FeishuCardState,
    desiredRender: StreamingDesiredRenderSnapshot,
  ): StreamingSyncPlan {
    const snapshot = desiredRender.desired;
    const desiredHistory = desiredRender.history;
    const historySignature = desiredRender.historySignature;
    const historyAppendPlan = state.historyDriven
      ? buildStreamingHistoryAppendOperations(state, desiredHistory)
      : { operations: [], requiresFullRefresh: false };
    const toolAppendPlan = state.historyDriven
      ? { operations: [], requiresFullRefresh: false }
      : buildStreamingToolAppendOperations(state, desiredHistory, desiredRender.render.tools);
    const diagnosticsFor = (
      updates: StreamingUpdateOperation[] = [],
      directRefreshRule?: StreamingSyncPlanDiagnostics['directRefreshRule'],
    ): StreamingSyncPlanDiagnostics => ({
      desiredComponentCount: desiredRender.render.componentCount,
      directRefreshThreshold: STREAMING_CARD_DIRECT_REFRESH_COMPONENT_THRESHOLD,
      incrementalActionCount: updates.length,
      incrementalActionKinds: updates.map((update) => update.kind),
      incrementalElementIds: updates.map((update) => update.elementId),
      containsUserTextUpdate: updates.some(streamingUpdateTouchesUserText),
      ...(directRefreshRule ? { directRefreshRule } : {}),
    });

    let fullRefreshReason: string | null = null;
    if (state.shadowTrust !== 'trusted') {
      fullRefreshReason = `shadow_${state.shadowTrust}`;
    } else if (snapshot.actionSignature !== state.renderedActionSignature) {
      fullRefreshReason = 'action_signature_changed';
    } else if (snapshot.metadataSignature !== state.renderedMetadataSignature) {
      fullRefreshReason = 'metadata_signature_changed';
    } else if (snapshot.contentLayoutSignature !== state.renderedTextLayoutSignature) {
      fullRefreshReason = 'content_layout_signature_changed';
    } else if (historyAppendPlan.requiresFullRefresh) {
      fullRefreshReason = 'history_append_requires_full_refresh';
    } else if (toolAppendPlan.requiresFullRefresh) {
      fullRefreshReason = 'tool_append_requires_full_refresh';
    } else if (!state.historyDriven && historySignature !== state.renderedHistorySignature) {
      fullRefreshReason = 'history_signature_changed';
    } else if (!state.historyDriven && this.shouldFullRefreshCard(state, Date.now())) {
      fullRefreshReason = 'periodic_refresh';
    }

    if (fullRefreshReason) {
      return {
        kind: 'fullRefresh',
        reason: fullRefreshReason,
        snapshot,
        diagnostics: diagnosticsFor(),
      };
    }

    const updates: StreamingUpdateOperation[] = [];
    if (!state.historyDriven && snapshot.content !== state.renderedText) {
      updates.push({
        kind: 'content',
        elementId: 'streaming_content',
        content: snapshot.content,
        onSuccess: () => {
          state.renderedText = snapshot.content;
          state.renderedHistoryElementJson.streaming_content = desiredHistory.elementJson.streaming_content || state.renderedHistoryElementJson.streaming_content;
        },
      });
    }

    for (const operation of [...historyAppendPlan.operations, ...toolAppendPlan.operations]) {
      updates.push({
        kind: operation.kind,
        elementId: operation.elementId,
        targetElementId: operation.targetElementId,
        element: operation.element,
        elementJson: operation.elementJson,
        content: operation.content,
        partialElement: operation.partialElement,
        snapshot: operation.snapshot,
        eventCount: operation.eventCount,
        onSuccess: () => {
          if (!state.renderedHistoryElementIds.includes(operation.elementId) && operation.targetElementId === 'stream_history') {
            state.renderedHistoryElementIds.push(operation.elementId);
          }
          const historyElementId = operation.targetElementId === 'stream_history'
            ? operation.elementId
            : operation.kind === 'content'
              ? operation.elementId
              : operation.kind === 'patch'
                ? operation.elementId
                : operation.targetElementId;
          if (historyElementId) {
            state.renderedHistoryElementJson[historyElementId] = operation.elementJson;
          }
          const toolElementId = operation.targetElementId === 'stream_history' ? operation.elementId : operation.targetElementId;
          if (toolElementId && operation.snapshot) {
            state.renderedToolSnapshots[toolElementId] = operation.snapshot;
          }
          if (toolElementId && operation.eventCount) {
            state.renderedToolEventCounts[toolElementId] = operation.eventCount;
          }
          if (renderedHistoryMatchesDesired(state, desiredHistory)) {
            state.renderedHistorySignature = historySignature;
          }
        },
      });
    }

    if (snapshot.tasksText !== state.renderedTasksText) {
      updates.push({
        kind: 'content',
        elementId: 'streaming_tasks',
        content: snapshot.tasksText,
        onSuccess: () => {
          state.renderedTasksText = snapshot.tasksText;
        },
      });
    }
    if (snapshot.statusText !== state.renderedStatusText) {
      updates.push({
        kind: 'content',
        elementId: 'streaming_status',
        content: snapshot.statusText,
        onSuccess: () => {
          state.renderedStatusText = snapshot.statusText;
        },
      });
    }

    if (updates.length === 0) {
      return { kind: 'noop', reason: 'desired_matches_shadow', snapshot, diagnostics: diagnosticsFor(updates) };
    }

    const containsUserTextUpdate = updates.some(streamingUpdateTouchesUserText);
    const hasBatchUpdateCandidate = streamingUpdatesHaveBatchUpdateCandidate(updates);
    const directRefreshRule = containsUserTextUpdate
      ? 'user_text'
      : hasBatchUpdateCandidate && desiredRender.render.componentCount <= STREAMING_CARD_DIRECT_REFRESH_COMPONENT_THRESHOLD
        ? 'small_card'
        : null;
    if (directRefreshRule) {
      return {
        kind: 'fullRefresh',
        reason: directRefreshRule === 'user_text'
          ? 'direct_refresh_user_text'
          : 'direct_refresh_small_card',
        snapshot,
        diagnostics: diagnosticsFor(updates, directRefreshRule),
      };
    }

    return {
      kind: 'batchUpdate',
      reason: 'incremental_diff',
      snapshot,
      actions: updates,
      desiredHistory,
      historySignature,
      trustAfterSuccess: updates.some((update) => update.kind === 'patch') ? 'weak' : 'trusted',
      diagnostics: diagnosticsFor(updates),
    };
  }

  /**
   * Flush pending card update to Feishu API.
   */
  private async flushCardUpdate(streamKey: string): Promise<void> {
    const state = this.activeCards.get(streamKey);
    if (!state || !this.restClient) return;
    const cardkit = (this.restClient as any).cardkit?.v1;
    if (!cardkit?.cardElement?.content) return;

    const snapshot = this.snapshotStreamingDesiredState(state);
    const rolloverOffsets = this.shouldRolloverStreamingCard(
      state,
      snapshot.rawContent,
      snapshot.tasksText,
      snapshot.statusText,
      snapshot.actionRows,
      snapshot.metadata,
    );
    if (rolloverOffsets) {
      console.log('[feishu-adapter] Streaming card threshold reached; opening continuation card:', {
        streamKey,
        cardId: state.cardId,
        reason: rolloverOffsets.reason,
        componentCount: rolloverOffsets.componentCount,
        component_count: rolloverOffsets.componentCount,
        payloadBytes: rolloverOffsets.payload?.payloadBytes,
        payload_bytes: rolloverOffsets.payload?.payloadBytes,
        payloadChars: rolloverOffsets.payload?.payloadChars,
        payload_chars: rolloverOffsets.payload?.payloadChars,
        markdownCount: rolloverOffsets.payload?.markdownCount,
        markdown_count: rolloverOffsets.payload?.markdownCount,
        limit: STREAMING_CARD_COMPONENT_LIMIT,
        payloadBytesLimit: STREAMING_CARD_PAYLOAD_BYTES_LIMIT,
        payload_bytes_limit: STREAMING_CARD_PAYLOAD_BYTES_LIMIT,
        payloadCharsLimit: STREAMING_CARD_PAYLOAD_CHARS_LIMIT,
        payload_chars_limit: STREAMING_CARD_PAYLOAD_CHARS_LIMIT,
        markdownCountLimit: STREAMING_CARD_MARKDOWN_COUNT_LIMIT,
        markdown_count_limit: STREAMING_CARD_MARKDOWN_COUNT_LIMIT,
      });
      const rolled = await this.rolloverStreamingCard(
        streamKey,
        state,
        rolloverOffsets,
        snapshot.rawContent,
        snapshot.tasksText,
        snapshot.statusText,
        snapshot.actionRows,
        snapshot.metadata,
        rolloverOffsets.reason,
      );
      if (rolled) return;
    }
    const projectedRender = this.currentStreamingCardRender(
      state,
      snapshot.rawContent,
      snapshot.tasksText,
      snapshot.statusText,
      snapshot.actionRows,
      snapshot.metadata,
      Number.MAX_SAFE_INTEGER,
    );
    const observedComponentCount = Math.max(state.renderedComponentCount, projectedRender.componentCount);
    if (observedComponentCount >= STREAMING_CARD_COMPONENT_LIMIT - 10) {
      console.log('[feishu-adapter] Streaming card component count approaching rollover threshold:', {
        streamKey,
        cardId: state.cardId,
        componentCount: observedComponentCount,
        limit: STREAMING_CARD_COMPONENT_LIMIT,
      });
    }

    const desiredRender = this.buildDesiredRenderSnapshot(state, snapshot);
    const plan = this.planStreamingSync(state, desiredRender);
    this.logStreamingSyncPlan(streamKey, state, plan);
    if (plan.kind === 'noop') {
      state.perf.noopCount += 1;
      return;
    }
    state.perf.flushAttempts += 1;
    if (plan.kind === 'fullRefresh') {
      state.perf.fullRefreshCount += 1;
      state.perf.fullRefreshReasons[plan.reason] = (state.perf.fullRefreshReasons[plan.reason] || 0) + 1;
      const refreshed = await this.flushFullCardRefresh(
        streamKey,
        state,
        plan.snapshot.rawContent,
        plan.snapshot.tasksText,
        plan.snapshot.statusText,
        plan.snapshot.actionRows,
        plan.snapshot.metadata,
        plan.snapshot.revision,
      );
      if (refreshed) {
        state.perf.flushSuccesses += 1;
        if (state.desiredRevision !== snapshot.revision) {
          this.markCardFlushQueued(state);
        }
        return;
      }
      state.perf.flushFailures += 1;
      if (state.desiredRevision !== snapshot.revision) {
        this.markCardFlushQueued(state);
      }
      return;
    }

    state.perf.batchUpdateCount += 1;
    const failuresBefore = state.consecutiveFlushFailures;
    await this.executeStreamingSyncPlan(streamKey, state, cardkit, plan);
    if (state.desiredRevision !== snapshot.revision) {
      this.markCardFlushQueued(state);
    }
    if (state.consecutiveFlushFailures > failuresBefore) {
      state.perf.flushFailures += 1;
    } else {
      state.perf.flushSuccesses += 1;
    }
  }

  private async executeStreamingSyncPlan(
    streamKey: string,
    state: FeishuCardState,
    cardkit: any,
    plan: StreamingBatchUpdatePlan,
  ): Promise<void> {
    const updates = plan.actions;
    const projectedComponentCount = updates.reduce(
      (count, update) => count + countStreamingUpdateComponentDelta(update),
      state.renderedComponentCount,
    );
    if (projectedComponentCount >= STREAMING_CARD_COMPONENT_LIMIT) {
      console.log('[feishu-adapter] Streaming card component threshold reached; opening continuation card:', {
        streamKey,
        cardId: state.cardId,
        currentComponentCount: state.renderedComponentCount,
        projectedComponentCount,
        limit: STREAMING_CARD_COMPONENT_LIMIT,
      });
      const reset = await this.resetSaturatedStreamingCard(
        streamKey,
        state,
        plan.snapshot.rawContent,
        plan.snapshot.tasksText,
        plan.snapshot.statusText,
        plan.snapshot.actionRows,
        plan.snapshot.metadata,
        plan.snapshot.revision,
      );
      if (reset) return;
      console.warn('[feishu-adapter] Skipping streaming card update because it would exceed the component limit:', {
        streamKey,
        cardId: state.cardId,
        currentComponentCount: state.renderedComponentCount,
        projectedComponentCount,
        limit: STREAMING_CARD_COMPONENT_LIMIT,
      });
      return;
    }

    const cardId = state.cardId;
    for (let index = 0; index < updates.length; index += 1) {
      const update = updates[index]!;
      state.sequence++;
      try {
        const batchableUpdates: typeof updates = [];
        if (update.kind === 'create' || update.kind === 'patch') {
          for (let batchIndex = index; batchIndex < updates.length; batchIndex += 1) {
            const item = updates[batchIndex]!;
            if (item.kind !== 'create' && item.kind !== 'patch') break;
            batchableUpdates.push(item);
          }
        }
        if (
          batchableUpdates.length > 0
          && (batchableUpdates.length > 1 || batchableUpdates.some((item) => item.kind === 'patch'))
          && typeof cardkit.card?.batchUpdate === 'function'
        ) {
          const actions = batchableUpdates.map((item) => {
            if (item.kind === 'patch') {
              if (!item.partialElement) throw new Error('batch patch partialElement is unavailable');
              return {
                action: 'partial_update_element',
                element_id: item.elementId,
                partial_element: JSON.stringify(item.partialElement),
              };
            }
            if (!item.element) throw new Error('batch create element is unavailable');
            const action: Record<string, unknown> = {
              action: 'add_elements',
              type: 'append',
              elements: JSON.stringify([item.element]),
            };
            if (item.targetElementId) action.target_element_id = item.targetElementId;
            return action;
          });
          const batchStartedAt = Date.now();
          const result = await this.withFeishuRequestTimeout(streamKey, `card.batchUpdate:${batchableUpdates.map((item) => item.elementId).join(',')}`, () => cardkit.card.batchUpdate({
            path: { card_id: cardId },
            data: {
              actions: JSON.stringify(actions),
              sequence: state.sequence,
            },
          }));
          const batchDurationMs = Date.now() - batchStartedAt;
          assertFeishuApiOk(result, 'card.batchUpdate');
          for (const item of batchableUpdates) {
            emitRealE2eStreamCardCheckpoint({
              kind: 'element',
              streamKey,
              cardId,
              elementId: item.elementId,
              status: 'streaming',
              sequence: state.sequence,
              markdownTexts: item.content ? [item.content] : undefined,
            });
            item.onSuccess();
            state.renderedComponentCount += countStreamingUpdateComponentDelta(item);
          }
          this.markCardFlushSuccess(state);
          const hasHighRiskAction = batchableUpdates.some((item) => item.kind === 'patch');
          state.shadowTrust = batchDurationMs >= CARD_SLOW_BATCH_REFRESH_THRESHOLD_MS || hasHighRiskAction
            ? 'weak'
            : plan.trustAfterSuccess;
          if (state.shadowTrust === 'weak') {
            console.log('[feishu-adapter] Streaming batch shadow downgraded:', {
              streamKey,
              cardId,
              durationMs: batchDurationMs,
              hasHighRiskAction,
              thresholdMs: CARD_SLOW_BATCH_REFRESH_THRESHOLD_MS,
            });
          }
          if (index >= updates.length - 1) {
            state.shadowRevision = plan.snapshot.revision;
          }
          index += batchableUpdates.length - 1;
          if (state.desiredRevision !== plan.snapshot.revision) {
            this.markCardFlushQueued(state);
            break;
          }
          if (index < updates.length - 1) {
            this.markCardFlushQueued(state);
            break;
          }
          continue;
        }

        if (update.kind === 'content') {
          const sequence = state.sequence;
          const backgroundPromise = this.dispatchFeishuRequestInBackground(
            streamKey,
            `cardElement.content:${update.elementId}`,
            () => cardkit.cardElement.content({
              path: { card_id: cardId, element_id: update.elementId },
              data: { content: update.content || '', sequence },
            }),
            {
              onSuccess: () => {
                const current = this.activeCards.get(streamKey);
                if (!current || current.cardId !== cardId) return;
                emitRealE2eStreamCardCheckpoint({
                  kind: 'element',
                  streamKey,
                  cardId,
                  elementId: update.elementId,
                  status: 'streaming',
                  sequence,
                  markdownTexts: update.content ? [update.content] : undefined,
                });
                update.onSuccess();
                current.renderedComponentCount += countStreamingUpdateComponentDelta(update);
                this.markCardFlushSuccess(current);
                current.shadowTrust = 'trusted';
                if (index >= updates.length - 1) {
                  current.shadowRevision = plan.snapshot.revision;
                }
                if (current.desiredRevision !== plan.snapshot.revision || index < updates.length - 1) {
                  this.markCardFlushQueued(current);
                }
              },
              onError: (err) => {
                const current = this.activeCards.get(streamKey);
                if (!current || current.cardId !== cardId) return;
                if (isFeishuCardPayloadLimitError(err)) {
                  void this.forceStreamingCardContinuationRollover(
                    streamKey,
                    current,
                    plan.snapshot.rawContent,
                    plan.snapshot.tasksText,
                    plan.snapshot.statusText,
                    plan.snapshot.actionRows,
                    plan.snapshot.metadata,
                    'feishu_200850',
                  ).then((rolled) => {
                    if (rolled) return;
                    const latest = this.activeCards.get(streamKey);
                    if (!latest || latest.cardId !== cardId) return;
                    this.markCardFlushFailure(latest, err);
                    this.markCardFlushQueued(latest);
                  });
                  return;
                }
                this.markCardFlushFailure(current, err);
                console.warn(
                  `[feishu-adapter] cardElement.${update.kind} failed for ${update.elementId}:`,
                  err instanceof Error ? err.message : err,
                );
                this.markCardFlushQueued(current);
              },
            },
          );
          state.backgroundFlushInFlight = backgroundPromise;
          backgroundPromise.finally(() => {
            const current = this.activeCards.get(streamKey);
            if (!current || current.backgroundFlushInFlight !== backgroundPromise) return;
            current.backgroundFlushInFlight = null;
            if (current.flushQueued) {
              current.flushQueued = false;
              this.scheduleCardFlush(streamKey);
            }
          });
          break;
        }

        if (update.kind === 'create') {
          if (!cardkit.cardElement?.create || !update.element) {
            throw new Error('cardElement.create is unavailable');
          }
          const result = await this.withFeishuRequestTimeout(streamKey, `cardElement.create:${update.elementId}`, () => cardkit.cardElement.create({
            path: { card_id: cardId },
            data: {
              type: 'append',
              ...(update.targetElementId ? { target_element_id: update.targetElementId } : {}),
              elements: JSON.stringify([update.element]),
              sequence: state.sequence,
            },
          }));
          assertFeishuApiOk(result, `cardElement.create:${update.elementId}`);
        } else if (update.kind === 'patch') {
          if (!cardkit.cardElement?.patch || !update.partialElement) {
            throw new Error('cardElement.patch is unavailable');
          }
          const result = await this.withFeishuRequestTimeout(streamKey, `cardElement.patch:${update.elementId}`, () => cardkit.cardElement.patch({
            path: { card_id: cardId, element_id: update.elementId },
            data: {
              partial_element: JSON.stringify(update.partialElement),
              sequence: state.sequence,
            },
          }));
          assertFeishuApiOk(result, `cardElement.patch:${update.elementId}`);
        }
        emitRealE2eStreamCardCheckpoint({
          kind: 'element',
          streamKey,
          cardId,
          elementId: update.elementId,
          status: 'streaming',
          sequence: state.sequence,
          markdownTexts: update.content ? [update.content] : undefined,
        });
        update.onSuccess();
        state.renderedComponentCount += countStreamingUpdateComponentDelta(update);
        this.markCardFlushSuccess(state);
        state.shadowTrust = update.kind === 'patch' ? 'weak' : 'trusted';
        if (index >= updates.length - 1) {
          state.shadowRevision = plan.snapshot.revision;
        }
        if (state.desiredRevision !== plan.snapshot.revision) {
          this.markCardFlushQueued(state);
          break;
        }
        if (index < updates.length - 1) {
          this.markCardFlushQueued(state);
          break;
        }
      } catch (err) {
        if (isFeishuCardPayloadLimitError(err)) {
          const rolled = await this.forceStreamingCardContinuationRollover(
            streamKey,
            state,
            plan.snapshot.rawContent,
            plan.snapshot.tasksText,
            plan.snapshot.statusText,
            plan.snapshot.actionRows,
            plan.snapshot.metadata,
            'feishu_200850',
          );
          if (rolled) return;
        } else if (isFeishuCardElementLimitError(err)) {
          const reset = await this.resetSaturatedStreamingCard(
            streamKey,
            state,
            plan.snapshot.rawContent,
            plan.snapshot.tasksText,
            plan.snapshot.statusText,
            plan.snapshot.actionRows,
            plan.snapshot.metadata,
            plan.snapshot.revision,
          );
          if (reset) return;
        } else if (update.kind === 'create') {
          const refreshed = await this.flushFullCardRefresh(
            streamKey,
            state,
            plan.snapshot.rawContent,
            plan.snapshot.tasksText,
            plan.snapshot.statusText,
            plan.snapshot.actionRows,
            plan.snapshot.metadata,
            plan.snapshot.revision,
          );
          if (refreshed) return;
        }
        this.markCardFlushFailure(state, err);
        console.warn(
          `[feishu-adapter] cardElement.${update.kind} failed for ${update.elementId}:`,
          err instanceof Error ? err.message : err,
        );
        this.markCardFlushQueued(state);
        break;
      }
    }
  }

  /**
   * Update tool progress in the streaming card.
   */
  private updateToolProgress(chatId: string, tools: ToolCallInfo[], streamKey?: string): void {
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    const state = this.activeCards.get(cardKey);
    if (!state) return;
    state.toolCalls = tools;
    this.markStreamingDesiredDirty(state);
    this.scheduleCardFlush(cardKey);
  }

  private updateStreamingHistory(chatId: string, items: StreamingHistoryItem[], streamKey?: string): void {
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    const state = this.activeCards.get(cardKey);
    if (!state) return;
    state.historyItems = items;
    state.historyDriven = true;
    this.markStreamingDesiredDirty(state);
    this.scheduleCardFlush(cardKey);
  }

  private async awaitCardFlushCompletion(
    streamKey: string,
    timeoutMs = this.getCardRequestTimeoutMs() + Math.max(0, this.cardFinalizeFlushWaitExtraMs),
  ): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      const state = this.activeCards.get(streamKey);
      if (!state) return true;
      const inFlight = state.flushInFlight;
      if (inFlight) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) return false;
        const timedOut = Symbol('flush-timeout');
        try {
          const result = await Promise.race([
            inFlight.then(() => null),
            new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), remainingMs)),
          ]);
          if (result === timedOut) return false;
        } catch {
          // best effort only
        }
        continue;
      }
      const backgroundInFlight = state.backgroundFlushInFlight;
      if (backgroundInFlight) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) return false;
        const timedOut = Symbol('background-flush-timeout');
        try {
          const result = await Promise.race([
            backgroundInFlight.then(() => null),
            new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), remainingMs)),
          ]);
          if (result === timedOut) return false;
        } catch {
          // best effort only
        }
        continue;
      }
      if (Date.now() >= deadline) return false;
      if (state.flushQueued) {
        state.flushQueued = false;
        this.scheduleCardFlush(streamKey);
        continue;
      }
      return true;
    }
  }

  /**
   * Finalize the streaming card: close streaming mode, update with final content + footer.
   */
  private async finalizeCard(
    chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    responseText: string,
    streamKey?: string,
  ): Promise<boolean> {
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    // Wait for in-flight card creation to complete before finalizing
    const pending = this.cardCreatePromises.get(cardKey);
    if (pending) {
      try { await pending; } catch { /* creation failed — no card to finalize */ }
    }

    const state = this.activeCards.get(cardKey);
    if (!state || !this.restClient) return false;
    const cardkit = (this.restClient as any).cardkit?.v1;
    if (!cardkit?.card?.settings || !cardkit?.card?.update) return false;

    // Clear any pending throttle timer
    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }
    const finalizeWaitStartedAt = Date.now();
    const flushed = await this.awaitCardFlushCompletion(cardKey);
    state.perf.finalizeWaitMs = Date.now() - finalizeWaitStartedAt;
    if (!flushed) {
      console.warn(`[feishu-adapter] Card finalize proceeding after flush wait timeout: streamKey=${cardKey}`);
      state.flushInFlight = null;
      state.flushQueued = false;
    }

    let terminalReactionEmoji: string | null = null;
    let streamingModeClosed = false;
    try {
      // Step 1: Close streaming mode
      state.sequence++;
      const settingsStartedAt = Date.now();
      const settingsResult = await this.withFeishuRequestTimeout(cardKey, 'card.settings', () => cardkit.card.settings({
        path: { card_id: state.cardId },
        data: {
          settings: JSON.stringify({ streaming_mode: false }),
          sequence: state.sequence,
        },
      }));
      state.perf.settingsMs = Date.now() - settingsStartedAt;
      assertFeishuApiOk(settingsResult, 'card.settings');
      streamingModeClosed = true;

      // Step 2: Build and apply final card
      const statusLabels: Record<string, string> = {
        completed: '✅ Completed',
        interrupted: '⚠️ Interrupted',
        error: '❌ Error',
      };
      const elapsedMs = Date.now() - state.startTime;
      const footer = {
        status: statusLabels[status] || status,
        elapsed: formatElapsed(elapsedMs),
        context: resolveTerminalContextUsage(state),
      };

      const existingText = state.pendingText || '';
      const trimmedExisting = existingText.trim();
      const trimmedResponse = responseText.trim();
      let finalText = trimmedResponse || trimmedExisting;
      if (trimmedExisting && trimmedResponse && trimmedResponse !== trimmedExisting && !trimmedExisting.includes(trimmedResponse)) {
        finalText = `${trimmedExisting}\n\n${trimmedResponse}`;
      }

      let finalTools = visibleStreamingToolCalls(state);
      let finalHistoryItems = visibleStreamingHistoryItems(state);
      let finalCardJson = '';
      let finalComponentCount = 0;
      while (true) {
        finalCardJson = buildFinalCardJson(
          finalText,
          state.taskItems,
          finalTools,
          footer,
          status,
          state.actionRows,
          state.chatId,
          state.metadata,
          finalHistoryItems,
        );
        finalComponentCount = countFeishuCardComponents(JSON.parse(finalCardJson));
        if (finalComponentCount <= STREAMING_CARD_COMPONENT_LIMIT) break;
        if (finalHistoryItems && finalHistoryItems.length > 1) {
          finalHistoryItems = finalHistoryItems.slice(1);
          continue;
        }
        if (!finalHistoryItems && finalTools.length > 0) {
          finalTools = finalTools.slice(1);
          continue;
        }
        break;
      }
      state.perf.finalPayloadBytes = Buffer.byteLength(finalCardJson, 'utf8');
      state.perf.finalComponentCount = finalComponentCount;
      recordFeishuCardPayloadPerf(state.perf, state.perf.finalPayloadBytes, finalComponentCount);
      terminalReactionEmoji = status === 'completed'
        ? COMPLETED_EMOJI
        : status === 'error'
          ? ERROR_EMOJI
          : null;

      state.sequence++;
      console.log('[feishu-adapter] Final card update payload:', {
        streamKey: cardKey,
        cardId: state.cardId,
        status,
        sequence: state.sequence,
        componentCount: finalComponentCount,
        ...summarizeCardJsonForLog(finalCardJson),
      });
      emitRealE2eStreamCardCheckpoint({
        kind: 'final',
        streamKey: cardKey,
        cardId: state.cardId,
        status,
        sequence: state.sequence,
        cardJson: finalCardJson,
      });
      const updateStartedAt = Date.now();
      const updateResult = await this.withFeishuRequestTimeout(cardKey, 'card.update', () => cardkit.card.update({
        path: { card_id: state.cardId },
        data: {
          card: { type: 'card_json', data: finalCardJson },
          sequence: state.sequence,
        },
      }));
      state.perf.finalUpdateMs = Date.now() - updateStartedAt;
      assertFeishuApiOk(updateResult, 'card.update');

      if (terminalReactionEmoji) {
        await this.addTerminalReaction(cardKey, state.messageId, terminalReactionEmoji);
      }

      console.log(`[feishu-adapter] Card finalized: streamKey=${cardKey}, cardId=${state.cardId}, status=${status}, elapsed=${formatElapsed(elapsedMs)}`);
      return true;
    } catch (err) {
      if (state.historyDriven) {
        const footerText = [
          status === 'completed' ? '✅ Completed' : status === 'error' ? '❌ Error' : '⚠️ Interrupted',
          formatElapsed(Date.now() - state.startTime),
          resolveTerminalContextUsage(state),
        ].filter(Boolean).join(' · ');
        const appended = await this.appendFinalStatusElement(cardKey, state, footerText);
        if (appended) {
          if (terminalReactionEmoji) {
            await this.addTerminalReaction(cardKey, state.messageId, terminalReactionEmoji);
          }
          console.warn('[feishu-adapter] Final card update failed; appended terminal status instead:', err instanceof Error ? err.message : err);
          console.log(`[feishu-adapter] Card finalized with appended status: streamKey=${cardKey}, cardId=${state.cardId}, status=${status}`);
          return true;
        }
      }
      console.warn('[feishu-adapter] Card finalize failed:', err instanceof Error ? err.message : err);
      if (streamingModeClosed && ((state.pendingText || '').trim() || state.historyItems.length > 0 || state.toolCalls.length > 0)) {
        if (terminalReactionEmoji) {
          await this.addTerminalReaction(cardKey, state.messageId, terminalReactionEmoji);
        }
        console.warn('[feishu-adapter] Final card update failed after streaming mode closed; keeping existing card instead of falling back to text:', err instanceof Error ? err.message : err);
        return true;
      }
      return false;
    } finally {
      this.logStreamingCardPerfSummary(cardKey, state, status);
      this.activeCards.delete(cardKey);
      this.streamActionRows.delete(cardKey);
      this.pendingStreamMetadata.delete(cardKey);
      this.clearCardCreateRetryTimer(cardKey);
      this.cardCreateNextEarliestAt.delete(cardKey);
      this.cardCreateConsecutiveFailures.delete(cardKey);
    }
  }

  private async appendFinalStatusElement(
    streamKey: string,
    state: FeishuCardState,
    footerText: string,
  ): Promise<boolean> {
    const cardElement = (this.restClient as any)?.cardkit?.v1?.cardElement;
    if (typeof cardElement?.create !== 'function') return false;
    state.sequence++;
    const element = {
      tag: 'markdown',
      content: preprocessFeishuMarkdown(footerText),
      text_align: 'left',
      text_size: 'notation',
      element_id: 'stream_done',
    };
    const projectedComponentCount = state.renderedComponentCount + countFeishuCardComponents(element);
    if (projectedComponentCount >= STREAMING_CARD_COMPONENT_LIMIT) {
      console.warn('[feishu-adapter] Final status append skipped because it would exceed the component limit:', {
        streamKey,
        cardId: state.cardId,
        currentComponentCount: state.renderedComponentCount,
        projectedComponentCount,
        limit: STREAMING_CARD_COMPONENT_LIMIT,
      });
      return false;
    }
    try {
      const result = await this.withFeishuRequestTimeout(streamKey, 'cardElement.create:stream_done', () => cardElement.create({
        path: { card_id: state.cardId },
        data: {
          type: 'append',
          elements: JSON.stringify([element]),
          sequence: state.sequence,
        },
      }));
      assertFeishuApiOk(result, 'cardElement.create:stream_done');
      emitRealE2eStreamCardCheckpoint({
        kind: 'element',
        streamKey,
        cardId: state.cardId,
        elementId: 'stream_done',
        status: 'completed',
        sequence: state.sequence,
        markdownTexts: [footerText],
      });
      this.markCardFlushSuccess(state);
      return true;
    } catch (error) {
      this.markCardFlushFailure(state, error);
      console.warn('[feishu-adapter] Final status append failed:', error instanceof Error ? error.message : error);
      return false;
    }
  }

  private async addTerminalReaction(streamKey: string, messageId: string, emojiType: string): Promise<void> {
    const messageReaction = (this.restClient as any)?.im?.messageReaction;
    if (typeof messageReaction?.create !== 'function') return;

    try {
      await this.withFeishuRequestTimeout(streamKey, `im.messageReaction.create:${emojiType}`, () => messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      }));
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code !== 99991400 && code !== 99991403) {
        console.warn('[feishu-adapter] Terminal reaction failed:', err instanceof Error ? err.message : err);
      }
    }
  }

  private async finalizeActiveCardWithoutBlocking(
    chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    responseText: string,
    streamKey?: string,
  ): Promise<boolean> {
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    if (!this.activeCards.has(cardKey)) {
      if (this.cardCreatePromises.has(cardKey) || this.scheduledCardCreatePromises.has(cardKey)) {
        console.warn('[feishu-adapter] Streaming card finalization skipped because card creation is still pending; falling back to text delivery:', {
          streamKey: cardKey,
          chatId,
        });
        return false;
      }
      return this.finalizeCard(chatId, status, responseText, cardKey);
    }

    const finalizePromise = this.finalizeCard(chatId, status, responseText, cardKey);
    const timeoutMs = Math.max(1, this.cardFinalizeBlockingBudgetMs);
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timedOut = Symbol('card-finalize-timeout');
    try {
      const result = await Promise.race([
        finalizePromise,
        new Promise<typeof timedOut>((resolve) => {
          timeoutHandle = setTimeout(() => resolve(timedOut), timeoutMs);
        }),
      ]);
      if (result !== timedOut) return result;

      const state = this.activeCards.get(cardKey);
      if (state) state.perf.backgroundFinalize = true;

      finalizePromise.then((ok) => {
        if (!ok) {
          console.error('[feishu-adapter] Background streaming card finalize finished without updating the card:', {
            streamKey: cardKey,
            chatId,
            status,
          });
        }
      }).catch((error) => {
        console.error('[feishu-adapter] Background streaming card finalize failed:', error instanceof Error ? error.message : error);
      });
      console.error('[feishu-adapter] Streaming card finalize exceeded blocking budget; continuing in background:', {
        streamKey: cardKey,
        chatId,
        status,
        timeoutMs,
      });
      return true;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  async addMessageReaction(messageId: string, emojiType: string): Promise<string | null> {
    const messageReaction = (this.restClient as any)?.im?.messageReaction;
    if (!messageId || typeof messageReaction?.create !== 'function') return null;
    try {
      const result = await this.withFeishuRequestTimeout(`reaction:${messageId}`, `im.messageReaction.create:${emojiType}`, () => messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      }));
      const reactionId = (result as any)?.data?.reaction_id;
      return typeof reactionId === 'string' && reactionId ? reactionId : null;
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code !== 99991400 && code !== 99991403) {
        console.warn('[feishu-adapter] Message reaction failed:', err instanceof Error ? err.message : err);
      }
      return null;
    }
  }

  async removeMessageReaction(messageId: string, reactionId: string, emojiType?: string): Promise<void> {
    const messageReaction = (this.restClient as any)?.im?.messageReaction;
    if (!messageId || !reactionId || typeof messageReaction?.delete !== 'function') return;
    try {
      await this.withFeishuRequestTimeout(`reaction:${messageId}`, `im.messageReaction.delete:${emojiType || reactionId}`, () => messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      }));
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code !== 99991400 && code !== 99991403) {
        console.warn('[feishu-adapter] Message reaction cleanup failed:', err instanceof Error ? err.message : err);
      }
    }
  }

  /**
   * Clean up card state without finalizing (e.g. on unexpected errors).
   */
  private cleanupCard(chatId: string, streamKey?: string): void {
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    this.cardCreatePromises.delete(cardKey);
    this.clearCardCreateRetryTimer(cardKey);
    this.cardCreateNextEarliestAt.delete(cardKey);
    this.cardCreateConsecutiveFailures.delete(cardKey);
    const state = this.activeCards.get(cardKey);
    if (!state) return;
    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
    }
    this.logStreamingCardPerfSummary(cardKey, state, 'cleanup');
    this.activeCards.delete(cardKey);
    this.streamActionRows.delete(cardKey);
    this.pendingStreamMetadata.delete(cardKey);
  }

  private logStreamingCardPerfSummary(
    streamKey: string,
    state: FeishuCardState,
    terminalStatus: 'completed' | 'interrupted' | 'error' | 'cleanup',
  ): void {
    const perf = state.perf;
    const elapsedMs = Date.now() - perf.startedAt;
    const apiTop = summarizeFeishuCardPerfApi(perf);
    console.log('[feishu-adapter] Streaming card perf summary:', {
      event: 'perf.card.lifecycle',
      streamKey,
      stream_key: streamKey,
      chatId: state.chatId,
      chat: state.chatId,
      chat_id: state.chatId,
      cardId: state.cardId,
      card_id: state.cardId,
      messageId: state.messageId,
      message_id: state.messageId,
      terminalStatus,
      terminal_status: terminalStatus,
      elapsedMs,
      elapsed_ms: elapsedMs,
      createCardMs: perf.createCardMs,
      create_card_ms: perf.createCardMs,
      sendMessageMs: perf.sendMessageMs,
      send_message_ms: perf.sendMessageMs,
      initialPayloadBytes: perf.initialPayloadBytes,
      initial_payload_bytes: perf.initialPayloadBytes,
      initialComponentCount: perf.initialComponentCount,
      initial_component_count: perf.initialComponentCount,
      flushAttempts: perf.flushAttempts,
      flush_attempts: perf.flushAttempts,
      flushSuccesses: perf.flushSuccesses,
      flush_successes: perf.flushSuccesses,
      flushFailures: perf.flushFailures,
      flush_failures: perf.flushFailures,
      flushTimeouts: perf.flushTimeouts,
      flush_timeouts: perf.flushTimeouts,
      flushQueuedCount: perf.flushQueuedCount,
      flush_queued_count: perf.flushQueuedCount,
      noopCount: perf.noopCount,
      noop_count: perf.noopCount,
      batchUpdateCount: perf.batchUpdateCount,
      batch_update_count: perf.batchUpdateCount,
      fullRefreshCount: perf.fullRefreshCount,
      full_refresh_count: perf.fullRefreshCount,
      fullRefreshReasons: perf.fullRefreshReasons,
      full_refresh_reasons: perf.fullRefreshReasons,
      maxPayloadBytes: perf.maxPayloadBytes,
      max_payload_bytes: perf.maxPayloadBytes,
      maxComponentCount: perf.maxComponentCount,
      max_component_count: perf.maxComponentCount,
      finalPayloadBytes: perf.finalPayloadBytes,
      final_payload_bytes: perf.finalPayloadBytes,
      finalComponentCount: perf.finalComponentCount,
      final_component_count: perf.finalComponentCount,
      finalizeWaitMs: perf.finalizeWaitMs,
      finalize_wait_ms: perf.finalizeWaitMs,
      settingsMs: perf.settingsMs,
      settings_ms: perf.settingsMs,
      finalUpdateMs: perf.finalUpdateMs,
      final_update_ms: perf.finalUpdateMs,
      backgroundFinalize: perf.backgroundFinalize,
      background_finalize: perf.backgroundFinalize,
      apiTop,
      api_top: apiTop,
    });
  }

  /**
   * Check if there is an active streaming card for a given chat.
   */
  hasActiveCard(chatId: string, streamKey?: string): boolean {
    return this.activeCards.has(this.resolveStreamKey(chatId, streamKey));
  }

  hasActiveStreamingUi(chatId: string, streamKey?: string): boolean {
    return this.hasActiveCard(chatId, streamKey);
  }

  getStructuredStreamingUiSnapshot(chatId: string, streamKey?: string): StructuredStreamingUiSnapshot | null {
    const state = this.activeCards.get(this.resolveStreamKey(chatId, streamKey));
    if (!state) return null;
    return {
      active: true,
      lastAttemptAt: state.lastFlushStartedAt,
      lastUpdateAt: state.lastSuccessfulFlushAt ?? (state.lastUpdateAt > 0 ? state.lastUpdateAt : null),
      lastErrorAt: state.lastFlushErrorAt,
      lastError: state.lastFlushError,
      flushInFlight: Boolean(state.flushInFlight),
      flushInFlightSince: state.flushInFlight ? state.lastFlushStartedAt : null,
      consecutiveFailures: state.consecutiveFlushFailures,
    };
  }

  getStructuredStreamingUiMessageId(chatId: string, streamKey?: string): string | null {
    return this.activeCards.get(this.resolveStreamKey(chatId, streamKey))?.messageId || null;
  }

  private shouldFullRefreshCard(state: FeishuCardState, now: number): boolean {
    const interval = Math.max(0, this.cardFullRefreshIntervalMs);
    if (interval <= 0) return false;
    if (!Number.isFinite(now)) return false;
    return now - state.lastFullRefreshAttemptAt >= interval;
  }

  private async flushFullCardRefresh(
    streamKey: string,
    state: FeishuCardState,
    content: string,
    tasksText: string,
    statusText: string,
    actionRows: FeishuCardActionButton[][] = [],
    metadata: StructuredStreamingUiMetadata = {},
    desiredRevision = state.desiredRevision,
  ): Promise<boolean> {
    state.lastFullRefreshAttemptAt = Date.now();
    const cardkit = (this.restClient as any)?.cardkit?.v1;
    if (!cardkit?.card?.update) return false;

    try {
      state.sequence++;
      const normalizedMetadata = normalizeStreamMetadata(metadata);
      const renderedContent = buildStreamingTextContent(content);
      const contentLayoutSignature = buildStreamingTextLayoutSignature(content);
      const render = this.currentStreamingCardRender(
        state,
        content,
        tasksText,
        statusText,
        actionRows,
        normalizedMetadata,
      );
      const renderedHistory = buildStreamingHistoryRenderState(
        content,
        render.tools,
        'streaming_content',
        render.historyItems,
      );
      const refreshCardJson = JSON.stringify(render.body);
      const payloadBytes = Buffer.byteLength(refreshCardJson, 'utf8');
      recordFeishuCardPayloadPerf(state.perf, payloadBytes, render.componentCount);
      console.log('[feishu-adapter] Streaming card full refresh payload:', {
        event: 'perf.card.full_refresh_payload',
        streamKey,
        stream_key: streamKey,
        cardId: state.cardId,
        card_id: state.cardId,
        sequence: state.sequence,
        operation: 'fullRefresh',
        componentCount: render.componentCount,
        component_count: render.componentCount,
        payload_bytes: payloadBytes,
        ...summarizeCardJsonForLog(refreshCardJson),
      });
      emitRealE2eStreamCardCheckpoint({
        kind: 'refresh',
        streamKey,
        cardId: state.cardId,
        status: 'streaming',
        sequence: state.sequence,
        cardJson: refreshCardJson,
      });
      const refreshResult = await this.withFeishuRequestTimeout(streamKey, 'card.update:streaming_refresh', () => cardkit.card.update({
        path: { card_id: state.cardId },
        data: {
          card: {
            type: 'card_json',
            data: refreshCardJson,
          },
          sequence: state.sequence,
        },
      }));
      assertFeishuApiOk(refreshResult, 'card.update:streaming_refresh');
      const actionSummary = summarizeCardActionRows(actionRows);
      if (actionSummary.buttonCount > 0) {
        console.log('[feishu-adapter] Streaming card full refresh included actions:', {
          streamKey,
          cardId: state.cardId,
          ...actionSummary,
        });
      }
      state.renderedText = renderedContent;
      state.renderedTextLayoutSignature = contentLayoutSignature;
      state.renderedTasksText = tasksText;
      state.renderedHistoryElementIds = renderedHistory.elementIds;
      state.renderedHistoryElementJson = renderedHistory.elementJson;
      state.historyItemOffset = render.historyItemOffset;
      state.toolCallOffset = render.toolCallOffset;
      state.renderedToolSnapshots = buildRenderedToolSnapshots(render.tools);
      state.renderedToolEventCounts = buildRenderedToolEventCounts(render.tools);
      state.renderedStatusText = statusText;
      state.renderedHistorySignature = streamingHistorySignature(render.historyItems || []);
      state.renderedActionSignature = cardActionRowsSignature(actionRows);
      state.renderedMetadataSignature = streamMetadataSignature(normalizedMetadata);
      state.renderedComponentCount = render.componentCount;
      state.shadowTrust = 'trusted';
      state.shadowRevision = desiredRevision;
      state.lastSuccessfulFullRefreshAt = Date.now();
      this.markCardFlushSuccess(state);
      return true;
    } catch (err) {
      if (isFeishuCardPayloadLimitError(err)) {
        const rolled = await this.forceStreamingCardContinuationRollover(
          streamKey,
          state,
          content,
          tasksText,
          statusText,
          actionRows,
          metadata,
          'feishu_200850',
        );
        if (rolled) return true;
      }
      this.markCardFlushFailure(state, err);
      console.warn(
        '[feishu-adapter] card.update streaming refresh failed:',
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  private getCardRequestTimeoutMs(): number {
    return Math.max(1, this.cardRequestTimeoutMs);
  }

  private logRequestOperation(
    phase: 'start' | 'success' | 'timeout' | 'error',
    scope: string,
    target: string,
    startedAt: number,
    detail?: string,
    response?: unknown,
  ): void {
    const durationMs = Math.max(0, Date.now() - startedAt);
    const activeCard = this.activeCards.get(scope);
    const fields = {
      event: 'perf.feishu.request',
      phase,
      status: phase,
      scope,
      target,
      operation: target,
      duration_ms: durationMs,
      durationMs,
      ...(activeCard ? {
        stream_key: scope,
        streamKey: scope,
        chat: activeCard.chatId,
        chatId: activeCard.chatId,
        card_id: activeCard.cardId,
        cardId: activeCard.cardId,
      } : {}),
      ...(detail ? { detail } : {}),
      ...summarizeFeishuResponseFields(response),
    };
    const message = `Request ${phase}:`;
    if (phase === 'start' || phase === 'success') {
      console.log(`[feishu-adapter] ${message}`, fields);
      return;
    }
    if (phase === 'timeout') {
      console.error(`[feishu-adapter] ${message}`, fields);
      return;
    }
    console.warn(`[feishu-adapter] ${message}`, fields);
  }

  private async withFeishuRequestTimeout<T>(
    scope: string,
    target: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    const timeoutMs = this.getCardRequestTimeoutMs();
    if (process.env[LOG_FEISHU_REQUEST_START_ENV] === '1') {
      this.logRequestOperation('start', scope, target, startedAt);
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const operationPromise = Promise.resolve().then(operation);
    operationPromise.catch(() => {
      // Promise.race may already reject on timeout; keep late failures handled.
    });

    try {
      const result = await Promise.race([operationPromise, timeoutPromise]);
      const apiError = feishuApiErrorFromResponse(result, target);
      const phase = apiError ? 'error' : 'success';
      this.recordActiveCardRequestPerf(scope, target, startedAt, phase);
      this.logRequestOperation(phase, scope, target, startedAt, summarizeFeishuResponseForLog(result), result);
      return result;
    } catch (error) {
      const detail = feishuErrorSummary(error, 'Feishu request failed');
      const phase = detail.startsWith('timeout after ') ? 'timeout' : 'error';
      this.recordActiveCardRequestPerf(scope, target, startedAt, phase);
      this.logRequestOperation(
        phase,
        scope,
        target,
        startedAt,
        detail,
      );
      throw error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private dispatchFeishuRequestInBackground<T>(
    scope: string,
    target: string,
    operation: () => Promise<T>,
    handlers: {
      onSuccess?: (result: T) => void;
      onError?: (error: unknown) => void;
    } = {},
  ): Promise<void> {
    const promise = this.withFeishuRequestTimeout(scope, target, operation)
      .then((result) => {
        assertFeishuApiOk(result, target);
        handlers.onSuccess?.(result);
      })
      .catch((error) => {
        handlers.onError?.(error);
      });
    return promise.catch((error) => {
      console.warn(
        `[feishu-adapter] Background Feishu request handler failed for ${target}:`,
        error instanceof Error ? error.message : error,
      );
    });
  }

  private recordActiveCardRequestPerf(
    streamKey: string,
    target: string,
    startedAt: number,
    phase: 'success' | 'timeout' | 'error',
  ): void {
    const state = this.activeCards.get(streamKey);
    if (!state) return;
    recordFeishuCardApiPerf(state.perf, target, Math.max(0, Date.now() - startedAt), phase);
  }

  private markCardFlushQueued(state: FeishuCardState): void {
    if (!state.flushQueued) {
      state.perf.flushQueuedCount += 1;
    }
    state.flushQueued = true;
  }

  private markCardFlushFailure(state: FeishuCardState, error: unknown): void {
    const now = Date.now();
    state.lastFlushErrorAt = now;
    state.lastFlushError = error instanceof Error ? error.message : String(error);
    state.consecutiveFlushFailures += 1;
    state.shadowTrust = 'unknown';
    state.nextFlushEarliestAt = now + this.getCongestedCardIntervalMs(state.consecutiveFlushFailures);
  }

  private markCardFlushSuccess(state: FeishuCardState): void {
    const now = Date.now();
    state.lastUpdateAt = now;
    state.lastSuccessfulFlushAt = now;
    state.lastFlushError = null;
    state.consecutiveFlushFailures = 0;
    state.nextFlushEarliestAt = now + this.getCongestedCardIntervalMs(0);
  }

  // ── Streaming adapter interface ────────────────────────────────

  /**
   * Called by bridge-manager on each text SSE event.
   * Creates streaming card on first call, then updates content.
   */
  onStreamText(chatId: string, fullText: string, streamKey?: string): void {
    if (!this.supportsStructuredStreamingUi(chatId)) return;
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    if (!this.activeCards.has(cardKey)) {
      // Card should have been created by onMessageStart, but create lazily if not
      this.pendingCardCreateState(cardKey).text = fullText;
      const messageId = this.lastIncomingMessageId.get(chatId);
      this.createStreamingCard(chatId, messageId, cardKey).then((ok) => {
        if (ok) this.updateCardContent(chatId, fullText, cardKey);
      }).catch(() => {});
      return;
    }
    this.updateCardContent(chatId, fullText, cardKey);
  }

  onMirrorStreamStart(chatId: string, streamKey?: string): void {
    if (!this.supportsStructuredStreamingUi(chatId)) return;
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    if (this.activeCards.has(cardKey)) return;
    this.createStreamingCard(chatId, undefined, cardKey).catch(() => {});
  }

  onToolEvent(chatId: string, tools: ToolCallInfo[], streamKey?: string): void {
    if (!this.supportsStructuredStreamingUi(chatId)) return;
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    if (!this.activeCards.has(cardKey)) {
      this.pendingCardCreateState(cardKey).tools = tools;
      const messageId = this.lastIncomingMessageId.get(chatId);
      this.createStreamingCard(chatId, messageId, cardKey).then((ok) => {
        if (ok) this.updateToolProgress(chatId, tools, cardKey);
      }).catch(() => {});
      return;
    }
    this.updateToolProgress(chatId, tools, streamKey);
  }

  onStreamHistory(chatId: string, items: StreamingHistoryItem[], streamKey?: string): void {
    if (!this.supportsStructuredStreamingUi(chatId)) return;
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    if (!this.activeCards.has(cardKey)) {
      const pending = this.pendingCardCreateState(cardKey);
      pending.historyItems = items;
      pending.historyDriven = true;
      const messageId = this.lastIncomingMessageId.get(chatId);
      this.createStreamingCard(chatId, messageId, cardKey).then((ok) => {
        if (ok) this.updateStreamingHistory(chatId, items, cardKey);
      }).catch(() => {});
      return;
    }
    this.updateStreamingHistory(chatId, items, streamKey);
  }

  onTaskEvent(chatId: string, tasks: TaskProgressInfo[], streamKey?: string): void {
    if (!this.supportsStructuredStreamingUi(chatId)) return;
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    if (!this.activeCards.has(cardKey)) {
      this.pendingCardCreateState(cardKey).tasks = tasks;
      const messageId = this.lastIncomingMessageId.get(chatId);
      this.createStreamingCard(chatId, messageId, cardKey).then((ok) => {
        if (ok) this.updateTaskProgress(chatId, tasks, cardKey);
      }).catch(() => {});
      return;
    }
    this.updateTaskProgress(chatId, tasks, streamKey);
  }

  onStreamStatus(chatId: string, statusText: string, streamKey?: string): void {
    if (!this.supportsStructuredStreamingUi(chatId)) return;
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    if (!this.activeCards.has(cardKey)) {
      this.pendingCardCreateState(cardKey).statusText = statusText;
      const messageId = this.lastIncomingMessageId.get(chatId);
      this.createStreamingCard(chatId, messageId, cardKey).then((ok) => {
        if (ok) this.updateCardStatus(chatId, statusText, cardKey);
      }).catch(() => {});
      return;
    }
    this.updateCardStatus(chatId, statusText, cardKey);
  }

  onStreamMetadata(chatId: string, metadata: StructuredStreamingUiMetadata, streamKey?: string): void {
    if (!this.supportsStructuredStreamingUi(chatId)) return;
    this.updateCardMetadata(chatId, metadata, streamKey);
  }

  onStreamActions(chatId: string, actionRows: FeishuCardActionButton[][], streamKey?: string): void {
    if (!this.supportsStructuredStreamingUi(chatId)) return;
    this.updateCardActions(chatId, actionRows, streamKey);
  }

  async onStreamEnd(
    chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    responseText: string,
    streamKey?: string,
  ): Promise<boolean> {
    if (!this.supportsStructuredStreamingUi(chatId)) return false;
    return this.finalizeActiveCardWithoutBlocking(chatId, status, responseText, streamKey);
  }

  // ── Send ────────────────────────────────────────────────────

  async send(message: OutboundMessage): Promise<SendResult> {
    if (message.address.cloudDocument) {
      const attachmentCount = message.attachments?.length || 0;
      const text = [
        message.text.trim(),
        attachmentCount > 0
          ? `暂不支持在云文档评论中发送本地附件，已省略 ${attachmentCount} 个附件。`
          : '',
      ].filter(Boolean).join('\n\n');
      if (!text) return { ok: true };
      return this.sendCloudDocumentReply(message.address.cloudDocument, text);
    }

    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    if (this.isCloudDocumentChatId(message.address.chatId)) {
      console.error('[feishu-adapter] Refusing to send Feishu IM message to cloud document virtual chat:', {
        chatId: message.address.chatId,
        hasCloudDocument: Boolean(message.address.cloudDocument),
        textPreview: message.text.slice(0, 120),
      });
      return {
        ok: false,
        error: `Refusing to send Feishu IM message to cloud document virtual chat: ${message.address.chatId}`,
      };
    }

    if (message.attachments && message.attachments.length > 0) {
      return this.sendAttachments(message.address.chatId, message.attachments, message.replyToMessageId);
    }

    let text = message.text;

    // Convert HTML to markdown for Feishu rendering (e.g. command responses)
    if (message.parseMode === 'HTML') {
      text = htmlToFeishuMarkdown(text);
    }

    // Preprocess markdown before converting it to Feishu post content.
    if (message.parseMode === 'Markdown') {
      text = preprocessFeishuMarkdown(text);
    }

    // If there are inline buttons (permission prompts), send card with action buttons
    if (message.inlineButtons && message.inlineButtons.length > 0) {
      return this.sendPermissionCard(message.address.chatId, text, message.inlineButtons);
    }

    if (message.richCard) {
      return this.sendRichCard(
        message.address.chatId,
        message.richCard,
        message.replyToMessageId,
        message.richCardUpdateMessageId,
      );
    }

    if (message.parseMode === 'plain') {
      return this.sendAsPlainText(message.address.chatId, text, message.replyToMessageId);
    }

    // Rendering strategy (aligned with Openclaw):
    // - Code blocks / tables → interactive card (schema 2.0 markdown)
    // - Other text → post (md tag)
    if (hasComplexMarkdown(text)) {
      return this.sendAsCard(message.address.chatId, text, message.replyToMessageId);
    }
    return this.sendAsPost(message.address.chatId, text, message.replyToMessageId);
  }

  async pinMessage(chatId: string, messageId: string): Promise<SendResult> {
    const pinApi = (this.restClient as any)?.im?.pin;
    if (!pinApi?.create) {
      return { ok: false, messageId, error: 'Feishu pin API is not available' };
    }
    try {
      const res = await this.withFeishuRequestTimeout<{ code?: number; msg?: string }>(chatId, 'im.pin.create', () => pinApi.create({
        data: { message_id: messageId },
      }));
      if (res?.code && res.code !== 0) {
        return { ok: false, messageId, error: res.msg || 'Pin message failed' };
      }
      return { ok: true, messageId };
    } catch (err) {
      return { ok: false, messageId, error: err instanceof Error ? err.message : 'Pin message failed' };
    }
  }

  async unpinMessage(chatId: string, messageId: string): Promise<SendResult> {
    const pinApi = (this.restClient as any)?.im?.pin;
    if (!pinApi?.delete) {
      return { ok: false, messageId, error: 'Feishu unpin API is not available' };
    }
    try {
      const res = await this.withFeishuRequestTimeout<{ code?: number; msg?: string }>(chatId, 'im.pin.delete', () => pinApi.delete({
        path: { message_id: messageId },
      }));
      if (res?.code && res.code !== 0) {
        return { ok: false, messageId, error: res.msg || 'Unpin message failed' };
      }
      return { ok: true, messageId };
    } catch (err) {
      return { ok: false, messageId, error: err instanceof Error ? err.message : 'Unpin message failed' };
    }
  }

  private getOpenApiBaseUrl(): string {
    return feishuSiteToApiBaseUrl(this.site);
  }

  private async getTenantAccessToken(): Promise<string> {
    const appId = this.appId;
    const appSecret = this.appSecret;
    const domain = this.getOpenApiBaseUrl();
    if (!appId || !appSecret) {
      throw new Error('Feishu App ID / App Secret not configured');
    }

    const now = Date.now();
    if (
      this.tenantTokenCache
      && this.tenantTokenCache.appId === appId
      && this.tenantTokenCache.appSecret === appSecret
      && this.tenantTokenCache.domain === domain
      && this.tenantTokenCache.expiresAt > now + 60_000
    ) {
      return this.tenantTokenCache.token;
    }

    if (this.tenantTokenRequest) return this.tenantTokenRequest;

    const request = (async () => {
      const response = await fetch(`${domain}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: appId,
          app_secret: appSecret,
        }),
      });
      const data = await response.json() as {
        code?: number;
        msg?: string;
        tenant_access_token?: string;
        expire?: number;
      };
      if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
        throw new Error(data.msg || `tenant_access_token failed: HTTP ${response.status}`);
      }

      this.tenantTokenCache = {
        token: data.tenant_access_token,
        expiresAt: now + Math.max(60, Number(data.expire || 7200)) * 1000,
        appId,
        appSecret,
        domain,
      };
      return data.tenant_access_token;
    })();
    this.tenantTokenRequest = request;
    try {
      return await request;
    } finally {
      if (this.tenantTokenRequest === request) {
        this.tenantTokenRequest = null;
      }
    }
  }

  private async sendAttachments(
    chatId: string,
    attachments: OutboundAttachment[],
    replyToMessageId?: string,
  ): Promise<SendResult> {
    let lastMessageId: string | undefined;

    for (const attachment of attachments) {
      const result = await this.sendAttachment(chatId, attachment, replyToMessageId);
      if (!result.ok) return result;
      lastMessageId = result.messageId;
    }

    return { ok: true, messageId: lastMessageId };
  }

  private async sendAttachment(
    chatId: string,
    attachment: OutboundAttachment,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    if (!fs.existsSync(attachment.path)) {
      return { ok: false, error: `Attachment not found: ${attachment.path}` };
    }

    try {
      if (attachment.kind === 'image') {
        const imageKey = await this.uploadImage(attachment);
        return await this.sendStructuredMessage(
          chatId,
          'image',
          JSON.stringify({ image_key: imageKey }),
          replyToMessageId,
        );
      }

      const fileKey = await this.uploadFile(attachment);
      return await this.sendStructuredMessage(
        chatId,
        'file',
        JSON.stringify({ file_key: fileKey }),
        replyToMessageId,
      );
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Attachment send failed' };
    }
  }

  private async uploadImage(attachment: OutboundAttachment): Promise<string> {
    const fileName = attachment.name || path.basename(attachment.path) || 'image.png';
    const data = await fs.promises.readFile(attachment.path);
    return this.uploadImageBlob('message', new Blob([data]), fileName);
  }

  private async uploadImageBlob(
    imageType: 'message' | 'avatar',
    image: Blob,
    fileName: string,
  ): Promise<string> {
    const token = await this.getTenantAccessToken();
    const form = new FormData();
    form.set('image_type', imageType);
    form.set('image', image, fileName);
    const response = await fetch(`${this.getOpenApiBaseUrl()}/open-apis/im/v1/images`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const data = await response.json() as {
      code?: number;
      msg?: string;
      data?: { image_key?: string };
    };
    if (!response.ok || data.code !== 0 || !data.data?.image_key) {
      throw new Error(data.msg || `image upload failed: HTTP ${response.status}`);
    }
    return data.data.image_key;
  }

  private async tryUploadGroupAvatarImageKey(): Promise<string | null> {
    const avatarUrl = this.botAvatarUrl?.trim();
    if (!avatarUrl) return null;

    try {
      const response = await fetch(avatarUrl, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`avatar download failed: HTTP ${response.status}`);
      }
      const contentType = response.headers.get('content-type') || 'image/png';
      const image = new Blob([await response.arrayBuffer()], { type: contentType });
      if (image.size === 0) {
        throw new Error('avatar download returned an empty image');
      }
      const fileName = inferImageFileName(avatarUrl, contentType);
      return await this.uploadImageBlob('avatar', image, fileName);
    } catch (error) {
      console.warn(
        '[feishu-adapter] Failed to upload bot avatar as group avatar; creating group with default avatar:',
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }

  private async uploadFile(attachment: OutboundAttachment): Promise<string> {
    const token = await this.getTenantAccessToken();
    const fileName = attachment.name || path.basename(attachment.path) || 'attachment.bin';
    const form = new FormData();
    form.set('file_type', 'stream');
    form.set('file_name', fileName);
    const fileData = await fs.promises.readFile(attachment.path);
    form.set('file', new Blob([fileData]), fileName);

    const response = await fetch(`${this.getOpenApiBaseUrl()}/open-apis/im/v1/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const data = await response.json() as {
      code?: number;
      msg?: string;
      data?: { file_key?: string };
    };
    if (!response.ok || data.code !== 0 || !data.data?.file_key) {
      throw new Error(data.msg || `file upload failed: HTTP ${response.status}`);
    }
    return data.data.file_key;
  }

  private async sendStructuredMessage(
    chatId: string,
    msgType: 'image' | 'file',
    content: string,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    try {
      const res = replyToMessageId
        ? await this.withFeishuRequestTimeout(chatId, `im.message.reply:${msgType}`, () => this.restClient!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: msgType, content },
        }))
        : await this.withFeishuRequestTimeout(chatId, `im.message.create:${msgType}`, () => this.restClient!.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: msgType,
            content,
          },
        }));

      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || `${msgType} send failed` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : `${msgType} send failed` };
    }
  }

  /**
   * Send a bridge command result as an interactive rich card.
   * Rich card failures are surfaced instead of sending a plain-text fallback.
   */
  private async sendRichCard(
    chatId: string,
    card: NonNullable<OutboundMessage['richCard']>,
    replyToMessageId?: string,
    updateMessageId?: string,
  ): Promise<SendResult> {
    const cardContent = buildRichCardContent(card, chatId);
    console.log('[feishu-adapter] Rich card payload:', {
      chatId,
      title: card.title,
      updateKey: card.updateKey,
      replyToMessageId,
      updateMessageId,
      hasForm: Boolean(card.form),
      formOptionElementId: card.form?.optionElementId,
      formInputElementId: card.form?.inputElementId,
      formOptionCount: card.form?.options.length || 0,
      actionCount: card.actions?.flat().length || 0,
      ...summarizeCardJsonForLog(cardContent),
    });
    const updateKey = card.updateKey?.trim();
    const updateTtlMs = card.updateTtlMs === null
      ? null
      : Math.max(0, card.updateTtlMs ?? RICH_CARD_DEFAULT_UPDATE_TTL_MS);
    const cardkit = (this.restClient as any)?.cardkit?.v1;

    if (updateKey && cardkit?.card?.update) {
      const now = Date.now();
      const existing = this.richCardUpdates.get(updateKey);
      let updateState: RichCardUpdateState | null = null;

      if (
        updateMessageId
        && existing
        && existing.messageId === updateMessageId
        && (updateTtlMs === null || now - existing.lastInteractionAt <= updateTtlMs)
      ) {
        updateState = existing;
      } else if (updateMessageId && cardkit.card.idConvert) {
        try {
          const converted = await this.withFeishuRequestTimeout<{ data?: { card_id?: string } }>(
            updateKey,
            'card.idConvert:rich-command-card',
            () => cardkit.card.idConvert({
              data: { message_id: updateMessageId },
            }),
          );
          const recoveredCardId = converted?.data?.card_id;
          if (recoveredCardId) {
            updateState = {
              cardId: recoveredCardId,
              messageId: updateMessageId,
              lastInteractionAt: now,
              sequence: now,
            };
          }
        } catch (err) {
          console.warn('[feishu-adapter] Rich command card idConvert failed:', err instanceof Error ? err.message : err);
        }
      }

      if (updateState) {
        try {
          updateState.sequence += 1;
          await this.withFeishuRequestTimeout(updateKey, 'card.update:rich-command-card', () => cardkit.card.update({
            path: { card_id: updateState.cardId },
            data: {
              card: { type: 'card_json', data: cardContent },
              sequence: updateState.sequence,
            },
          }));
          updateState.lastInteractionAt = now;
          this.richCardUpdates.set(updateKey, updateState);
          return { ok: true, messageId: updateState.messageId };
        } catch (err) {
          console.warn('[feishu-adapter] Rich command card update failed:', err instanceof Error ? err.message : err);
          if (this.richCardUpdates.get(updateKey)?.messageId === updateState.messageId) {
            this.richCardUpdates.delete(updateKey);
          }
        }
      }
    }

    let lastError = 'rich card send failed';
    if (updateKey && cardkit?.card?.create) {
      try {
        const createResp = await this.withFeishuRequestTimeout<{ data?: { card_id?: string } }>(updateKey, 'card.create:rich-command-card', () => cardkit.card.create({
          data: { type: 'card_json', data: cardContent },
        }));
        const cardId = createResp?.data?.card_id;
        if (cardId) {
          const linkedCardContent = JSON.stringify({ type: 'card', data: { card_id: cardId } });
          const res = replyToMessageId
            ? await this.withFeishuRequestTimeout(updateKey, 'im.message.reply:rich-command-card', () => this.restClient!.im.message.reply({
              path: { message_id: replyToMessageId },
              data: { msg_type: 'interactive', content: linkedCardContent },
            }))
            : await this.withFeishuRequestTimeout(updateKey, 'im.message.create:rich-command-card', () => this.restClient!.im.message.create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: chatId,
                msg_type: 'interactive',
                content: linkedCardContent,
              },
            }));
          if (res?.data?.message_id) {
            this.richCardUpdates.set(updateKey, {
              cardId,
              messageId: res.data.message_id,
              lastInteractionAt: Date.now(),
              sequence: 0,
            });
            return { ok: true, messageId: res.data.message_id };
          }
          lastError = res?.msg || 'rich command card message send failed';
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : 'rich command card create/send failed';
        console.warn('[feishu-adapter] Rich command card create/send error; retrying direct card send:', lastError);
      }
    }

    try {
      const res = replyToMessageId
        ? await this.withFeishuRequestTimeout(chatId, 'im.message.reply:rich-command-card', () => this.restClient!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: 'interactive', content: cardContent },
        }))
        : await this.withFeishuRequestTimeout(chatId, 'im.message.create:rich-command-card', () => this.restClient!.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: cardContent,
          },
        }));

      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      lastError = res?.msg || 'rich command card send failed';
      console.warn('[feishu-adapter] Rich command card send failed:', res?.msg, res?.code);
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'rich command card send failed';
      console.warn('[feishu-adapter] Rich command card send error:', lastError);
    }

    return { ok: false, error: lastError };
  }

  /**
   * Send text as an interactive card (schema 2.0 markdown).
   * Used for code blocks and tables — card renders them properly.
   * Card failures are surfaced instead of falling back to post/plain text.
   */
  private async sendAsCard(chatId: string, text: string, replyToMessageId?: string): Promise<SendResult> {
    const cardContent = buildCardContent(text);

    try {
      const res = replyToMessageId
        ? await this.withFeishuRequestTimeout(chatId, 'im.message.reply:interactive-card', () => this.restClient!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: 'interactive', content: cardContent },
        }))
        : await this.withFeishuRequestTimeout(chatId, 'im.message.create:interactive-card', () => this.restClient!.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: cardContent,
          },
        }));

      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      const error = res?.msg || 'interactive card send failed';
      console.warn('[feishu-adapter] Card send failed:', res?.msg, res?.code);
      return { ok: false, error };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'interactive card send failed';
      console.warn('[feishu-adapter] Card send error:', error);
      return { ok: false, error };
    }
  }

  /**
   * Send text as a post message (msg_type: 'post') with md tag.
   * Used for simple text — renders bold, italic, inline code, links.
   */
  private async sendAsPost(chatId: string, text: string, replyToMessageId?: string): Promise<SendResult> {
    const postContent = buildPostContent(text);

    try {
      const res = replyToMessageId
        ? await this.withFeishuRequestTimeout(chatId, 'im.message.reply:post', () => this.restClient!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: 'post', content: postContent },
        }))
        : await this.withFeishuRequestTimeout(chatId, 'im.message.create:post', () => this.restClient!.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'post',
            content: postContent,
          },
        }));

      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu-adapter] Post send failed:', res?.msg, res?.code);
    } catch (err) {
      console.warn('[feishu-adapter] Post send error, falling back to text:', err instanceof Error ? err.message : err);
    }

    // Final fallback: plain text
    return this.sendAsPlainText(chatId, text, replyToMessageId);
  }

  private async sendAsPlainText(chatId: string, text: string, replyToMessageId?: string): Promise<SendResult> {
    try {
      const content = JSON.stringify({ text });
      const res = replyToMessageId
        ? await this.withFeishuRequestTimeout(chatId, 'im.message.reply:text', () => this.restClient!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: 'text', content },
        }))
        : await this.withFeishuRequestTimeout(chatId, 'im.message.create:text', () => this.restClient!.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content,
          },
        }));
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || 'Send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  // ── Permission card (with real action buttons) ─────────────

  /**
   * Send a permission card with real Feishu card action buttons.
   * Button clicks trigger card.action.trigger events handled by handleCardAction().
   * Falls back to text-based /perm commands if button card fails.
   */
  private async sendPermissionCard(
    chatId: string,
    text: string,
    inlineButtons: import('../../domain/index.js').InlineButton[][],
  ): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    // Convert HTML text from permission-broker to Feishu markdown.
    // permission-broker sends HTML (<b>, <code>, <pre>, &amp; entities)
    // but Feishu card markdown elements don't understand HTML.
    const mdText = text
      .replace(/<b>(.*?)<\/b>/gi, '**$1**')
      .replace(/<code>(.*?)<\/code>/gi, '`$1`')
      .replace(/<pre>([\s\S]*?)<\/pre>/gi, '```\n$1\n```')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"');

    // Extract permissionRequestId from the first button's callback data
    const firstBtn = inlineButtons.flat()[0];
    const permId = firstBtn?.callbackData?.startsWith('perm:')
      ? firstBtn.callbackData.split(':').slice(2).join(':')
      : '';

    if (permId) {
      // Use real card action buttons
      const cardJson = buildPermissionButtonCard(mdText, permId, chatId);

      try {
        const res = await this.withFeishuRequestTimeout(chatId, 'im.message.create:permission-button-card', () => this.restClient!.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: cardJson,
          },
        }));
        if (res?.data?.message_id) {
          return { ok: true, messageId: res.data.message_id };
        }
        console.warn('[feishu-adapter] Permission button card send failed:', JSON.stringify({ code: (res as any)?.code, msg: res?.msg }));
      } catch (err) {
        console.warn('[feishu-adapter] Permission button card error, falling back to text:', err instanceof Error ? err.message : err);
      }
    }

    // Fallback: text-based permission commands (same as before, for backward compat)
    const permCommands = inlineButtons.flat().map((btn) => {
      if (btn.callbackData.startsWith('perm:')) {
        const parts = btn.callbackData.split(':');
        const action = parts[1];
        const id = parts.slice(2).join(':');
        return `\`/perm ${action} ${id}\``;
      }
      return btn.text;
    });

    const cardContent = [
      mdText,
      '',
      '---',
      '**Reply:**',
      '`1` - Allow once',
      '`2` - Allow session',
      '`3` - Deny',
      '',
      'Or use full commands:',
      ...permCommands,
    ].join('\n');

    const cardJson = JSON.stringify({
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        template: 'orange',
        title: { tag: 'plain_text', content: '🔐 Permission Required' },
      },
      body: {
        elements: [
          { tag: 'markdown', content: cardContent },
        ],
      },
    });

    try {
      const res = await this.withFeishuRequestTimeout(chatId, 'im.message.create:permission-fallback-card', () => this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: cardJson,
        },
      }));
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu-adapter] Fallback card also failed:', res?.msg);
    } catch (err) {
      console.warn('[feishu-adapter] Fallback card error, sending plain text:', err instanceof Error ? err.message : err);
    }

    // Last resort: plain text message (works even without card permissions)
    const plainText = [
      mdText,
      '',
      '---',
      'Reply: 1 = Allow once | 2 = Allow session | 3 = Deny',
      '',
      ...permCommands,
    ].join('\n');

    try {
      const res = await this.withFeishuRequestTimeout(chatId, 'im.message.create:permission-fallback-text', () => this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: plainText }),
        },
      }));
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || 'Send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  // ── Config & Auth ───────────────────────────────────────────

  validateConfig(): string | null {
    const appId = this.appId;
    if (!appId) return 'Feishu App ID 未配置';

    const appSecret = this.appSecret;
    if (!appSecret) return 'Feishu App Secret 未配置';

    return null;
  }

  isAuthorized(userId: string, chatId: string): boolean {
    const allowedUsers = (this.channelConfig.allowedUsers || []).join(',');
    if (!allowedUsers) {
      // No restriction configured — allow all
      return true;
    }

    const allowed = allowedUsers
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (allowed.length === 0) return true;

    return allowed.includes(userId) || allowed.includes(chatId);
  }

  // ── Incoming event handler ──────────────────────────────────

  private async handleIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    this.logIncomingMessageEvent(data);
    try {
      await this.processIncomingEvent(data);
    } catch (err) {
      console.error(
        '[feishu-adapter] Unhandled error in event handler:',
        err instanceof Error ? err.stack || err.message : err,
      );
    }
  }

  private async processIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    const msg = data.message;
    const sender = data.sender;

    // [P1] Filter out bot messages to prevent self-triggering loops
    if (sender.sender_type === 'bot') return;

    // Dedup by message_id
    if (this.seenMessageIds.has(msg.message_id)) return;
    this.addToDedup(msg.message_id);

    const chatId = msg.chat_id;
    // [P2] Complete sender ID fallback chain: open_id > user_id > union_id
    const userId = sender.sender_id?.open_id
      || sender.sender_id?.user_id
      || sender.sender_id?.union_id
      || '';
    const isGroup = msg.chat_type === 'group';

    // Authorization check
    if (!this.isAuthorized(userId, chatId)) {
      console.warn('[feishu-adapter] Unauthorized message from userId:', userId, 'chatId:', chatId);
      return;
    }

    // Group chat policy
    if (isGroup) {
      const policy = getBridgeContext().store.getSetting('bridge_feishu_group_policy') || 'open';

      if (policy === 'disabled') {
        console.log('[feishu-adapter] Group message ignored (policy=disabled), chatId:', chatId);
        return;
      }

      if (policy === 'allowlist') {
        const allowedGroups = (getBridgeContext().store.getSetting('bridge_feishu_group_allow_from') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!allowedGroups.includes(chatId)) {
          console.log('[feishu-adapter] Group message ignored (not in allowlist), chatId:', chatId);
          return;
        }
      }

      // Require @mention check
      const requireMention = this.shouldRequireMentionForGroup();
      if (requireMention && !this.isBotMentioned(msg.mentions)) {
        console.log('[feishu-adapter] Group message ignored (bot not @mentioned), chatId:', chatId, 'msgId:', msg.message_id);
        try {
          getBridgeContext().store.insertAuditLog({
            channelType: this.channelType,
            channelProvider: this.provider,
            channelAlias: this.alias,
            chatId,
            direction: 'inbound',
            messageId: msg.message_id,
            summary: '[FILTERED] Group message dropped: bot not @mentioned (require_mention=true)',
          });
        } catch { /* best effort */ }
        return;
      }
    }

    // Track last message ID per chat for typing indicator
    this.lastIncomingMessageId.set(chatId, msg.message_id);

    // Extract content based on message type
    const messageType = msg.message_type;
    let text = '';
    const attachments: FileAttachment[] = [];
    let contextPromise: Promise<string | undefined> | null = null;
    const getContextPromise = () => {
      contextPromise ||= this.buildQuotedMessageContext(msg.parent_id);
      return contextPromise;
    };

    if (messageType === 'text') {
      text = this.parseTextContent(msg.content);
    } else if (messageType === 'image') {
      // [P1] Download image with failure fallback
      console.log('[feishu-adapter] Image message received, content:', msg.content);
      const { fileKey, name } = extractFeishuResourceInfo(msg.content);
      console.log('[feishu-adapter] Extracted fileKey:', fileKey);
      if (fileKey) {
        getContextPromise();
        const attachment = await this.downloadResource(msg.message_id, fileKey, 'image', name);
        if (attachment) {
          attachments.push(attachment);
        } else {
          text = '[image download failed]';
          try {
            getBridgeContext().store.insertAuditLog({
              channelType: this.channelType,
              channelProvider: this.provider,
              channelAlias: this.alias,
              chatId,
              direction: 'inbound',
              messageId: msg.message_id,
              summary: `[ERROR] Image download failed for key: ${fileKey}`,
            });
          } catch { /* best effort */ }
        }
      }
    } else if (messageType === 'file' || messageType === 'audio' || messageType === 'video' || messageType === 'media') {
      // [P2] Support file/audio/video/media downloads
      const { fileKey, name } = extractFeishuResourceInfo(msg.content);
      if (fileKey) {
        const resourceType = messageType === 'audio' || messageType === 'video' || messageType === 'media'
          ? messageType
          : 'file';
        getContextPromise();
        const attachment = await this.downloadResource(msg.message_id, fileKey, resourceType, name);
        if (attachment) {
          attachments.push(attachment);
        } else {
          text = `[${messageType} download failed]`;
          try {
            getBridgeContext().store.insertAuditLog({
              channelType: this.channelType,
              channelProvider: this.provider,
              channelAlias: this.alias,
              chatId,
              direction: 'inbound',
              messageId: msg.message_id,
              summary: `[ERROR] ${messageType} download failed for key: ${fileKey}`,
            });
          } catch { /* best effort */ }
        }
      }
    } else if (messageType === 'post') {
      // [P2] Extract text and image keys from rich text (post) messages
      const { extractedText, imageKeys, warnings } = this.parsePostContent(msg.content);
      text = extractedText;
      getContextPromise();
      const imageDownloads = Promise.all(imageKeys.map((key) =>
        this.downloadResource(msg.message_id, key, 'image'),
      ));
      const warningNotice = warnings.length > 0
        ? this.notifyUnsupportedInboundContent(chatId, msg.message_id, warnings)
        : Promise.resolve();
      for (const attachment of await imageDownloads) {
        if (attachment) attachments.push(attachment);
        // Don't add fallback text for individual post images — the text already carries context
      }
      await warningNotice;
    } else if (messageType === 'interactive') {
      text = [
        '用户发送了一张飞书交互卡片。',
        formatInteractiveCardPromptBlock(msg.content),
      ].join('\n');
    } else {
      // Unsupported type — log and skip
      console.log(`[feishu-adapter] Unsupported message type: ${messageType}, msgId: ${msg.message_id}`);
      await this.notifyUnsupportedInboundContent(chatId, msg.message_id, [
        `暂不支持飞书消息类型：${messageType}`,
        '这条消息不会转发给 Codex。请改用文本/富文本、图片或文件重新发送。',
      ]);
      return;
    }

    // Strip @mention markers from text
    text = this.stripMentionMarkers(text);
    const contextText = await getContextPromise();

    if (!text.trim() && attachments.length === 0) return;

    const timestamp = parseInt(msg.create_time, 10) || Date.now();
    const address = {
      channelType: this.channelType,
      channelProvider: this.provider,
      channelAlias: this.alias,
      chatId,
      chatKind: isGroup ? 'group' as const : 'p2p' as const,
      userId,
    };

    // [P1] Check for /perm text command (permission approval fallback)
    const trimmedText = text.trim();
    if (trimmedText.startsWith('/perm ')) {
      const permParts = trimmedText.split(/\s+/);
      // /perm <action> <permId>
      if (permParts.length >= 3) {
        const action = permParts[1]; // allow / allow_session / deny
        const permId = permParts.slice(2).join(' ');
        const callbackData = `perm:${action}:${permId}`;

        const inbound: InboundMessage = {
          messageId: msg.message_id,
          address,
          text: trimmedText,
          timestamp,
          callbackData,
        };
        this.enqueueInboundMessage(inbound);
        return;
      }
    }

    const inbound: InboundMessage = {
      messageId: msg.message_id,
      address,
      text: text.trim(),
      timestamp,
      attachments: attachments.length > 0 ? attachments : undefined,
      contextText,
    };

    // Audit log
    try {
      const summary = attachments.length > 0
        ? `[${attachments.length} attachment(s)] ${text.slice(0, 150)}`
        : text.slice(0, 200);
      getBridgeContext().store.insertAuditLog({
        channelType: this.channelType,
        channelProvider: this.provider,
        channelAlias: this.alias,
        chatId,
        direction: 'inbound',
        messageId: msg.message_id,
        summary,
      });
    } catch { /* best effort */ }

    this.enqueueInboundMessage(inbound);
    this.logQueuedInboundMessage({
      messageId: inbound.messageId,
      chatId,
      messageType,
      text: inbound.text,
      attachmentCount: attachments.length,
    });
  }

  private async handleCloudDocumentCommentEvent(data: unknown): Promise<void> {
    try {
      await this.processCloudDocumentCommentEvent(data);
    } catch (err) {
      console.error(
        '[feishu-adapter] Cloud document comment event failed:',
        err instanceof Error ? err.stack || err.message : err,
      );
    }
  }

  private async handleChatRemovedEvent(
    data: unknown,
    reason: FeishuChatRemovedReason,
    eventType: string,
  ): Promise<void> {
    try {
      this.processChatRemovedEvent(data, reason, eventType);
    } catch (err) {
      console.error(
        `[feishu-adapter] ${eventType} event failed:`,
        err instanceof Error ? err.stack || err.message : err,
      );
    }
  }

  private processChatRemovedEvent(
    data: unknown,
    reason: FeishuChatRemovedReason,
    eventType: string,
  ): void {
    const root = (data && typeof data === 'object') ? data as Record<string, any> : {};
    const event = (root.event && typeof root.event === 'object') ? root.event as Record<string, any> : root;
    const header = (root.header && typeof root.header === 'object') ? root.header as Record<string, any> : {};
    const chatId = firstString(
      event.chat_id,
      event.chatId,
      event.chat?.chat_id,
      event.chat?.chatId,
      root.chat_id,
      root.chatId,
    );
    if (!chatId) {
      console.warn(`[feishu-adapter] ${eventType} ignored: missing chat_id`);
      return;
    }

    const eventId = firstString(header.event_id, root.event_id, root.eventId, event.event_id, event.eventId);
    const timestamp = Number(firstString(header.create_time, root.create_time, event.create_time)) || Date.now();
    const messageId = eventId ? `${eventType}:${eventId}` : `${eventType}:${chatId}:${timestamp}`;
    const inbound: InboundMessage = {
      messageId,
      address: {
        channelType: this.channelType,
        channelProvider: this.provider,
        channelAlias: this.alias,
        chatId,
        chatKind: 'group',
      },
      text: '',
      timestamp,
      raw: data,
      channelEvent: {
        type: 'chat_removed',
        reason,
        eventType,
      },
    };

    this.enqueueInboundMessage(inbound);
    this.logQueuedInboundMessage({
      messageId,
      chatId,
      messageType: eventType,
      text: reason,
      attachmentCount: 0,
    });
  }

  private async processCloudDocumentCommentEvent(data: unknown): Promise<void> {
    const target = this.extractCloudDocumentCommentTarget(data);
    if (!target) {
      console.log('[feishu-adapter] Cloud document comment ignored: missing target');
      return;
    }
    if (target.operatorId && this.botIds.has(target.operatorId)) {
      console.log('[feishu-adapter] Cloud document comment ignored: bot authored comment', {
        fileToken: target.fileToken,
        fileType: target.fileType,
        commentId: target.commentId,
      });
      return;
    }

    const resolvedTarget = await this.resolveCloudDocumentCommentTarget(target);
    if (!resolvedTarget.eventId) {
      console.error('[feishu-adapter] Cloud document comment event rejected: missing event_id', {
        fileToken: resolvedTarget.fileToken,
        fileType: resolvedTarget.fileType,
        commentId: resolvedTarget.commentId,
        replyId: resolvedTarget.replyId,
      });
      return;
    }
    const dedupKey = this.buildCloudDocumentCommentDedupKey(resolvedTarget.eventId);
    if (this.seenMessageIds.has(dedupKey)) {
      console.log('[feishu-adapter] Cloud document comment ignored: duplicate event', {
        fileToken: resolvedTarget.fileToken,
        fileType: resolvedTarget.fileType,
        commentId: resolvedTarget.commentId,
        replyId: resolvedTarget.replyId,
        eventId: resolvedTarget.eventId,
      });
      return;
    }
    this.addToDedup(dedupKey);

    const documentChatBinding = this.findCloudDocumentChatBinding(resolvedTarget);
    if (documentChatBinding) {
      await this.sendCloudDocumentReply({
        provider: 'feishu',
        fileToken: resolvedTarget.fileToken,
        fileType: resolvedTarget.fileType,
        commentId: resolvedTarget.commentId,
        replyId: resolvedTarget.replyId,
      }, [
        '这份云文档已经启用群聊聊天模式。',
        `请到已创建的群聊继续聊天：${documentChatBinding.chatId}`,
        '云文档评论不会再接入 bot 对话。',
      ].join('\n'));
      return;
    }

    const docChatId = this.buildCloudDocumentChatId(resolvedTarget);
    const hasDocumentReplyChatBinding = Boolean(
      getBridgeContext().store.getChannelChat(this.channelType, docChatId),
    );
    const shouldInspectCommentContent = !target.mentioned
      && this.shouldInspectCloudDocumentCommentContentForMention(target);
    if (!target.mentioned && !shouldInspectCommentContent && !hasDocumentReplyChatBinding) {
      console.log('[feishu-adapter] Cloud document comment ignored: bot not mentioned', {
        fileToken: target.fileToken,
        fileType: target.fileType,
        commentId: target.commentId,
        mentionDiagnostics: target.mentionDiagnostics,
      });
      return;
    }

    const resolvedContext = await this.fetchCloudDocumentCommentContext(resolvedTarget);
    const mentioned = target.mentioned || Boolean(resolvedContext.mentionedBotInContent);
    if (!mentioned && !hasDocumentReplyChatBinding) {
      console.log('[feishu-adapter] Cloud document comment ignored: bot not mentioned', {
        fileToken: resolvedTarget.fileToken,
        fileType: resolvedTarget.fileType,
        commentId: resolvedTarget.commentId,
        mentionDiagnostics: resolvedTarget.mentionDiagnostics,
        contentMentionDiagnostics: resolvedContext.contentMentionDiagnostics,
      });
      return;
    }

    if (!resolvedContext.question) {
      console.log('[feishu-adapter] Cloud document comment ignored: empty question', {
        fileToken: resolvedTarget.fileToken,
        commentId: resolvedTarget.commentId,
      });
      return;
    }

    const timestamp = Date.now();
    const typingReactionReplyId = resolvedContext.targetReplyId
      && await this.addCloudDocumentTypingReaction(resolvedTarget, resolvedContext.targetReplyId)
      ? resolvedContext.targetReplyId
      : undefined;
    const messageId = `doc-comment:${resolvedTarget.fileToken}:${resolvedTarget.commentId}:${resolvedTarget.replyId || timestamp}`;
    const questionText = resolvedContext.question.trim();
    const isDocumentChatCommand = /^\/new(?:\s|$)/i.test(questionText);
    const text = isDocumentChatCommand
      ? questionText
      : this.buildCloudDocumentPrompt(resolvedTarget, resolvedContext, {
        continuedDocumentChat: hasDocumentReplyChatBinding && !mentioned,
      });
    const inbound: InboundMessage = {
      messageId,
      address: {
        channelType: this.channelType,
        channelProvider: this.provider,
        channelAlias: this.alias,
        chatId: docChatId,
        userId: resolvedTarget.operatorId,
        displayName: '飞书云文档评论',
        cloudDocument: {
          provider: 'feishu',
          fileToken: resolvedTarget.fileToken,
          fileType: resolvedTarget.fileType,
          commentId: resolvedTarget.commentId,
          operatorId: resolvedTarget.operatorId,
          replyId: resolvedTarget.replyId,
          typingReactionReplyId,
          isWhole: resolvedContext.isWhole,
          quote: resolvedContext.quote,
        },
      },
      text,
      timestamp,
      raw: data,
    };

    try {
      getBridgeContext().store.insertAuditLog({
        channelType: this.channelType,
        channelProvider: this.provider,
        channelAlias: this.alias,
        chatId: docChatId,
        direction: 'inbound',
        messageId,
        summary: `[飞书云文档评论] ${resolvedContext.question.slice(0, 180)}`,
      });
    } catch { /* best effort */ }

    this.enqueueInboundMessage(inbound);
    this.logQueuedInboundMessage({
      messageId,
      chatId: docChatId,
      messageType: 'drive.notice.comment_add_v1',
      text,
      attachmentCount: 0,
    });
  }

  private extractCloudDocumentCommentTarget(data: unknown): FeishuCommentTarget | null {
    const root = (data && typeof data === 'object') ? data as Record<string, any> : {};
    const event = (root.event && typeof root.event === 'object') ? root.event as Record<string, any> : root;
    const header = (root.header && typeof root.header === 'object') ? root.header as Record<string, any> : {};
    const meta = (event.notice_meta && typeof event.notice_meta === 'object') ? event.notice_meta as Record<string, any> : {};
    const fileToken = firstString(
      event.file_token,
      event.fileToken,
      event.obj_token,
      meta.file_token,
      meta.fileToken,
      event.file?.file_token,
    );
    const fileType = normalizeDocumentFileType(firstString(
      event.file_type,
      event.fileType,
      event.obj_type,
      meta.file_type,
      meta.fileType,
      event.file?.file_type,
    ));
    const commentId = firstString(event.comment_id, event.commentId, meta.comment_id, meta.commentId);
    const replyId = firstString(event.reply_id, event.replyId, meta.reply_id, meta.replyId) || undefined;
    const eventId = firstString(header.event_id, root.event_id, root.eventId, event.event_id, event.eventId) || undefined;
    const operatorId = firstString(
      event.operator_id?.open_id,
      event.operator?.open_id,
      event.operator?.operator_id?.open_id,
      event.user_id,
      event.from_user_id,
      event.sender?.sender_id?.open_id,
    ) || undefined;

    if (!fileToken || !fileType || !commentId) return null;
    const mentionSources = [
      { name: 'event.mention_list', value: event.mention_list },
      { name: 'event.mentions', value: event.mentions },
      { name: 'event.mentioned_users', value: event.mentioned_users },
      { name: 'meta.mention_list', value: meta.mention_list },
      { name: 'meta.mentions', value: meta.mentions },
    ];
    const mentionSource = mentionSources.find((source) => Array.isArray(source.value));
    const mentionList = mentionSource?.value as any[] | undefined;
    const toUserId = firstString(event.to_user_id?.open_id, event.to_user_id, meta.to_user_id);
    const mentioned = event.mentionedBot === true
      || event.mentioned_bot === true
      || this.isCloudDocumentMentionListTargetingBot(mentionList)
      || this.botIds.has(toUserId);

    return {
      fileToken,
      fileType,
      commentId,
      replyId,
      eventId,
      operatorId,
      mentioned,
      mentionDiagnostics: this.buildCloudDocumentMentionDiagnostics(
        event,
        mentionSource?.name || null,
        mentionList,
        toUserId,
      ),
    };
  }

  private buildCloudDocumentCommentDedupKey(eventId: string): string {
    return `doc-comment-event:${eventId}`;
  }

  private isCloudDocumentMentionListTargetingBot(mentions: any[] | undefined): boolean {
    if (!mentions || mentions.length === 0 || this.botIds.size === 0) return false;
    return mentions.some((mention) => {
      const candidates = collectFeishuIdCandidates(mention, 'mention')
        .map((candidate) => candidate.value);
      return candidates.some((candidate) => this.botIds.has(candidate));
    });
  }

  private buildCloudDocumentMentionDiagnostics(
    event: Record<string, any>,
    mentionListSource: string | null,
    mentionList: any[] | undefined,
    toUserId: string,
  ): FeishuCommentMentionDiagnostics {
    const mentionCandidates = (mentionList || []).slice(0, 20).map((mention, index) => {
      const keys = mention && typeof mention === 'object'
        ? Object.keys(mention).slice(0, 20)
        : [];
      const candidates = collectFeishuIdCandidates(mention, `mention[${index}]`)
        .slice(0, 30)
        .map((candidate) => ({
          path: candidate.path,
          sha256: shortHash(candidate.value),
          matchedBotId: this.botIds.has(candidate.value),
        }));
      return { index, keys, candidates };
    });

    return {
      mentionedBotFlag: event.mentionedBot,
      mentionedBotSnakeFlag: event.mentioned_bot,
      mentionListSource,
      mentionListLength: mentionList?.length || 0,
      mentionCandidates,
      ...(toUserId
        ? {
            toUserId: {
              sha256: shortHash(toUserId),
              matchedBotId: this.botIds.has(toUserId),
            },
          }
        : {}),
      botIdsKnown: this.botIds.size,
      botIdHashes: [...this.botIds].map((id) => shortHash(id)).sort(),
    };
  }

  private shouldInspectCloudDocumentCommentContentForMention(target: FeishuCommentTarget): boolean {
    const diagnostics = target.mentionDiagnostics;
    return this.botIds.size > 0
      && diagnostics?.mentionListSource === null
      && diagnostics.mentionListLength === 0
      && diagnostics.mentionCandidates.length === 0
      && !diagnostics.toUserId;
  }

  private async resolveCloudDocumentCommentTarget(target: FeishuCommentTarget): Promise<FeishuCommentTarget> {
    if (!this.restClient) return target;
    try {
      const response = await this.withFeishuRequestTimeout<{
        data?: { node?: { obj_token?: string; obj_type?: string } };
      }>(target.fileToken, 'wiki.space.getNode', () => this.restClient!.wiki.v2.space.getNode({
        params: { token: target.fileToken },
      }));
      const node = response?.data?.node;
      const fileType = normalizeDocumentFileType(node?.obj_type);
      if (node?.obj_token && fileType) {
        return {
          ...target,
          fileToken: node.obj_token,
          fileType,
        };
      }
    } catch {
      // 不是 wiki node 时会失败，直接使用原始 file token。
    }
    return target;
  }

  private async fetchCloudDocumentCommentContext(target: FeishuCommentTarget): Promise<FeishuCommentContext> {
    if (!this.restClient) {
      return {
        question: '',
        isWhole: false,
        mentionedBotInContent: false,
        contentMentionDiagnostics: {
          elementCount: 0,
          personCandidates: [],
        },
      };
    }

    let comment: FeishuCommentItem | null = null;
    try {
      const response = await this.withFeishuRequestTimeout<{
        data?: FeishuCommentItem;
      }>(target.fileToken, 'drive.fileComment.get', () => this.restClient!.drive.v1.fileComment.get({
        params: {
          file_type: target.fileType,
          user_id_type: 'open_id',
        },
        path: {
          file_token: target.fileToken,
          comment_id: target.commentId,
        },
      }));
      comment = response?.data || null;
    } catch {
      comment = await this.findCloudDocumentCommentViaList(target);
    }

    const replies = comment?.reply_list?.replies || [];
    const targetReply = (
      target.replyId
        ? replies.find((reply) => reply.reply_id === target.replyId)
        : null
    ) || replies.at(-1);
    const elements = targetReply?.content?.elements;
    const contentMentionDiagnostics = this.buildCloudDocumentContentMentionDiagnostics(
      elements,
      targetReply?.reply_id,
    );
    return {
      question: commentTextFromElements(elements),
      quote: comment?.quote || undefined,
      isWhole: Boolean(comment?.is_whole),
      targetReplyId: targetReply?.reply_id,
      mentionedBotInContent: contentMentionDiagnostics.personCandidates.some((candidate) => candidate.matchedBotId),
      contentMentionDiagnostics,
    };
  }

  private buildCloudDocumentContentMentionDiagnostics(
    elements: FeishuCommentReplyElement[] | undefined,
    targetReplyId?: string,
  ): FeishuCommentContentMentionDiagnostics {
    const personCandidates = (elements || [])
      .flatMap((element, index) => {
        if (element.type !== 'person') return [];
        return collectFeishuIdCandidates(element.person, `reply.content.elements[${index}].person`);
      })
      .slice(0, 30)
      .map((candidate) => ({
        path: candidate.path,
        sha256: shortHash(candidate.value),
        matchedBotId: this.botIds.has(candidate.value),
      }));

    return {
      ...(targetReplyId ? { targetReplyId } : {}),
      elementCount: elements?.length || 0,
      personCandidates,
    };
  }

  private async addCloudDocumentTypingReaction(target: FeishuCommentTarget, replyId: string): Promise<boolean> {
    return await this.updateCloudDocumentTypingReaction(target.fileToken, target.fileType, replyId, 'add');
  }

  private async removeCloudDocumentTypingReaction(target: CloudDocumentAddress, replyId: string): Promise<void> {
    await this.updateCloudDocumentTypingReaction(target.fileToken, target.fileType, replyId, 'delete');
  }

  private async updateCloudDocumentTypingReaction(
    fileToken: string,
    fileType: FeishuDocumentFileType,
    replyId: string,
    action: 'add' | 'delete',
  ): Promise<boolean> {
    if (!this.restClient) return false;
    try {
      await this.withFeishuRequestTimeout(fileToken, `drive.commentReaction.${action}`, () => (this.restClient as any).request({
        method: 'POST',
        url: `/open-apis/drive/v2/files/${encodeURIComponent(fileToken)}/comments/reaction?file_type=${encodeURIComponent(fileType)}`,
        data: {
          action,
          reply_id: replyId,
          reaction_type: 'Typing',
        },
      }));
      return true;
    } catch (err) {
      console.warn('[feishu-adapter] Cloud document Typing reaction failed:', {
        action,
        fileToken,
        replyId,
        error: feishuErrorSummary(err, '飞书云文档评论表情操作失败'),
      });
      return false;
    }
  }

  private async findCloudDocumentCommentViaList(target: FeishuCommentTarget): Promise<FeishuCommentItem | null> {
    if (!this.restClient) return null;
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = await this.withFeishuRequestTimeout<{
        data?: { items?: FeishuCommentItem[]; has_more?: boolean; page_token?: string };
      }>(target.fileToken, 'drive.fileComment.list', () => this.restClient!.drive.v1.fileComment.list({
        params: {
          file_type: target.fileType,
          page_size: 100,
          user_id_type: 'open_id',
          ...(pageToken ? { page_token: pageToken } : {}),
        },
        path: { file_token: target.fileToken },
      }));
      const hit = response?.data?.items?.find((item) => item.comment_id === target.commentId);
      if (hit) return hit;
      if (!response?.data?.has_more || !response.data.page_token) break;
      pageToken = response.data.page_token;
    }
    return null;
  }

  private buildCloudDocumentChatId(target: Pick<FeishuCommentTarget, 'fileType' | 'fileToken' | 'commentId'>): string {
    return `doc:${target.fileType}:${target.fileToken}:comment:${target.commentId}`;
  }

  private findCloudDocumentChatBinding(target: Pick<FeishuCommentTarget, 'fileType' | 'fileToken' | 'commentId'>) {
    return getBridgeContext().store.listChannelChats(this.channelType)
      .find((binding) => (
        binding.cloudDocumentChat?.provider === 'feishu'
        && binding.cloudDocumentChat.fileToken === target.fileToken
        && binding.cloudDocumentChat.fileType === target.fileType
        && binding.cloudDocumentChat.commentId === target.commentId
      )) || null;
  }

  private buildCloudDocumentPrompt(target: FeishuCommentTarget, context: {
    question: string;
    quote?: string;
    isWhole: boolean;
  }, options: { continuedDocumentChat?: boolean } = {}): string {
    const docHost = this.site === 'lark' ? 'https://larksuite.com' : 'https://feishu.cn';
    const docUrl = `${docHost}/${target.fileType}/${target.fileToken}`;
    const parts = [
      options.continuedDocumentChat
        ? '这份飞书云文档已经绑定为评论回复会话；本条云文档评论是同一文档评论会话里的后续用户消息。请结合当前会话上下文和文档评论上下文回答，最终回复会直接写回同一个云文档评论线程。'
        : '我在飞书云文档评论里被 @ 了。请根据文档评论上下文回答，并且最终回复会直接写回同一个云文档评论线程。',
      '',
      '文档信息：',
      `- 链接：${docUrl}`,
      `- file_token：${target.fileToken}`,
      `- file_type：${target.fileType}`,
      `- comment_id：${target.commentId}`,
      target.replyId ? `- reply_id：${target.replyId}` : '',
      `- 评论范围：${context.isWhole ? '全文评论' : '局部评论'}`,
      context.quote ? `\n用户选中的原文：\n> ${context.quote.replace(/\n/g, '\n> ')}` : '',
      '',
      `用户的问题：${context.question}`,
      '',
      '需要读取或修改文档正文时，可以直接使用 lark-cli：',
      `- 读取：lark-cli docs +fetch --api-version v2 --as bot --doc ${target.fileToken}`,
      `- 追加：lark-cli docs +update --api-version v2 --as bot --doc ${target.fileToken} --mode append --markdown '<内容>'`,
      `- 按标题/选区替换：lark-cli docs +update --api-version v2 --as bot --doc ${target.fileToken} --mode replace_range --selection-by-title '<标题>' --markdown '<内容>'`,
      '如果 lark-cli 提示权限不足，请在回复中明确说明需要给机器人或应用补充对应云文档权限。',
      '',
      '回复要求：直接回答用户问题；不要输出 Markdown 装饰语法、代码块或 XML 标签。云文档评论不会按 Markdown 渲染。',
    ].filter(Boolean);
    return parts.join('\n');
  }

  // ── Content parsing ─────────────────────────────────────────

  private parseTextContent(content: string): string {
    try {
      const parsed = JSON.parse(content);
      return parsed.text || '';
    } catch {
      return content;
    }
  }

  /**
   * Parse rich text (post) content.
   * Extracts plain text from text elements and image keys from img elements.
   */
  private async notifyUnsupportedInboundContent(chatId: string, messageId: string, warnings: string[]): Promise<void> {
    const uniqueWarnings = Array.from(new Set(warnings.map((warning) => warning.trim()).filter(Boolean))).slice(0, 5);
    if (uniqueWarnings.length === 0) return;
    const omitted = warnings.length > uniqueWarnings.length
      ? `\n- 另外还有 ${warnings.length - uniqueWarnings.length} 条同类提示已省略。`
      : '';
    const text = [
      '这条飞书消息包含当前暂不支持的内容：',
      ...uniqueWarnings.map((warning) => `- ${warning}`),
      omitted,
    ].join('\n').trim();

    try {
      const result = await this.sendAsPlainText(chatId, text, messageId);
      if (!result.ok) {
        console.warn('[feishu-adapter] Unsupported content notice failed:', result.error || 'unknown error');
      }
    } catch (error) {
      console.warn('[feishu-adapter] Unsupported content notice error:', error instanceof Error ? error.message : error);
    }
  }

  private parsePostContent(content: string): FeishuPostParseResult {
    return parseFeishuPostContent(content);
  }

  // ── Bot identity ────────────────────────────────────────────

  /**
   * Resolve bot identity via the Feishu REST API /bot/v3/info/.
   * Collects all available bot IDs for comprehensive mention matching.
   */
  private async resolveBotIdentity(
    appId: string,
    appSecret: string,
    domain: lark.Domain,
  ): Promise<void> {
    try {
      const baseUrl = domain === lark.Domain.Lark
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn';

      const tokenRes = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(10_000),
      });
      const tokenData: any = await tokenRes.json();
      if (!tokenData.tenant_access_token) {
        console.warn('[feishu-adapter] Failed to get tenant access token');
        return;
      }

      const botRes = await fetch(`${baseUrl}/open-apis/bot/v3/info/`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const botData: any = await botRes.json();
      if (botData?.bot?.open_id) {
        this.botOpenId = botData.bot.open_id;
        this.botIds.add(botData.bot.open_id);
      }
      // Also record app_id-based IDs if available
      if (botData?.bot?.bot_id) {
        this.botId = botData.bot.bot_id;
        this.botIds.add(botData.bot.bot_id);
      }
      this.botName = botData?.bot?.app_name || botData?.bot?.name || this.botName;
      this.botAvatarUrl = botData?.bot?.avatar_url || this.botAvatarUrl;
      if (!this.botOpenId) {
        console.warn('[feishu-adapter] Could not resolve bot open_id', {
          preview: JSON.stringify(botData).slice(0, 1000),
        });
      }
    } catch (err) {
      console.warn(
        '[feishu-adapter] Failed to resolve bot identity:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── @Mention detection ──────────────────────────────────────

  /**
   * [P2] Check if bot is mentioned — matches against open_id, user_id, union_id.
   */
  private isBotMentioned(
    mentions?: FeishuMessageEventData['message']['mentions'],
  ): boolean {
    if (!mentions || this.botIds.size === 0) return false;
    return mentions.some((m) => {
      const ids = [m.id.open_id, m.id.user_id, m.id.union_id].filter(Boolean) as string[];
      return ids.some((id) => this.botIds.has(id));
    });
  }

  private stripMentionMarkers(text: string): string {
    // Feishu uses @_user_N placeholders for mentions
    return text.replace(/@_user_\d+/g, '').trim();
  }

  // ── Resource download ───────────────────────────────────────

  /**
   * Download a message resource (image/file/audio/video) via SDK.
   * Returns null on failure (caller decides fallback behavior).
   */
  private async downloadResource(
    messageId: string,
    fileKey: string,
    resourceType: string,
    originalName?: string,
  ): Promise<FileAttachment | null> {
    if (!this.restClient) return null;

    try {
      console.log(`[feishu-adapter] Downloading resource: type=${resourceType}, key=${fileKey}, msgId=${messageId}`);

      const res = await this.restClient.im.messageResource.get({
        path: {
          message_id: messageId,
          file_key: fileKey,
        },
        params: {
          type: resourceType === 'image' ? 'image' : 'file',
        },
      });

      if (!res) {
        console.warn('[feishu-adapter] messageResource.get returned null/undefined');
        return null;
      }

      // SDK returns { writeFile, getReadableStream, headers }
      // Try stream approach first, fall back to writeFile + read if stream fails
      let buffer: Buffer;

      try {
        const readable = res.getReadableStream();
        const chunks: Buffer[] = [];
        let totalSize = 0;

        for await (const chunk of readable) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalSize += buf.length;
          if (totalSize > MAX_FILE_SIZE) {
            console.warn(`[feishu-adapter] Resource too large (>${MAX_FILE_SIZE} bytes), key: ${fileKey}`);
            return null;
          }
          chunks.push(buf);
        }
        buffer = Buffer.concat(chunks);
      } catch (streamErr) {
        // Stream approach failed — fall back to writeFile + read
        console.warn('[feishu-adapter] Stream read failed, falling back to writeFile:', streamErr instanceof Error ? streamErr.message : streamErr);

        const fs = await import('fs');
        const os = await import('os');
        const path = await import('path');
        const tmpPath = path.join(os.tmpdir(), `feishu-dl-${crypto.randomUUID()}`);
        try {
          await res.writeFile(tmpPath);
          buffer = await fs.promises.readFile(tmpPath);
          if (buffer.length > MAX_FILE_SIZE) {
            console.warn(`[feishu-adapter] Resource too large (>${MAX_FILE_SIZE} bytes), key: ${fileKey}`);
            return null;
          }
        } finally {
          try { await fs.promises.unlink(tmpPath); } catch { /* ignore cleanup errors */ }
        }
      }

      if (!buffer || buffer.length === 0) {
        console.warn('[feishu-adapter] Downloaded resource is empty, key:', fileKey);
        return null;
      }

      const base64 = buffer.toString('base64');
      const id = crypto.randomUUID();
      const mimeType = MIME_BY_TYPE[resourceType] || 'application/octet-stream';
      const ext = resourceType === 'image' ? 'png'
        : resourceType === 'audio' ? 'ogg'
        : resourceType === 'video' ? 'mp4'
        : 'bin';

      console.log(`[feishu-adapter] Resource downloaded: ${buffer.length} bytes, key=${fileKey}`);

      return {
        id,
        name: originalName || `${fileKey}.${ext}`,
        type: mimeType,
        size: buffer.length,
        data: base64,
      };
    } catch (err) {
      console.error(
        `[feishu-adapter] Resource download failed (type=${resourceType}, key=${fileKey}):`,
        err instanceof Error ? err.stack || err.message : err,
      );
      return null;
    }
  }

  // ── Utilities ───────────────────────────────────────────────

  private addToDedup(messageId: string): void {
    this.seenMessageIds.set(messageId, true);

    // LRU eviction: remove oldest entries when exceeding limit
    if (this.seenMessageIds.size > DEDUP_MAX) {
      const excess = this.seenMessageIds.size - DEDUP_MAX;
      let removed = 0;
      for (const key of this.seenMessageIds.keys()) {
        if (removed >= excess) break;
        this.seenMessageIds.delete(key);
        removed++;
      }
    }
  }
}

// Self-register so bridge-manager can create FeishuAdapter via the registry.
registerAdapterFactory('feishu', (instance) => new FeishuAdapter(instance));

export const _testOnly = {
  buildWsClientOptions,
  buildHttpInstanceWithEnvProxy,
  countFeishuCardComponents,
  extractFeishuResourceInfo,
  getProxyUrlForUrl,
  getWsProxyUrl,
  maskProxyUrl,
  formatInteractiveCardPromptBlock,
  formatQuotedMessageContext,
  parseFeishuPostContent,
  shouldBypassProxy,
  withHttpProxyOptions,
};
