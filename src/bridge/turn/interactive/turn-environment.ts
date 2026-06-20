import type { BridgeSession } from '../../../domain/index.js';
import type {
  ChannelAddress,
  ChannelChat,
} from '../../../domain/index.js';
import { buildInteractiveStreamKey } from '../../mirror/formatters.js';
import {
  buildRuntimeStreamTags,
  buildStreamContextTags,
} from '../../../shared/streaming-metadata.js';
import { getGlobalDefaultChannelConfig } from '../../session/global-config.js';
import { classifyInteractiveTurn } from '../turn-classifier.js';
import type { BridgeTurnClassification } from '../turn-types.js';

export interface InteractiveStreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}

export interface InteractiveStreamStatusTimingConfig {
  idleStartMs: number;
  heartbeatMs: number;
}

export interface InteractiveTurnRuntimeSettings {
  stream: InteractiveStreamConfig;
  statusTiming: InteractiveStreamStatusTimingConfig;
}

export type ReadInteractiveTurnSetting = (key: string) => string | null | undefined;

export type ResolveInteractiveTurnRuntimeSettings = (
  channelType?: string,
) => InteractiveTurnRuntimeSettings;

export interface InteractiveTurnEnvironment {
  binding: ChannelChat;
  initialSession: BridgeSession | null;
  classification: BridgeTurnClassification;
  codexThreadId?: string;
  streamKey: string;
}

export interface BuildInteractiveTurnEnvironmentOptions {
  binding: ChannelChat;
  initialSession: BridgeSession | null;
  classification: BridgeTurnClassification;
  messageId: string;
}

export type ResolveInteractiveTurnEnvironment = (
  address: ChannelAddress,
  messageId: string,
) => InteractiveTurnEnvironment;

export interface ResolveInteractiveTurnEnvironmentPorts {
  resolveBinding(address: ChannelAddress): ChannelChat;
  getBridgeSession(sessionId: string): BridgeSession | null;
  codexThreadExists(threadId: string): boolean;
}

export interface InteractiveTurnDisplayInfo {
  title: string;
  bridgeSessionId?: string | null;
  threadId?: string | null;
  runtime?: 'codex' | 'claude' | null;
  executionProvider?: string | null;
  creatorKind?: string | null;
  reasoningEffort?: string | null;
  model?: string | null;
}

export type ResolveInteractiveTurnDisplayInfo = (binding: ChannelChat) => InteractiveTurnDisplayInfo;

export type ListInteractiveTurnBindings = (channelType: ChannelAddress['channelType']) => ChannelChat[];

export interface StaleTaskCompletionNoticePorts {
  listChannelChats?: ListInteractiveTurnBindings;
  resolveDisplayInfo?: ResolveInteractiveTurnDisplayInfo;
}

const SYNTHETIC_BINDING_PREFIXES = ['every:', 'then:'] as const;

const STREAM_DEFAULTS: Record<string, InteractiveStreamConfig> = {
  default: { intervalMs: 1000, minDeltaChars: 30, maxChars: 4000 },
};

const STREAM_STATUS_IDLE_START_MS = 180_000;
const STREAM_STATUS_HEARTBEAT_MS = 10_000;

export function resolveInteractiveTurnRuntimeSettings(
  channelType = 'default',
  readSetting: ReadInteractiveTurnSetting,
): InteractiveTurnRuntimeSettings {
  const defaults = STREAM_DEFAULTS[channelType] || STREAM_DEFAULTS.default;
  const prefix = `bridge_${channelType}_stream_`;
  const intervalMs = parseInt(readSetting(`${prefix}interval_ms`) || '', 10) || defaults.intervalMs;
  const minDeltaChars = parseInt(readSetting(`${prefix}min_delta_chars`) || '', 10) || defaults.minDeltaChars;
  const maxChars = parseInt(readSetting(`${prefix}max_chars`) || '', 10) || defaults.maxChars;
  const channelConfig = getGlobalDefaultChannelConfig();
  const idleStartSeconds = channelConfig?.streamStatusIdleStartSeconds;
  const heartbeatSeconds = channelConfig?.streamStatusCheckIntervalSeconds;
  return {
    stream: { intervalMs, minDeltaChars, maxChars },
    statusTiming: {
      idleStartMs: Math.max(
        0,
        (typeof idleStartSeconds === 'number' && Number.isFinite(idleStartSeconds) && idleStartSeconds > 0
          ? idleStartSeconds
          : STREAM_STATUS_IDLE_START_MS / 1000) * 1000,
      ),
      heartbeatMs: Math.max(
        1_000,
        (typeof heartbeatSeconds === 'number' && Number.isFinite(heartbeatSeconds) && heartbeatSeconds > 0
          ? heartbeatSeconds
          : STREAM_STATUS_HEARTBEAT_MS / 1000) * 1000,
      ),
    },
  };
}

