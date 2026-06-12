import { createAdapter, type BaseChannelAdapter } from '../contracts.js';
import type { InboundMessage } from '../../domain/index.js';
import { getLogger } from '../../shared/logger.js';
import { listConfiguredChannelInstances } from './channel-runtime.js';
import {
  buildAdapterSyncPlan,
  listEnabledAdapterInstances,
} from './sync-plan.js';

export interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
  configFingerprint: string;
}

export interface BridgeAdapterRuntimeState {
  adapters: Map<string, BaseChannelAdapter>;
  adapterMeta: Map<string, AdapterMeta>;
  invalidAdapters: Map<string, string>;
  loopAborts: Map<string, AbortController>;
  running: boolean;
}

export interface CreateAdapterRuntimeDeps {
  notifyAdapterSetChanged(channelTypes: string[]): void;
  handleMessage(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<void>;
  processWithSessionLock(sessionId: string, fn: () => Promise<void>, options?: { jobKind?: string }): Promise<void>;
  isNumericPermissionShortcut(channelType: string, rawText: string, chatId: string): boolean;
  isCommandMessage?(msg: InboundMessage): boolean;
  resolveSessionIdForMessage(msg: InboundMessage): string;
  shouldBypassSessionLock?(msg: InboundMessage): boolean;
  getImmediateLane?(msg: InboundMessage, category: AdapterMessageCategory): AdapterImmediateLane | null;
  getSessionLane?(msg: InboundMessage, category: AdapterMessageCategory): AdapterSessionLane | null;
}

export interface AdapterRuntime {
  getActiveChannelTypes(): string[];
  stopAdapterInstance(channelType: string): Promise<void>;
  syncConfiguredAdapters(options: { startLoops: boolean }): Promise<void>;
  runAdapterLoop(adapter: BaseChannelAdapter): void;
  clearWarningCache(): void;
}

const INVALID_ADAPTER_WARNING_CACHE = new Map<string, string>();
const ADAPTER_HANDLER_SLOW_MS = 2_000;
const ADAPTER_HANDLER_QUEUE_SLOW_MS = 1_000;
const logger = getLogger('adapter-runtime').child({ component: 'bridge-manager' });

type AdapterMessageCategory = 'channel-event' | 'callback' | 'command' | 'permission-shortcut' | 'bypass' | 'regular';

interface AdapterMessageTimelineContext {
  onSessionLockAcquired(): void;
}

interface AdapterMessageTimelineOptions {
  sessionId?: string;
  usesSessionLock: boolean;
  laneKind: 'chat' | 'control' | 'job' | 'session';
  jobKind: string;
}

export interface AdapterImmediateLane {
  laneKey: string;
  laneKind: 'control' | 'job';
  jobKind: string;
  waitForConversationBarrier?: boolean;
}

export interface AdapterSessionLane {
  sessionId: string;
  jobKind: string;
  blocksConversation?: boolean;
}

interface AdapterLaneSpanInfo {
  spanId: string;
  messageId?: string;
  sessionId?: string;
  category: AdapterMessageCategory;
  scheduledAtMs: number;
  startedAtMs: number | null;
}

export function createAdapterRuntime(
  getState: () => BridgeAdapterRuntimeState,
  deps: CreateAdapterRuntimeDeps,
): AdapterRuntime {
  const laneTails = new Map<string, Promise<void>>();
  const laneTailSpans = new Map<string, AdapterLaneSpanInfo>();
  const chatBarrierTails = new Map<string, Promise<void>>();
  const chatBarrierSpans = new Map<string, AdapterLaneSpanInfo>();
  const activeConversationJobs = new Map<string, Set<Promise<void>>>();
  let nextSpanSeq = 0;

  function getActiveChannelTypes(): string[] {
    return Array.from(getState().adapters.keys()).sort();
  }

  function adapterMessageLogFields(
    event:
      | 'adapter.message.scheduled'
      | 'adapter.message.started'
      | 'adapter.message.wait'
      | 'adapter.session_lock.acquired'
      | 'adapter.message.finished'
      | 'adapter.message.error'
      | 'adapter.message.handler',
    durationMs: number,
    laneKey: string,
    msg: InboundMessage,
    category: AdapterMessageCategory,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const text = msg.text.replace(/\s+/g, ' ').trim();
    const preview = text.length > 80 ? `${text.slice(0, 77)}...` : text;
    const nowMs = Date.now();
    const messageTimestampMs = Number.isFinite(msg.timestamp) && msg.timestamp > 0
      ? msg.timestamp
      : null;
    return {
      event,
      duration_ms: durationMs,
      lane: laneKey,
      channel: msg.address.channelType,
      chat: msg.address.chatId,
      category,
      lane_kind: extra.lane_kind,
      job_kind: extra.job_kind,
      span_kind: 'adapter.message',
      ...(msg.messageId ? { message: msg.messageId, message_id: msg.messageId } : {}),
      ...(messageTimestampMs ? {
        message_timestamp_ms: messageTimestampMs,
        message_age_ms: Math.max(0, nowMs - messageTimestampMs),
      } : {}),
      ...(preview ? { text: preview } : {}),
      ...extra,
    };
  }

  function classifyMessage(msg: InboundMessage): { category: AdapterMessageCategory; bypassSessionLock: boolean } {
    if (msg.channelEvent) return { category: 'channel-event', bypassSessionLock: true };
    if (msg.callbackData) return { category: 'callback', bypassSessionLock: true };
    if (deps.isCommandMessage?.(msg)) return { category: 'command', bypassSessionLock: true };
    if (deps.isNumericPermissionShortcut(msg.address.channelType, msg.text.trim(), msg.address.chatId)) {
      return { category: 'permission-shortcut', bypassSessionLock: true };
    }
    if (deps.shouldBypassSessionLock?.(msg)) return { category: 'bypass', bypassSessionLock: true };
    return { category: 'regular', bypassSessionLock: false };
  }

  function chatLaneKey(msg: InboundMessage): string {
    return `chat:${msg.address.channelType}:${msg.address.chatId}`;
  }

  function nextAdapterMessageSpanId(msg: InboundMessage): string {
    nextSpanSeq += 1;
    return [
      'adapter-message',
      msg.address.channelType,
      msg.address.chatId,
      msg.messageId || `seq-${nextSpanSeq}`,
    ].map((part) => String(part).replace(/[^A-Za-z0-9_.:-]/g, '_')).join(':');
  }

  function baseSpanFields(
    spanId: string,
    laneKey: string,
    options: AdapterMessageTimelineOptions,
    scheduledAtMs: number,
  ): Record<string, unknown> {
    return {
      span_id: spanId,
      parent_span_id: laneKey,
      session_id: options.sessionId,
      uses_session_lock: options.usesSessionLock,
      lane_kind: options.laneKind,
      job_kind: options.jobKind,
      scheduled_at_ms: scheduledAtMs,
    };
  }

  function blockedByFields(blockedBy: AdapterLaneSpanInfo | null, observedAtMs: number): Record<string, unknown> {
    if (!blockedBy) return {};
    const blockedByStartedAtMs = blockedBy.startedAtMs;
    return {
      blocked_by_span_id: blockedBy.spanId,
      blocked_by_message_id: blockedBy.messageId,
      blocked_by_session_id: blockedBy.sessionId,
      blocked_by_category: blockedBy.category,
      blocked_by_scheduled_at_ms: blockedBy.scheduledAtMs,
      blocked_by_started_at_ms: blockedByStartedAtMs,
      blocked_by_age_ms: Math.max(0, observedAtMs - (blockedByStartedAtMs ?? blockedBy.scheduledAtMs)),
    };
  }

  function recordAdapterHandlerError(adapter: BaseChannelAdapter, err: unknown): void {
    const errMsg = err instanceof Error ? err.message : String(err);
    const state = getState();
    const meta = state.adapterMeta.get(adapter.channelType) || {
      lastMessageAt: null,
      lastError: null,
      configFingerprint: '',
    };
    meta.lastError = errMsg;
    state.adapterMeta.set(adapter.channelType, meta);
  }

  function scheduleImmediateMessage(
    adapter: BaseChannelAdapter,
    msg: InboundMessage,
    category: AdapterMessageCategory,
    laneKey: string,
    options: AdapterMessageTimelineOptions,
    fn: (context: AdapterMessageTimelineContext) => Promise<void>,
    beforeStart?: {
      waitFor: Promise<void>;
      blockedBy: AdapterLaneSpanInfo | null;
    },
  ): Promise<void> {
    const scheduledAtMs = Date.now();
    const spanId = nextAdapterMessageSpanId(msg);
    logger.info(
      adapterMessageLogFields('adapter.message.scheduled', 0, laneKey, msg, category, {
        ...baseSpanFields(spanId, laneKey, options, scheduledAtMs),
        ...blockedByFields(beforeStart?.blockedBy || null, scheduledAtMs),
      }),
      'adapter message scheduled',
    );

    const current = Promise.resolve().then(async () => {
      if (beforeStart) {
        await beforeStart.waitFor.catch(() => undefined);
      }
      const startedAtMs = Date.now();
      const waitMs = startedAtMs - scheduledAtMs;
      const startedFields = {
        ...baseSpanFields(spanId, laneKey, options, scheduledAtMs),
        ...blockedByFields(beforeStart?.blockedBy || null, startedAtMs),
        started_at_ms: startedAtMs,
        lane_wait_ms: waitMs,
      };
      logger.info(
        adapterMessageLogFields('adapter.message.started', waitMs, laneKey, msg, category, startedFields),
        'adapter message started',
      );

      if (waitMs >= ADAPTER_HANDLER_QUEUE_SLOW_MS) {
        logger.warn(
          adapterMessageLogFields('adapter.message.wait', waitMs, laneKey, msg, category, startedFields),
          'slow adapter message queue wait',
        );
      }

      let lockAcquired = false;
      let lockWaitMs = 0;
      const context: AdapterMessageTimelineContext = {
        onSessionLockAcquired: () => {
          if (!options.usesSessionLock) return;
          if (lockAcquired) return;
          lockAcquired = true;
          const lockAcquiredAtMs = Date.now();
          lockWaitMs = lockAcquiredAtMs - startedAtMs;
          logger.info(
            adapterMessageLogFields('adapter.session_lock.acquired', lockWaitMs, laneKey, msg, category, {
              ...baseSpanFields(spanId, laneKey, options, scheduledAtMs),
              started_at_ms: startedAtMs,
              session_lock_wait_ms: lockWaitMs,
            }),
            'adapter session lock acquired',
          );
        },
      };

      let status: 'success' | 'error' = 'success';
      let errorMessage: string | undefined;
      try {
        await fn(context);
      } catch (err) {
        status = 'error';
        errorMessage = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        const endedAtMs = Date.now();
        const elapsedMs = endedAtMs - startedAtMs;
        const totalMs = endedAtMs - scheduledAtMs;
        const finishedFields = {
          ...baseSpanFields(spanId, laneKey, options, scheduledAtMs),
          ...blockedByFields(beforeStart?.blockedBy || null, endedAtMs),
          status,
          started_at_ms: startedAtMs,
          ended_at_ms: endedAtMs,
          finished_at_ms: endedAtMs,
          total_ms: totalMs,
          lane_wait_ms: waitMs,
          ...(options.usesSessionLock ? {
            session_lock_wait_ms: lockAcquired ? lockWaitMs : elapsedMs,
            session_lock_acquired: lockAcquired,
          } : {}),
          ...(errorMessage ? { error: errorMessage } : {}),
        };
        logger.info(
          adapterMessageLogFields('adapter.message.finished', elapsedMs, laneKey, msg, category, finishedFields),
          'adapter message finished',
        );
        if (elapsedMs >= ADAPTER_HANDLER_SLOW_MS) {
          logger.warn(
            adapterMessageLogFields('adapter.message.handler', elapsedMs, laneKey, msg, category, finishedFields),
            'slow adapter message handler',
          );
        }
      }
    });

    current.catch((err) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(
        adapterMessageLogFields('adapter.message.error', 0, laneKey, msg, category, {
          ...baseSpanFields(spanId, laneKey, options, scheduledAtMs),
          ...blockedByFields(beforeStart?.blockedBy || null, Date.now()),
          error: errorMessage,
        }),
        'adapter message handler failed',
      );
      recordAdapterHandlerError(adapter, err);
    });
    return current;
  }

