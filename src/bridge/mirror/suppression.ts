import type { BridgeMirrorRecord } from '../../runtime/contracts.js';

export interface MirrorSuppressionState {
  id: string;
  until: number;
  promptText: string | null;
  awaitingPromptMatch: boolean;
  candidateTurnId: string | null;
  activeTurnId: string | null;
  droppingTurn: boolean;
  timeoutOnExpire: boolean;
}

export interface MirrorSuppressionStore {
  suppressions: Map<string, MirrorSuppressionState[]>;
  ignoredTurnIds: Map<string, Map<string, number>>;
}

export interface MirrorSuppressionConfig {
  suppressionWindowMs: number;
  promptMatchGraceMs: number;
}

export function normalizeMirrorPromptText(text: string): string {
  return text.replace(/\r\n/g, '\n').normalize('NFKC').trim();
}

function getIgnoredMirrorTurns(store: MirrorSuppressionStore, sessionId: string): Map<string, number> {
  const existing = store.ignoredTurnIds.get(sessionId);
  if (existing) return existing;
  const created = new Map<string, number>();
  store.ignoredTurnIds.set(sessionId, created);
  return created;
}

function cleanupIgnoredMirrorTurns(
  store: MirrorSuppressionStore,
  sessionId: string,
  nowMs = Date.now(),
): Map<string, number> {
  const turns = getIgnoredMirrorTurns(store, sessionId);
  for (const [turnId, until] of turns) {
    if (until <= nowMs) {
      turns.delete(turnId);
    }
  }
  if (turns.size === 0) {
    store.ignoredTurnIds.delete(sessionId);
  }
  return turns;
}

function markIgnoredMirrorTurn(
  store: MirrorSuppressionStore,
  sessionId: string,
  turnId: string | null | undefined,
  durationMs: number,
  nowMs = Date.now(),
): void {
  const normalized = (turnId || '').trim();
  if (!normalized) return;
  const turns = cleanupIgnoredMirrorTurns(store, sessionId, nowMs);
  turns.set(normalized, nowMs + durationMs);
  store.ignoredTurnIds.set(sessionId, turns);
}

function getMirrorSuppressionStates(
  store: MirrorSuppressionStore,
  sessionId: string,
  nowMs = Date.now(),
): MirrorSuppressionState[] {
  const existing = store.suppressions.get(sessionId) || [];
  if (existing.length === 0) return [];
  const active = existing.filter((suppression) => suppression.until > nowMs);
  const expired = existing.filter((suppression) => suppression.until <= nowMs);
  for (const suppression of expired) {
    if (!suppression.timeoutOnExpire) continue;
    const trackedTurnId = suppression.activeTurnId || suppression.candidateTurnId;
    markIgnoredMirrorTurn(store, sessionId, trackedTurnId, 60_000, nowMs);
    console.error('[mirror-suppression] Timed out waiting for terminal mirror record after SDK completion:', {
      session_id: sessionId,
      suppression_id: suppression.id,
      turn_id: trackedTurnId || null,
      state: suppression.droppingTurn
        ? 'dropping_turn'
        : suppression.awaitingPromptMatch
          ? 'awaiting_prompt_match'
          : 'active',
    });
  }
  if (active.length === 0) {
    store.suppressions.delete(sessionId);
    return [];
  }
  if (active.length !== existing.length) {
    store.suppressions.set(sessionId, active);
  }
  return active;
}

function clearMirrorSuppression(
  store: MirrorSuppressionStore,
  sessionId: string,
  suppressionId?: string | null,
): void {
  const existing = store.suppressions.get(sessionId);
  if (!existing || existing.length === 0) return;
  if (!suppressionId) {
    store.suppressions.delete(sessionId);
    return;
  }
  const next = existing.filter((suppression) => suppression.id !== suppressionId);
  if (next.length > 0) {
    store.suppressions.set(sessionId, next);
  } else {
    store.suppressions.delete(sessionId);
  }
}

function isMirrorTerminalRecord(record: BridgeMirrorRecord): boolean {
  return record.type === 'task_complete' || record.type === 'task_aborted';
}

