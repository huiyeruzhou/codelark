import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runMirrorReconcileBatch } from '../../../../bridge/mirror/reconcile-batch.js';

describe('mirror-reconcile-batch', () => {
  it('reconciles subscriptions with bounded concurrency and emits a batch summary', async () => {
    let active = 0;
    let maxActive = 0;
    const summaries: Array<{ total: number; processed: number; suspended: number; failed: number; concurrency: number }> = [];

    await runMirrorReconcileBatch({
      syncSubscriptionSet: () => {},
      getSubscriptions: () => [
        { bindingId: 'binding-1' } as any,
        { bindingId: 'binding-2' } as any,
        { bindingId: 'binding-3' } as any,
        { bindingId: 'binding-4' } as any,
      ],
      concurrency: 2,
      reconcileSubscription: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return 'processed';
      },
      clearFailureState: () => {},
      handleFailure: () => {
        throw new Error('should not hit failure handler');
      },
      logBatchError: () => {
        throw new Error('should not hit outer batch error');
      },
      logBatchSummary: (summary) => {
        summaries.push(summary);
      },
    });

    assert.equal(maxActive, 2);
    assert.deepEqual(summaries.map((summary) => ({
      total: summary.total,
      processed: summary.processed,
      suspended: summary.suspended,
      failed: summary.failed,
      concurrency: summary.concurrency,
    })), [{
      total: 4,
      processed: 4,
      suspended: 0,
      failed: 0,
      concurrency: 2,
    }]);
  });

  it('continues reconciling later subscriptions after one failure', async () => {
    const calls: string[] = [];
    const failures: string[] = [];

    await runMirrorReconcileBatch({
      syncSubscriptionSet: () => {
        calls.push('sync');
      },
      getSubscriptions: () => [
        { bindingId: 'binding-1' } as any,
        { bindingId: 'binding-2' } as any,
      ],
      reconcileSubscription: async (subscription) => {
        calls.push(`reconcile:${subscription.bindingId}`);
        if (subscription.bindingId === 'binding-1') {
          throw new Error('boom');
        }
        return 'processed';
      },
      clearFailureState: (subscription) => {
        calls.push(`clear:${subscription.bindingId}`);
      },
      handleFailure: (subscription) => {
        failures.push(subscription.bindingId);
      },
      logBatchError: () => {
        throw new Error('should not hit outer batch error');
      },
    });

    assert.deepEqual(calls, [
      'sync',
      'reconcile:binding-1',
      'reconcile:binding-2',
      'clear:binding-2',
    ]);
    assert.deepEqual(failures, ['binding-1']);
  });

  it('isolates failure handler errors to the failed subscription', async () => {
    const calls: string[] = [];
    const stages: string[] = [];

    await runMirrorReconcileBatch({
      syncSubscriptionSet: () => {},
      getSubscriptions: () => [
        { bindingId: 'binding-1' } as any,
        { bindingId: 'binding-2' } as any,
      ],
      concurrency: 2,
      reconcileSubscription: async (subscription) => {
        calls.push(`reconcile:${subscription.bindingId}`);
        if (subscription.bindingId === 'binding-1') throw new Error('boom');
        return 'processed';
      },
      clearFailureState: (subscription) => {
        calls.push(`clear:${subscription.bindingId}`);
      },
      handleFailure: () => {
        throw new Error('handler boom');
      },
      logBatchError: (stage) => {
        stages.push(stage);
      },
    });

    assert.deepEqual(new Set(calls), new Set([
      'reconcile:binding-1',
      'reconcile:binding-2',
      'clear:binding-2',
    ]));
    assert.deepEqual(stages, ['subscription:binding-1:failure-handler']);
  });

  it('does not clear failure state for suspended subscriptions', async () => {
    const cleared: string[] = [];

    await runMirrorReconcileBatch({
      syncSubscriptionSet: () => {},
      getSubscriptions: () => [
        { bindingId: 'binding-1' } as any,
      ],
      reconcileSubscription: async () => 'suspended',
      clearFailureState: (subscription) => {
        cleared.push(subscription.bindingId);
      },
      handleFailure: () => {
        throw new Error('should not hit failure handler');
      },
      logBatchError: () => {
        throw new Error('should not hit outer batch error');
      },
    });

    assert.deepEqual(cleared, []);
  });

  it('logs the correct stage when subscription set sync throws', async () => {
    const stages: string[] = [];

    await runMirrorReconcileBatch({
      syncSubscriptionSet: () => {
        throw new Error('sync boom');
      },
      getSubscriptions: () => [],
      reconcileSubscription: async () => 'processed',
      clearFailureState: () => {},
      handleFailure: () => {},
      logBatchError: (stage) => {
        stages.push(stage);
      },
    });

    assert.deepEqual(stages, ['sync-subscription-set']);
  });
});