  function scheduleSessionLockedMessage(
    adapter: BaseChannelAdapter,
    msg: InboundMessage,
    category: AdapterMessageCategory,
    sessionLane: AdapterSessionLane,
  ): Promise<void> {
    const { sessionId, jobKind } = sessionLane;
    if (sessionLane.blocksConversation) {
      return scheduleSessionConversationBarrierMessage(adapter, msg, category, sessionLane);
    }
    return scheduleImmediateMessage(
      adapter,
      msg,
      category,
      `session:${sessionId}`,
      {
        sessionId,
        usesSessionLock: true,
        laneKind: 'session',
        jobKind,
      },
      (context) => deps.processWithSessionLock(sessionId, async () => {
        context.onSessionLockAcquired();
        await deps.handleMessage(adapter, msg);
      }, { jobKind }),
    );
  }

  function trackConversationJob(chatKey: string, job: Promise<void>): void {
    let active = activeConversationJobs.get(chatKey);
    if (!active) {
      active = new Set();
      activeConversationJobs.set(chatKey, active);
    }
    active.add(job);
    job.finally(() => {
      const current = activeConversationJobs.get(chatKey);
      if (!current) return;
      current.delete(job);
      if (current.size === 0) activeConversationJobs.delete(chatKey);
    }).catch(() => undefined);
  }