export function buildInteractiveTurnEnvironment(
  options: BuildInteractiveTurnEnvironmentOptions,
): InteractiveTurnEnvironment {
  return {
    binding: options.binding,
    initialSession: options.initialSession,
    classification: options.classification,
    codexThreadId: options.classification.codexThreadId,
    streamKey: buildInteractiveStreamKey(options.binding.bridgeSessionId, options.messageId),
  };
}

export function resolveInteractiveTurnEnvironment(
  address: ChannelAddress,
  messageId: string,
  ports: ResolveInteractiveTurnEnvironmentPorts,
): InteractiveTurnEnvironment {
  const binding = ports.resolveBinding(address);
  const initialSession = ports.getBridgeSession(binding.bridgeSessionId);
  const classification = classifyInteractiveTurn(
    binding,
    initialSession,
    ports.codexThreadExists,
  );
  return buildInteractiveTurnEnvironment({
    binding,
    initialSession,
    classification,
    messageId,
  });
}

export function buildFallbackInteractiveTurnDisplayInfo(binding: ChannelChat): InteractiveTurnDisplayInfo {
  const title = binding.bridgeSessionId.slice(0, 8);
  return {
    title,
    bridgeSessionId: binding.bridgeSessionId,
    threadId: '',
    runtime: 'codex',
    executionProvider: 'default',
    creatorKind: 'bridge',
  };
}

export function buildInteractiveStreamCardMetadata(
  binding: ChannelChat,
  resolveDisplayInfo: ResolveInteractiveTurnDisplayInfo = buildFallbackInteractiveTurnDisplayInfo,
) {
  const fallback = buildFallbackInteractiveTurnDisplayInfo(binding);
  const display = resolveDisplayInfo(binding);
  const title = display.title?.trim() || fallback.title;
  return {
    title,
    tags: [
      ...buildRuntimeStreamTags({
        runtime: display.runtime || fallback.runtime,
        reasoningEffort: display.reasoningEffort,
        model: display.model,
      }),
      ...buildStreamContextTags({
        bindingId: binding.id,
        bridgeSessionId: display.bridgeSessionId || fallback.bridgeSessionId,
        threadId: display.threadId || fallback.threadId,
        executionProvider: display.executionProvider || fallback.executionProvider,
        creatorKind: display.creatorKind || fallback.creatorKind,
        source: 'sdk',
      }),
    ],
  };
}

export function buildStaleTaskCompletionNotice(
  address: ChannelAddress,
  binding: ChannelChat,
  ports: StaleTaskCompletionNoticePorts = {},
): string | null {
  const bindings = ports.listChannelChats?.(address.channelType);
  if (!bindings) return null;
  const isSyntheticBinding = SYNTHETIC_BINDING_PREFIXES.some((prefix) => binding.id.startsWith(prefix));
  const stillBound = bindings.some((item) => (
    item.chatId === address.chatId
    && (item.id === binding.id || (isSyntheticBinding && item.bridgeSessionId === binding.bridgeSessionId))
    && item.bridgeSessionId === binding.bridgeSessionId
  ));
  if (stillBound) return null;
  const taskName = (ports.resolveDisplayInfo || buildFallbackInteractiveTurnDisplayInfo)(binding).title;
  return `旧会话「${taskName}」任务已结束，但当前聊天已解绑该会话，回复已跳过。`;
}
