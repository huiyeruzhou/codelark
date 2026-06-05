import type { BridgeMirrorSubscription } from './subscription-state.js';

export type MirrorReconcileStatus = 'processed' | 'suspended';

export interface MirrorReconcileBatchDeps {
  syncSubscriptionSet: () => void;
  getSubscriptions: () => BridgeMirrorSubscription[];
  reconcileSubscription: (subscription: BridgeMirrorSubscription) => Promise<MirrorReconcileStatus>;
  clearFailureState: (subscription: BridgeMirrorSubscription) => void;
  handleFailure: (subscription: BridgeMirrorSubscription, error: unknown) => Promise<void> | void;
  logBatchError: (stage: string, error: unknown) => void;
  concurrency?: number;
  slowSubscriptionThresholdMs?: number;
  logSlowSubscription?: (summary: MirrorReconcileSubscriptionTiming) => void;
  logBatchSummary?: (summary: MirrorReconcileBatchSummary) => void;
}

export interface MirrorReconcileSubscriptionTiming {
  bindingId: string;
  sessionId?: string;
  threadId?: string;
  elapsedMs: number;
  status: MirrorReconcileStatus | 'failed';
}

export interface MirrorReconcileBatchSummary {
  total: number;
  processed: number;
  suspended: number;
  failed: number;
  elapsedMs: number;
  concurrency: number;
}

function normalizeConcurrency(value: number | undefined, total: number): number {
  if (total <= 0) return 0;
  if (!Number.isFinite(value || 0)) return 1;
  return Math.min(total, Math.max(1, Math.floor(value || 1)));
}

export async function runMirrorReconcileBatch(deps: MirrorReconcileBatchDeps): Promise<void> {
  let stage = 'sync-start';
  const batchStartedAt = Date.now();

  try {
    try {
      stage = 'sync-subscription-set';
      deps.syncSubscriptionSet();
    } catch (error) {
      deps.logBatchError(stage, error);
      return;
    }

    stage = 'snapshot-subscriptions';
    const subscriptions = deps.getSubscriptions();
    const concurrency = normalizeConcurrency(deps.concurrency, subscriptions.length);
    let nextIndex = 0;
    let processed = 0;
    let suspended = 0;
    let failed = 0;

    const reconcileOne = async (subscription: BridgeMirrorSubscription): Promise<void> => {
      const startedAt = Date.now();
      let status: MirrorReconcileStatus | 'failed' = 'processed';
      try {
        const result = await deps.reconcileSubscription(subscription);
        status = result;
        if (result !== 'suspended') {
          try {
            deps.clearFailureState(subscription);
          } catch (error) {
            deps.logBatchError(`subscription:${subscription.bindingId}:clear-failure-state`, error);
          }
          processed += 1;
        } else {
          suspended += 1;
        }
      } catch (error) {
        status = 'failed';
        failed += 1;
        try {
          await deps.handleFailure(subscription, error);
        } catch (failureHandlerError) {
          deps.logBatchError(`subscription:${subscription.bindingId}:failure-handler`, failureHandlerError);
        }
      } finally {
        const elapsedMs = Date.now() - startedAt;
        if (
          deps.logSlowSubscription
          && deps.slowSubscriptionThresholdMs
          && elapsedMs >= deps.slowSubscriptionThresholdMs
        ) {
          deps.logSlowSubscription({
            bindingId: subscription.bindingId,
            sessionId: subscription.sessionId,
            threadId: subscription.threadId,
            elapsedMs,
            status,
          });
        }
      }
    };

    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= subscriptions.length) return;
        const subscription = subscriptions[index]!;
        stage = `subscription:${subscription.bindingId}`;
        await reconcileOne(subscription);
      }
    });

    await Promise.all(workers);
    deps.logBatchSummary?.({
      total: subscriptions.length,
      processed,
      suspended,
      failed,
      elapsedMs: Date.now() - batchStartedAt,
      concurrency,
    });
  } catch (error) {
    deps.logBatchError(stage, error);
  }
}