  function currentConversationBarrier(chatKey: string): { waitFor: Promise<void>; blockedBy: AdapterLaneSpanInfo | null } | undefined {
    const waitFor = chatBarrierTails.get(chatKey);
    if (!waitFor) return undefined;
    return {
      waitFor,
      blockedBy: chatBarrierSpans.get(chatKey) || null,
    };
  }

  function scheduleSessionConversationBarrierMessage(
    adapter: BaseChannelAdapter,
    msg: InboundMessage,
    category: AdapterMessageCategory,
    sessionLane: AdapterSessionLane,
  ): Promise<void> {
    const { sessionId, jobKind } = sessionLane;
    const chatKey = chatLaneKey(msg);
    const scheduledAtMs = Date.now();
    const spanId = nextAdapterMessageSpanId(msg);
    const blockedBy = laneTailSpans.get(chatKey) || chatBarrierSpans.get(chatKey) || null;
    const priorConversationJobs = Array.from(activeConversationJobs.get(chatKey) || []);
    const options: AdapterMessageTimelineOptions = {
      sessionId,
      usesSessionLock: true,
      laneKind: 'session',
      jobKind,
    };
    const scheduledFields = {
      ...baseSpanFields(spanId, chatKey, options, scheduledAtMs),
      ...blockedByFields(blockedBy, scheduledAtMs),
      conversation_barrier: true,
      prior_conversation_jobs: priorConversationJobs.length,
    };
    logger.info(
      adapterMessageLogFields('adapter.message.scheduled', 0, chatKey, msg, category, scheduledFields),
      'adapter message scheduled',
    );

    const spanInfo: AdapterLaneSpanInfo = {
      spanId,
      messageId: msg.messageId,
      sessionId,
      category,
      scheduledAtMs,
      startedAtMs: null,
    };

    laneTailSpans.set(chatKey, spanInfo);
    chatBarrierSpans.set(chatKey, spanInfo);

    const current = deps.processWithSessionLock(sessionId, async () => {
      const lockAcquiredAtMs = Date.now();
      const lockWaitMs = lockAcquiredAtMs - scheduledAtMs;
      logger.info(
        adapterMessageLogFields('adapter.session_lock.acquired', lockWaitMs, chatKey, msg, category, {
          ...baseSpanFields(spanId, chatKey, options, scheduledAtMs),
          ...blockedByFields(blockedBy, lockAcquiredAtMs),
          conversation_barrier: true,
          prior_conversation_jobs: priorConversationJobs.length,
          session_lock_wait_ms: lockWaitMs,
        }),
        'adapter session lock acquired',
      );

      if (priorConversationJobs.length > 0) {
        await Promise.all(priorConversationJobs.map((job) => job.catch(() => undefined)));
      }

      const startedAtMs = Date.now();
      spanInfo.startedAtMs = startedAtMs;
      const waitMs = startedAtMs - scheduledAtMs;
      const startedFields = {
        ...baseSpanFields(spanId, chatKey, options, scheduledAtMs),
        ...blockedByFields(blockedBy, startedAtMs),
        conversation_barrier: true,
        prior_conversation_jobs: priorConversationJobs.length,
        started_at_ms: startedAtMs,
        lane_wait_ms: waitMs,
        session_lock_wait_ms: lockWaitMs,
        chat_barrier_wait_ms: Math.max(0, startedAtMs - lockAcquiredAtMs),
      };
      logger.info(
        adapterMessageLogFields('adapter.message.started', waitMs, chatKey, msg, category, startedFields),
        'adapter message started',
      );
      if (waitMs >= ADAPTER_HANDLER_QUEUE_SLOW_MS) {
        logger.warn(
          adapterMessageLogFields('adapter.message.wait', waitMs, chatKey, msg, category, startedFields),
          'slow adapter message queue wait',
        );
      }

      let status: 'success' | 'error' = 'success';
      let errorMessage: string | undefined;
      try {
        await deps.handleMessage(adapter, msg);
      } catch (err) {
        status = 'error';
        errorMessage = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        const endedAtMs = Date.now();
        const elapsedMs = endedAtMs - startedAtMs;
        const totalMs = endedAtMs - scheduledAtMs;
        const finishedFields = {
          ...baseSpanFields(spanId, chatKey, options, scheduledAtMs),
          ...blockedByFields(blockedBy, endedAtMs),
          conversation_barrier: true,
          prior_conversation_jobs: priorConversationJobs.length,
          status,
          started_at_ms: startedAtMs,
          ended_at_ms: endedAtMs,
          finished_at_ms: endedAtMs,
          total_ms: totalMs,
          lane_wait_ms: waitMs,
          session_lock_wait_ms: lockWaitMs,
          session_lock_acquired: true,
          chat_barrier_wait_ms: Math.max(0, startedAtMs - lockAcquiredAtMs),
          ...(errorMessage ? { error: errorMessage } : {}),
        };
        logger.info(
          adapterMessageLogFields('adapter.message.finished', elapsedMs, chatKey, msg, category, finishedFields),
          'adapter message finished',
        );
        if (elapsedMs >= ADAPTER_HANDLER_SLOW_MS) {
          logger.warn(
            adapterMessageLogFields('adapter.message.handler', elapsedMs, chatKey, msg, category, finishedFields),
            'slow adapter message handler',
          );
        }
      }
    }, { jobKind });

    laneTails.set(chatKey, current);
    chatBarrierTails.set(chatKey, current);
    trackConversationJob(chatKey, current);

    current.catch((err) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(
        adapterMessageLogFields('adapter.message.error', 0, chatKey, msg, category, {
          ...baseSpanFields(spanId, chatKey, options, scheduledAtMs),
          ...blockedByFields(blockedBy, Date.now()),
          conversation_barrier: true,
          error: errorMessage,
        }),
        'adapter message handler failed',
      );
      recordAdapterHandlerError(adapter, err);
    }).finally(() => {
      if (laneTails.get(chatKey) === current) {
        laneTails.delete(chatKey);
      }
      if (laneTailSpans.get(chatKey) === spanInfo) {
        laneTailSpans.delete(chatKey);
      }
      if (chatBarrierTails.get(chatKey) === current) {
        chatBarrierTails.delete(chatKey);
      }
      if (chatBarrierSpans.get(chatKey) === spanInfo) {
        chatBarrierSpans.delete(chatKey);
      }
    });

