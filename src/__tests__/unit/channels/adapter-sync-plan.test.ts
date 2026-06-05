import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAdapterConfigFingerprint,
  buildAdapterSyncPlan,
  listEnabledAdapterInstances,
} from '../../../channels/adapter-runtime/sync-plan.js';

describe('adapter-sync-plan listEnabledAdapterInstances', () => {
  it('returns enabled configured instances', () => {
    const instances = listEnabledAdapterInstances(
      [
        {
          id: 'feishu-main',
          provider: 'feishu',
          alias: '主飞书',
          enabled: true,
          createdAt: '2026-04-13T00:00:00.000Z',
          updatedAt: '2026-04-13T00:00:00.000Z',
          config: { appId: 'app-id' },
        },
        {
          id: 'feishu-disabled',
          provider: 'feishu',
          alias: '禁用飞书',
          createdAt: '2026-04-13T00:00:00.000Z',
          updatedAt: '2026-04-13T00:00:00.000Z',
          enabled: false,
          config: { appId: 'disabled' },
        },
        {
          id: 'telegram-old',
          provider: 'telegram',
          alias: 'Telegram',
          createdAt: '2026-04-13T00:00:00.000Z',
          updatedAt: '2026-04-13T00:00:00.000Z',
          enabled: true,
          config: {},
        } as never,
      ],
    );

    assert.deepEqual(instances, [
      {
        id: 'feishu-main',
        provider: 'feishu',
        alias: '主飞书',
        enabled: true,
        config: { appId: 'app-id' },
      },
    ]);
  });
});

describe('adapter-sync-plan buildAdapterSyncPlan', () => {
  it('computes stop, cleanup, and restart actions from desired instances', () => {
    const same = {
      id: 'same',
      provider: 'feishu',
      alias: 'Feishu',
      enabled: true,
      config: { appId: 'same' },
    };
    const restart = {
      id: 'restart',
      provider: 'feishu',
      alias: 'Feishu Restart',
      enabled: true,
      config: { appId: 'new' },
    };
    const created = {
      id: 'created',
      provider: 'feishu',
      alias: 'Feishu Created',
      enabled: true,
      config: {},
    };

    const plan = buildAdapterSyncPlan({
      currentAdapterIds: ['removed', 'same', 'restart'],
      invalidAdapterIds: ['removed-invalid', 'same-invalid'],
      warningCacheIds: ['removed-warning', 'same-warning'],
      desiredInstances: [same, restart, created],
      getExistingFingerprint: (channelType) => {
        if (channelType === 'same') {
          return buildAdapterConfigFingerprint(same);
        }
        if (channelType === 'restart') {
          return buildAdapterConfigFingerprint({
            ...restart,
            config: { appId: 'old' },
          });
        }
        return null;
      },
    });

    assert.deepEqual(plan.stopChannelTypes, ['removed']);
    assert.deepEqual(plan.removeInvalidIds, ['removed-invalid', 'same-invalid']);
    assert.deepEqual(plan.removeWarningCacheIds, ['removed-warning', 'same-warning']);
    assert.deepEqual(
      plan.startItems.map((item) => ({
        id: item.instance.id,
        restartExisting: item.restartExisting,
      })),
      [
        { id: 'restart', restartExisting: true },
        { id: 'created', restartExisting: false },
      ],
    );
  });
});
