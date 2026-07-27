import fs from 'node:fs';

import {
  advanceBridgeMirrorCursor,
  filterDuplicateAssistantEvents,
  reconcileBridgeMirrorCursor,
} from './cursor.js';
import type { BridgeMirrorRecord, MirrorJsonlSource } from '../../runtime/contracts.js';
import {
  resetMirrorReadState,
  type BridgeMirrorSubscription,
  type MirrorFileSnapshot,
} from './subscription-state.js';

export function statMirrorFile(filePath: string): MirrorFileSnapshot | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      identity: `${stat.dev}:${stat.ino}`,
    };
  } catch {
    return null;
  }
}

export function refreshMirrorSubscriptionSource(
  subscription: BridgeMirrorSubscription,
  filePath: string | null,
  reconciledAt: string,
): boolean {
  const filePathChanged = subscription.filePath !== filePath;
  subscription.filePath = filePath;
  subscription.status = filePath ? 'watching' : 'stale';
  if (filePathChanged) {
    subscription.dirty = true;
    resetMirrorReadState(subscription);
  }
  subscription.lastReconciledAt = reconciledAt;
  return filePathChanged;
}

export function markMirrorSnapshotMissing(subscription: BridgeMirrorSubscription): void {
  subscription.status = 'stale';
  subscription.dirty = true;
  resetMirrorReadState(subscription);
}

export function isMirrorSnapshotUnchanged(
  subscription: BridgeMirrorSubscription,
  snapshot: MirrorFileSnapshot,
): boolean {
  return !subscription.dirty
    && subscription.fileIdentity === snapshot.identity
    && subscription.fileSize === snapshot.size
    && subscription.fileMtimeMs === snapshot.mtimeMs;
}

export function readMirrorDeliverableRecords(
  subscription: BridgeMirrorSubscription,
  snapshot: MirrorFileSnapshot,
  source: MirrorJsonlSource,
) {
  let deliverableRecords: BridgeMirrorRecord[] = [];
  let unknownKinds: string[] = [];

  const requiresFullRecover = !subscription.cursor.initialized
    || subscription.fileOffset === 0
    || (subscription.fileIdentity !== null && subscription.fileIdentity !== snapshot.identity)
    || (subscription.fileSize !== null && snapshot.size < subscription.fileOffset)
    || (
      subscription.fileSize !== null
      && snapshot.size === subscription.fileOffset
      && subscription.fileMtimeMs !== null
      && snapshot.mtimeMs !== subscription.fileMtimeMs
    );

  if (requiresFullRecover) {
    const previousCursor = subscription.cursor;
    const fullDelta = source.readDelta(
      subscription.filePath!,
      0,
      snapshot.size,
      '',
      null,
      [],
    );
    const delta = reconcileBridgeMirrorCursor(subscription.cursor, fullDelta.records);
    subscription.cursor = delta.nextCursor;
    const initialRecoveryRecords = !previousCursor.initialized && subscription.lastDeliveredAt
      ? fullDelta.records.filter((record) => record.timestamp > subscription.lastDeliveredAt!)
      : delta.deliverableRecords;
    deliverableRecords = filterDuplicateAssistantEvents(previousCursor, initialRecoveryRecords);
    subscription.trailingText = '';
    subscription.fileOffset = snapshot.size;
    subscription.activeMirrorTurnId = fullDelta.nextTurnId;
    subscription.activeSpecialCallIds = new Set(fullDelta.nextSpecialCallIds);
    unknownKinds = fullDelta.unknownKinds;
  } else if (snapshot.size > subscription.fileOffset || subscription.trailingText) {
    const previousCursor = subscription.cursor;
    const delta = source.readDelta(
      subscription.filePath!,
      subscription.fileOffset,
      snapshot.size,
      subscription.trailingText,
      subscription.activeMirrorTurnId,
      subscription.activeSpecialCallIds,
    );
    deliverableRecords = filterDuplicateAssistantEvents(previousCursor, delta.records);
    subscription.cursor = advanceBridgeMirrorCursor(subscription.cursor, delta.records);
    subscription.trailingText = delta.trailingText;
    subscription.fileOffset = delta.nextOffset;
    subscription.activeMirrorTurnId = delta.nextTurnId;
    subscription.activeSpecialCallIds = new Set(delta.nextSpecialCallIds);
    unknownKinds = delta.unknownKinds;
  }

  subscription.fileSize = snapshot.size;
  subscription.fileMtimeMs = snapshot.mtimeMs;
  subscription.fileIdentity = snapshot.identity;
  subscription.dirty = false;

  if (source.readSupplementalDelta) {
    const supplemental = source.readSupplementalDelta(
      subscription.filePath!,
      subscription.supplementalOffset,
      subscription.supplementalTrailingText,
      latestMirrorTimestamp(subscription),
      subscription.activeMirrorTurnId,
    );
    subscription.supplementalOffset = supplemental.nextOffset;
    subscription.supplementalTrailingText = supplemental.trailingText;
    deliverableRecords.push(...supplemental.records);
  }

  return {
    records: deliverableRecords,
    unknownKinds,
  };
}

function latestMirrorTimestamp(subscription: BridgeMirrorSubscription): string | null {
  const timestamps = [subscription.cursor.lastEventTimestamp, subscription.lastDeliveredAt]
    .filter((value): value is string => Boolean(value));
  return timestamps.sort().at(-1) || null;
}