    return current;
  }

  async function stopAdapterInstance(channelType: string): Promise<void> {
    const state = getState();
    const adapter = state.adapters.get(channelType);
    state.invalidAdapters.delete(channelType);
    INVALID_ADAPTER_WARNING_CACHE.delete(channelType);
    if (!adapter) return;

    state.loopAborts.get(channelType)?.abort();
    state.loopAborts.delete(channelType);

    try {
      await adapter.stop();
      console.log(`[bridge-manager] Stopped adapter: ${channelType}`);
    } catch (err) {
      console.error(`[bridge-manager] Error stopping adapter ${channelType}:`, err);
    }

    state.adapters.delete(channelType);
    state.adapterMeta.delete(channelType);
  }

  async function syncConfiguredAdapters(options: { startLoops: boolean }): Promise<void> {
    const state = getState();
    let changed = false;
    const desiredInstances = listEnabledAdapterInstances(
      listConfiguredChannelInstances(),
    );
    const plan = buildAdapterSyncPlan({
      currentAdapterIds: state.adapters.keys(),
      invalidAdapterIds: state.invalidAdapters.keys(),
      warningCacheIds: INVALID_ADAPTER_WARNING_CACHE.keys(),
      desiredInstances,
      getExistingFingerprint: (channelType) => state.adapterMeta.get(channelType)?.configFingerprint,
    });

    for (const existingKey of plan.stopChannelTypes) {
      await stopAdapterInstance(existingKey);
      changed = true;
    }
    for (const invalidKey of plan.removeInvalidIds) {
      state.invalidAdapters.delete(invalidKey);
    }
    for (const invalidKey of plan.removeWarningCacheIds) {
      INVALID_ADAPTER_WARNING_CACHE.delete(invalidKey);
    }

    for (const { instance, fingerprint, restartExisting } of plan.startItems) {
      if (restartExisting) {
        await stopAdapterInstance(instance.id);
        changed = true;
      }

      const adapter = createAdapter(instance);
      if (!adapter) continue;

      const configError = adapter.validateConfig();
      if (configError) {
        const invalidSignature = `${fingerprint}:${configError}`;
        if (INVALID_ADAPTER_WARNING_CACHE.get(instance.id) !== invalidSignature) {
          console.warn(`[bridge-manager] ${instance.id} adapter not valid:`, configError);
          INVALID_ADAPTER_WARNING_CACHE.set(instance.id, invalidSignature);
          state.invalidAdapters.set(instance.id, invalidSignature);
        }
        continue;
      }
      state.invalidAdapters.delete(instance.id);
      INVALID_ADAPTER_WARNING_CACHE.delete(instance.id);

      try {
        await adapter.start();
        if (!adapter.isRunning()) {
          throw new Error('adapter start completed without entering running state');
        }
        state.adapters.set(instance.id, adapter);
        state.adapterMeta.set(instance.id, {
          lastMessageAt: null,
          lastError: null,
          configFingerprint: fingerprint,
        });
        console.log(`[bridge-manager] Started adapter: ${instance.id}`);
        if (options.startLoops && state.running) {
          runAdapterLoop(adapter);
        }
        changed = true;
      } catch (err) {
        try {
          await adapter.stop();
        } catch (cleanupErr) {
          console.error(`[bridge-manager] Failed to clean up adapter ${instance.id} after start error:`, cleanupErr);
        }
        state.adapters.delete(instance.id);
        state.adapterMeta.delete(instance.id);
        console.error(`[bridge-manager] Failed to start adapter ${instance.id}:`, err);
      }
    }

    if (changed) {
      deps.notifyAdapterSetChanged(getActiveChannelTypes());
    }
  }

  function runAdapterLoop(adapter: BaseChannelAdapter): void {
    const state = getState();
    const abort = new AbortController();
    state.loopAborts.set(adapter.channelType, abort);

    (async () => {
      while (state.running && adapter.isRunning()) {
        try {
          const msg = await adapter.consumeOne();
          if (!msg) continue;

          const classification = classifyMessage(msg);
          if (classification.bypassSessionLock) {
            const immediateLane = deps.getImmediateLane?.(msg, classification.category) || null;
            if (immediateLane) {
              const chatKey = chatLaneKey(msg);
              const current = scheduleImmediateMessage(
                adapter,
                msg,
                classification.category,
                immediateLane.laneKey,
                {
                  usesSessionLock: false,
                  laneKind: immediateLane.laneKind,
                  jobKind: immediateLane.jobKind,
                },
                () => deps.handleMessage(adapter, msg),
                immediateLane.laneKind === 'job' && immediateLane.waitForConversationBarrier !== false
                  ? currentConversationBarrier(chatKey)
                  : undefined,
              );
              if (immediateLane.laneKind !== 'control') {
                trackConversationJob(chatKey, current);
              }
            } else {
              const sessionLane = deps.getSessionLane?.(msg, classification.category) || null;
              if (sessionLane) {
                const current = scheduleSessionLockedMessage(adapter, msg, classification.category, sessionLane);
                trackConversationJob(chatLaneKey(msg), current);
              } else {
                const chatKey = chatLaneKey(msg);
                const current = scheduleImmediateMessage(
                  adapter,
                  msg,
                  classification.category,
                  chatKey,
                  {
                    usesSessionLock: false,
                    laneKind: 'chat',
                    jobKind: classification.category,
                  },
                  () => deps.handleMessage(adapter, msg),
                  currentConversationBarrier(chatKey),
                );
                trackConversationJob(chatKey, current);
              }
            }
          } else {
            const sessionLane = deps.getSessionLane?.(msg, classification.category);
            if (sessionLane) {
              const current = scheduleSessionLockedMessage(adapter, msg, classification.category, sessionLane);
              trackConversationJob(chatLaneKey(msg), current);
              continue;
            }
            const sessionId = deps.resolveSessionIdForMessage(msg);
            scheduleSessionLockedMessage(
              adapter,
              msg,
              classification.category,
              { sessionId, jobKind: 'interactive-turn' },
            );
          }
        } catch (err) {
          if (abort.signal.aborted) break;
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[bridge-manager] Error in ${adapter.channelType} loop:`, err);
          const meta = state.adapterMeta.get(adapter.channelType) || {
            lastMessageAt: null,
            lastError: null,
            configFingerprint: '',
          };
          meta.lastError = errMsg;
          state.adapterMeta.set(adapter.channelType, meta);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    })().catch(err => {
      if (!abort.signal.aborted) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[bridge-manager] ${adapter.channelType} loop crashed:`, err);
        const meta = state.adapterMeta.get(adapter.channelType) || {
          lastMessageAt: null,
          lastError: null,
          configFingerprint: '',
        };
        meta.lastError = errMsg;
        state.adapterMeta.set(adapter.channelType, meta);
      }
    });
  }

  function clearWarningCache(): void {
    INVALID_ADAPTER_WARNING_CACHE.clear();
  }

  return {
    getActiveChannelTypes,
    stopAdapterInstance,
    syncConfiguredAdapters,
    runAdapterLoop,
    clearWarningCache,
  };
}