export function beginMirrorSuppression(
  store: MirrorSuppressionStore,
  sessionId: string,
  promptText: string,
  nowMs = Date.now(),
): string {
  const suppressionId = `${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const suppressions = getMirrorSuppressionStates(store, sessionId, nowMs);
  suppressions.push({
    id: suppressionId,
    until: Number.POSITIVE_INFINITY,
    promptText: normalizeMirrorPromptText(promptText) || null,
    awaitingPromptMatch: true,
    candidateTurnId: null,
    activeTurnId: null,
    droppingTurn: false,
    timeoutOnExpire: false,
  });
  store.suppressions.set(sessionId, suppressions);
  return suppressionId;
}

export function settleMirrorSuppression(
  store: MirrorSuppressionStore,
  sessionId: string,
  config: MirrorSuppressionConfig,
  suppressionId?: string | null,
  durationMs = config.suppressionWindowMs,
  nowMs = Date.now(),
): void {
  const suppressions = getMirrorSuppressionStates(store, sessionId, nowMs);
  if (suppressions.length === 0) return;
  const target = suppressionId
    ? suppressions.find((suppression) => suppression.id === suppressionId)
    : suppressions[suppressions.length - 1];
  if (!target) return;
  if (target.awaitingPromptMatch || target.droppingTurn) {
    target.until = nowMs + durationMs;
    target.timeoutOnExpire = true;
    return;
  }
  target.until = nowMs + durationMs;
  target.timeoutOnExpire = false;
}

export function abortMirrorSuppression(
  store: MirrorSuppressionStore,
  sessionId: string,
  config: MirrorSuppressionConfig,
  suppressionId?: string | null,
  nowMs = Date.now(),
): void {
  const suppressions = getMirrorSuppressionStates(store, sessionId, nowMs);
  if (suppressions.length === 0) return;
  const target = suppressionId
    ? suppressions.find((suppression) => suppression.id === suppressionId)
    : suppressions[suppressions.length - 1];
  if (!target) return;

  if (target.awaitingPromptMatch || target.droppingTurn) {
    target.until = nowMs + config.promptMatchGraceMs;
    return;
  }

  const trackedTurnId = target.activeTurnId || target.candidateTurnId;
  if (trackedTurnId) {
    markIgnoredMirrorTurn(
      store,
      sessionId,
      trackedTurnId,
      config.promptMatchGraceMs,
      nowMs,
    );
    clearMirrorSuppression(store, sessionId, target.id);
    return;
  }

  target.until = nowMs + config.suppressionWindowMs;
}

export function isMirrorSuppressed(
  store: MirrorSuppressionStore,
  sessionId: string,
  nowMs = Date.now(),
): boolean {
  return getMirrorSuppressionStates(store, sessionId, nowMs).length > 0;
}

export function filterSuppressedMirrorRecords(
  store: MirrorSuppressionStore,
  sessionId: string,
  records: BridgeMirrorRecord[],
  config: MirrorSuppressionConfig,
  nowMs = Date.now(),
): BridgeMirrorRecord[] {
  const suppressions = getMirrorSuppressionStates(store, sessionId, nowMs);
  const ignoredTurnIds = cleanupIgnoredMirrorTurns(store, sessionId, nowMs);
  if ((suppressions.length === 0 && ignoredTurnIds.size === 0) || records.length === 0) return records;

  const filtered: BridgeMirrorRecord[] = [];

  for (const record of records) {
    const normalizedContent = record.type === 'message'
      ? normalizeMirrorPromptText(record.content || '')
      : '';
    let handled = false;

    while (true) {
      const ignoredTurnIds = cleanupIgnoredMirrorTurns(store, sessionId, nowMs);
      if (record.turnId && ignoredTurnIds.has(record.turnId)) {
        handled = true;
        break;
      }

      const suppression = getMirrorSuppressionStates(store, sessionId, nowMs)[0];
      if (!suppression) break;

      if (suppression.awaitingPromptMatch) {
        if (record.type === 'task_started') {
          suppression.candidateTurnId = record.turnId || suppression.candidateTurnId;
          handled = true;
          break;
        }

        if (record.type === 'message' && record.role === 'user') {
          if (
            record.turnId
            && suppression.candidateTurnId
            && record.turnId !== suppression.candidateTurnId
          ) {
            clearMirrorSuppression(store, sessionId, suppression.id);
            continue;
          }
          if (suppression.promptText && normalizedContent === suppression.promptText) {
            suppression.awaitingPromptMatch = false;
            suppression.droppingTurn = true;
            suppression.activeTurnId = record.turnId || suppression.candidateTurnId || null;
            handled = true;
            break;
          }
          // If user message doesn't match prompt but has the same turnId as candidateTurnId,
          // it's likely a synthetic message (permission error, tool error, etc.) - suppress it
          if (
            record.turnId
            && suppression.candidateTurnId
            && record.turnId === suppression.candidateTurnId
          ) {
            // Treat this as a matched prompt and suppress the entire turn
            suppression.awaitingPromptMatch = false;
            suppression.droppingTurn = true;
            suppression.activeTurnId = record.turnId;
            handled = true;
            break;
          }
          clearMirrorSuppression(store, sessionId, suppression.id);
          continue;
        }

        if (
          record.turnId
          && suppression.candidateTurnId
          && record.turnId !== suppression.candidateTurnId
        ) {
          break;
        }

        if (
          isMirrorTerminalRecord(record)
          && suppression.candidateTurnId
          && record.turnId
          && record.turnId === suppression.candidateTurnId
        ) {
          clearMirrorSuppression(store, sessionId, suppression.id);
          handled = true;
          break;
        }

        if (record.type !== 'message' || record.role !== 'user') {
          handled = true;
          break;
        }

        break;
      }

      if (suppression.droppingTurn) {
        if (record.turnId && suppression.activeTurnId && record.turnId !== suppression.activeTurnId) {
          if (record.type === 'task_started') {
            markIgnoredMirrorTurn(
              store,
              sessionId,
              suppression.activeTurnId,
              config.promptMatchGraceMs,
              nowMs,
            );
            clearMirrorSuppression(store, sessionId, suppression.id);
            continue;
          }
          break;
        }

        if (record.type === 'task_started') {
          handled = true;
          break;
        }

        if (isMirrorTerminalRecord(record)) {
          clearMirrorSuppression(store, sessionId, suppression.id);
          handled = true;
          break;
        }

        if (
          record.type === 'message'
          && record.role === 'user'
          && suppression.promptText
          && normalizedContent !== suppression.promptText
        ) {
          markIgnoredMirrorTurn(
            store,
            sessionId,
            suppression.activeTurnId,
            config.promptMatchGraceMs,
            nowMs,
          );
          clearMirrorSuppression(store, sessionId, suppression.id);
          continue;
        }

        handled = true;
        break;
      }

      break;
    }

    if (!handled) {
      filtered.push(record);
    }
  }

  return filtered;
}
