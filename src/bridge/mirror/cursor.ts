import type { BridgeMirrorRecord } from '../../runtime/contracts.js';

export interface BridgeMirrorCursor {
  initialized: boolean;
  lastEventSignature?: string;
  lastEventTimestamp?: string;
  lastEventType?: BridgeMirrorRecord['type'];
  lastEventRole?: BridgeMirrorRecord['role'];
  lastEventContent?: string;
  lastEventCount: number;
}

export interface BridgeMirrorDelta {
  nextCursor: BridgeMirrorCursor;
  deliverableRecords: BridgeMirrorRecord[];
  reset: boolean;
}

function makeCursor(records: BridgeMirrorRecord[]): BridgeMirrorCursor {
  const lastEvent = records.length > 0 ? records[records.length - 1] : undefined;
  return {
    initialized: true,
    lastEventSignature: lastEvent?.signature,
    lastEventTimestamp: lastEvent?.timestamp,
    lastEventType: lastEvent?.type,
    lastEventRole: lastEvent?.role,
    lastEventContent: lastEvent?.content,
    lastEventCount: records.length,
  };
}

export function advanceBridgeMirrorCursor(
  cursor: BridgeMirrorCursor | null | undefined,
  appendedRecords: BridgeMirrorRecord[],
): BridgeMirrorCursor {
  if (appendedRecords.length === 0) {
    return cursor
      ? { ...cursor }
      : {
          initialized: false,
          lastEventCount: 0,
        };
  }

  if (!cursor?.initialized) {
    return makeCursor(appendedRecords);
  }

  const lastEvent = appendedRecords[appendedRecords.length - 1];
  return {
    initialized: true,
    lastEventSignature: lastEvent?.signature,
    lastEventTimestamp: lastEvent?.timestamp,
    lastEventType: lastEvent?.type,
    lastEventRole: lastEvent?.role,
    lastEventContent: lastEvent?.content,
    lastEventCount: cursor.lastEventCount + appendedRecords.length,
  };
}

export function filterDuplicateAssistantEvents(
  cursor: BridgeMirrorCursor | null | undefined,
  records: BridgeMirrorRecord[],
): BridgeMirrorRecord[] {
  if (records.length === 0) return records;
  let startIndex = 0;

  while (
    startIndex < records.length
    && cursor?.lastEventType === 'message'
    && cursor?.lastEventRole === 'assistant'
    && records[startIndex]?.type === 'message'
    && records[startIndex]?.role === 'assistant'
    && cursor.lastEventContent === records[startIndex]?.content
  ) {
    startIndex += 1;
  }

  return startIndex === 0 ? records : records.slice(startIndex);
}

function findLastEventIndex(records: BridgeMirrorRecord[], signature: string): number {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index]?.signature === signature) {
      return index;
    }
  }
  return -1;
}

function collectEventsAfterTimestamp(
  records: BridgeMirrorRecord[],
  timestamp: string | undefined,
): BridgeMirrorRecord[] {
  if (!timestamp) return [];
  return records.filter((event) => Boolean(event.timestamp) && event.timestamp > timestamp);
}

export function reconcileBridgeMirrorCursor(
  cursor: BridgeMirrorCursor | null | undefined,
  records: BridgeMirrorRecord[],
): BridgeMirrorDelta {
  const nextCursor = makeCursor(records);

  if (!cursor?.initialized) {
    return {
      nextCursor,
      deliverableRecords: [],
      reset: false,
    };
  }

  if (records.length === 0) {
    return {
      nextCursor,
      deliverableRecords: [],
      reset: cursor.lastEventCount > 0,
    };
  }

  if (cursor.lastEventSignature) {
    const lastSeenIndex = findLastEventIndex(records, cursor.lastEventSignature);
    if (lastSeenIndex === -1) {
      const recoveredEvents = collectEventsAfterTimestamp(records, cursor.lastEventTimestamp);
      return {
        nextCursor,
        deliverableRecords: recoveredEvents,
        reset: true,
      };
    }
    return {
      nextCursor,
      deliverableRecords: records.slice(lastSeenIndex + 1),
      reset: false,
    };
  }

  if (cursor.lastEventCount === 0) {
    return {
      nextCursor,
      deliverableRecords: records,
      reset: false,
    };
  }

  if (records.length < cursor.lastEventCount) {
    const recoveredEvents = collectEventsAfterTimestamp(records, cursor.lastEventTimestamp);
    return {
      nextCursor,
      deliverableRecords: recoveredEvents,
      reset: true,
    };
  }

  return {
    nextCursor,
    deliverableRecords: records.slice(cursor.lastEventCount),
    reset: false,
  };
}
