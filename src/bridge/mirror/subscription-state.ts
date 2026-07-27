import type { FSWatcher } from 'node:fs';
import type { BridgeMirrorCursor } from './cursor.js';
import type { BridgeMirrorRecord } from '../../runtime/contracts.js';
import type { BridgeMirrorTurnState, FinalizedBridgeMirrorTurn } from './turns.js';

export interface BridgeMirrorSubscription {
  bindingId: string;
  sessionId: string;
  channelType: string;
  chatId: string;
  threadId: string;
  filePath: string | null;
  cursor: BridgeMirrorCursor;
  dirty: boolean;
  status: 'inactive' | 'watching' | 'stale';
  activityTier: 'hot' | 'cold';
  nextColdReconcileAt: number | null;
  watcher: FSWatcher | null;
  watcherTarget: string | null;
  lastDeliveredAt: string | null;
  lastReconciledAt: string | null;
  fileOffset: number;
  fileSize: number | null;
  fileMtimeMs: number | null;
  fileIdentity: string | null;
  trailingText: string;
  activeMirrorTurnId: string | null;
  activeSpecialCallIds: Set<string>;
  supplementalOffset: number;
  supplementalTrailingText: string;
  bufferedRecords: BridgeMirrorRecord[];
  pendingTurn: BridgeMirrorTurnState | null;
  pendingDeliveries: FinalizedBridgeMirrorTurn[];
  consecutiveEmptyGoalTurns: number;
  emptyGoalLoopWarningSent: boolean;
  unknownMirrorKindsSeen: Set<string>;
  missingThreadPolls: number;
  consecutiveFailures: number;
  suspendedUntil: number | null;
}

export interface MirrorFileSnapshot {
  size: number;
  mtimeMs: number;
  identity: string;
}

export interface CreateMirrorSubscriptionInput {
  bindingId: string;
  sessionId: string;
  channelType: string;
  chatId: string;
  threadId: string;
  filePath: string | null;
  lastDeliveredAt: string | null;
  activityTier?: 'hot' | 'cold';
}

export interface UpdateMirrorSubscriptionInput {
  sessionId: string;
  channelType: string;
  chatId: string;
  threadId: string;
  filePath: string | null;
  lastDeliveredAt: string | null;
  activityTier?: 'hot' | 'cold';
}

export interface UpdateMirrorSubscriptionResult {
  previousSessionId: string;
  threadChanged: boolean;
  filePathChanged: boolean;
}

export function resetMirrorReadState(subscription: BridgeMirrorSubscription): void {
  subscription.fileOffset = 0;
  subscription.fileSize = null;
  subscription.fileMtimeMs = null;
  subscription.fileIdentity = null;
  subscription.trailingText = '';
  subscription.activeMirrorTurnId = null;
  subscription.activeSpecialCallIds.clear();
  subscription.supplementalOffset = 0;
  subscription.supplementalTrailingText = '';
  subscription.bufferedRecords = [];
}

export function createMirrorSubscription(
  input: CreateMirrorSubscriptionInput,
): BridgeMirrorSubscription {
  return {
    bindingId: input.bindingId,
    sessionId: input.sessionId,
    channelType: input.channelType,
    chatId: input.chatId,
    threadId: input.threadId,
    filePath: input.filePath,
    cursor: { initialized: false, lastEventCount: 0 },
    dirty: input.activityTier === 'cold' ? false : true,
    status: input.filePath ? 'watching' : 'stale',
    activityTier: input.activityTier || 'hot',
    nextColdReconcileAt: null,
    watcher: null,
    watcherTarget: null,
    lastDeliveredAt: input.lastDeliveredAt,
    lastReconciledAt: null,
    fileOffset: 0,
    fileSize: null,
    fileMtimeMs: null,
    fileIdentity: null,
    trailingText: '',
    activeMirrorTurnId: null,
    activeSpecialCallIds: new Set<string>(),
    supplementalOffset: 0,
    supplementalTrailingText: '',
    bufferedRecords: [],
    pendingTurn: null,
    pendingDeliveries: [],
    consecutiveEmptyGoalTurns: 0,
    emptyGoalLoopWarningSent: false,
    unknownMirrorKindsSeen: new Set<string>(),
    missingThreadPolls: 0,
    consecutiveFailures: 0,
    suspendedUntil: null,
  };
}

function resetMirrorSubscriptionForThreadChange(
  subscription: BridgeMirrorSubscription,
  lastDeliveredAt: string | null,
): void {
  subscription.cursor = { initialized: false, lastEventCount: 0 };
  subscription.lastDeliveredAt = lastDeliveredAt;
  subscription.dirty = true;
  subscription.pendingTurn = null;
  subscription.pendingDeliveries = [];
  subscription.consecutiveEmptyGoalTurns = 0;
  subscription.emptyGoalLoopWarningSent = false;
  subscription.unknownMirrorKindsSeen.clear();
  subscription.missingThreadPolls = 0;
  subscription.consecutiveFailures = 0;
  subscription.suspendedUntil = null;
  resetMirrorReadState(subscription);
}

function resetMirrorSubscriptionForFilePathChange(
  subscription: BridgeMirrorSubscription,
): void {
  subscription.dirty = true;
  subscription.pendingTurn = null;
  subscription.consecutiveEmptyGoalTurns = 0;
  subscription.consecutiveFailures = 0;
  subscription.suspendedUntil = null;
  resetMirrorReadState(subscription);
}

export function updateMirrorSubscription(
  subscription: BridgeMirrorSubscription,
  input: UpdateMirrorSubscriptionInput,
): UpdateMirrorSubscriptionResult {
  const previousSessionId = subscription.sessionId;
  const threadChanged = subscription.threadId !== input.threadId;
  const filePathChanged = subscription.filePath !== input.filePath;

  subscription.sessionId = input.sessionId;
  subscription.channelType = input.channelType;
  subscription.chatId = input.chatId;
  subscription.threadId = input.threadId;
  subscription.filePath = input.filePath;
  subscription.status = input.filePath ? 'watching' : 'stale';
  subscription.activityTier = input.activityTier || 'hot';

  if (threadChanged) {
    resetMirrorSubscriptionForThreadChange(subscription, input.lastDeliveredAt);
  } else if (filePathChanged) {
    resetMirrorSubscriptionForFilePathChange(subscription);
  }

  return {
    previousSessionId,
    threadChanged,
    filePathChanged,
  };
}

export function clearMirrorSubscriptionFailure(subscription: BridgeMirrorSubscription): void {
  subscription.consecutiveFailures = 0;
  subscription.suspendedUntil = null;
}

export function recordMirrorSubscriptionFailure(
  subscription: BridgeMirrorSubscription,
  suspendThreshold: number,
  suspendMs: number,
  nowMs = Date.now(),
): boolean {
  subscription.pendingTurn = null;
  subscription.bufferedRecords = [];
  subscription.consecutiveEmptyGoalTurns = 0;
  subscription.status = 'stale';
  subscription.dirty = false;
  subscription.consecutiveFailures += 1;

  if (subscription.consecutiveFailures >= suspendThreshold) {
    subscription.suspendedUntil = nowMs + suspendMs;
    return true;
  }

  return false;
}
