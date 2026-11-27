import type { AcpHostClient } from './host-client.js';
import {
  isAcpTurnActiveStatus,
  type AcpPendingServerRequest,
  type AcpTurnEvent,
  type AcpTurnSnapshot,
} from './host-protocol.js';
import { BRIDGE_SHUTDOWN_REASON } from '../contracts.js';

export interface ConsumeHostedTurnHooks {
  abortSignal?: AbortSignal;
  cancelTimeoutMs?: number;
  onSessionUpdate: (params: Record<string, unknown>) => void;
  onServerRequest: (request: AcpPendingServerRequest) => Promise<void>;
  onServerRequestResolved?: (requestId: string | number) => void;
  onReplayComplete?: () => void;
}

export interface ConsumeHostedTurnResult {
  status: 'completed' | 'aborted' | 'failed' | 'detached';
  stopReason?: string;
  error?: string;
  nativeSessionId?: string;
}

function reqKey(requestId: string | number): string {
  return `${typeof requestId}:${String(requestId)}`;
}

/**
 * Subscribe to a durable ACP turn on `acp-host` from seq=0 (replaying any
 * missed events and streaming live updates) until terminal completion or
 * clean bridge-shutdown detach.
 */
export async function consumeHostedAcpTurn(
  host: AcpHostClient,
  initialTurn: AcpTurnSnapshot,
  hooks: ConsumeHostedTurnHooks,
): Promise<ConsumeHostedTurnResult> {
  const turnId = initialTurn.turnId;
  let lastSeq = 0;
  let settled = false;
  let resolveEnd!: (result: ConsumeHostedTurnResult) => void;
  const ended = new Promise<ConsumeHostedTurnResult>((resolve) => { resolveEnd = resolve; });

  // Track which server requests are currently still pending (populated from subscribe snapshot
  // so replayed historical requests that were already answered before restart are NOT re-opened).
  const activePendingKeys = new Set<string>(initialTurn.pendingRequests.map((r) => reqKey(r.requestId)));
  const dispatchedRequestKeys = new Set<string>();
  let snapshotLastSeq = initialTurn.lastSeq;
  let subscribed = false;
  let replayComplete = false;
  const beforeSubscribe: AcpTurnEvent[] = [];
  const completeReplay = (): void => {
    if (replayComplete) return;
    replayComplete = true;
    hooks.onReplayComplete?.();
  };

  const finish = (result: ConsumeHostedTurnResult): void => {
    if (settled) return;
    settled = true;
    resolveEnd(result);
  };

  const dispatchServerRequest = (req: AcpPendingServerRequest): void => {
    const key = reqKey(req.requestId);
    if (dispatchedRequestKeys.has(key)) return;
    dispatchedRequestKeys.add(key);
    void hooks.onServerRequest(req).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      void host.respondTurnRequest({
        turnId,
        requestId: req.requestId,
        error: { code: -32603, message },
      }).catch(() => {});
    });
  };

  const applyEvent = (evt: AcpTurnEvent): void => {
    if (settled) return;
    if (evt.seq <= lastSeq) return;
    lastSeq = evt.seq;
    if (evt.kind === 'session_update') {
      hooks.onSessionUpdate(evt.params);
      return;
    }
    if (evt.kind === 'server_request') {
      const key = reqKey(evt.requestId);
      // During historical replay (evt.seq <= snapshotLastSeq), only dispatch requests that are
      // STILL pending in the host snapshot. Any live request (evt.seq > snapshotLastSeq) is always active.
      if (evt.seq > snapshotLastSeq || activePendingKeys.has(key)) {
        activePendingKeys.add(key);
        dispatchServerRequest({
          requestId: evt.requestId,
          method: evt.method,
          params: evt.params,
          seq: evt.seq,
        });
      }
      return;
    }
    if (evt.kind === 'server_request_resolved') {
      const key = reqKey(evt.requestId);
      activePendingKeys.delete(key);
      hooks.onServerRequestResolved?.(evt.requestId);
      return;
    }
    if (evt.kind === 'turn_end') {
      finish({
        status: evt.status,
        stopReason: evt.stopReason,
        error: evt.error,
        nativeSessionId: evt.nativeSessionId,
      });
    }
  };

  const handleEvent = (evt: AcpTurnEvent): void => {
    // The socket may deliver the RPC response and replay in the same read.
    // Install the response's exact replay boundary before consuming those events.
    if (!subscribed) { beforeSubscribe.push(evt); return; }
    applyEvent(evt);
    if (lastSeq >= snapshotLastSeq) completeReplay();
  };

  const unsubEvents = host.onTurnEvent(turnId, handleEvent);
  const unsubDisconnect = host.onDisconnect((error) => {
    if (hooks.abortSignal?.aborted && hooks.abortSignal.reason === BRIDGE_SHUTDOWN_REASON) {
      finish({ status: 'detached', nativeSessionId: initialTurn.nativeSessionId });
      return;
    }
    finish({ status: 'failed', error: error.message, nativeSessionId: initialTurn.nativeSessionId });
  });

  const onAbort = (): void => {
    if (settled) return;
    if (hooks.abortSignal?.reason === BRIDGE_SHUTDOWN_REASON) {
      // CRITICAL: On bridge shutdown / hot-update, detach cleanly WITHOUT cancelling the ACP turn!
      finish({ status: 'detached', nativeSessionId: initialTurn.nativeSessionId });
      return;
    }
    void host.cancelTurn({ turnId, cancelTimeoutMs: hooks.cancelTimeoutMs }).catch((error) => {
      finish({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        nativeSessionId: initialTurn.nativeSessionId,
      });
    });
  };

  if (hooks.abortSignal) {
    if (hooks.abortSignal.aborted) {
      onAbort();
    } else {
      hooks.abortSignal.addEventListener('abort', onAbort, { once: true });
    }
  }

  try {
    if (!settled) {
      const sub = await host.subscribeTurn({ turnId, afterSeq: 0 });
      subscribed = true;
      snapshotLastSeq = sub.turn.lastSeq;
      activePendingKeys.clear();
      for (const req of sub.turn.pendingRequests) activePendingKeys.add(reqKey(req.requestId));
      if (snapshotLastSeq === 0) completeReplay();
      for (const evt of beforeSubscribe) handleEvent(evt);
      beforeSubscribe.length = 0;

      // If the turn already ended with 0 events (edge case) or after replay finishes,
      // subscribeTurn's microtask replay will emit turn_end. Guard against an empty terminal turn.
      if (!isAcpTurnActiveStatus(sub.turn.status) && sub.turn.lastSeq === 0) {
        finish({
          status: sub.turn.status === 'completed' ? 'completed' : sub.turn.status === 'aborted' ? 'aborted' : 'failed',
          stopReason: sub.turn.stopReason,
          error: sub.turn.error,
          nativeSessionId: sub.turn.nativeSessionId,
        });
      }
    }
    return await ended;
  } finally {
    hooks.abortSignal?.removeEventListener('abort', onAbort);
    unsubEvents();
    unsubDisconnect();
    if (subscribed && host.connected) {
      void host.unsubscribeTurn(turnId);
    }
  }
}
