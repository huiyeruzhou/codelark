import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStreamRuntimeStatus,
  createStreamState,
  formatRuntimeDuration,
  formatStreamRuntimeStatus,
  recordStreamActivity,
  recordStreamContentResponse,
  shouldShowStreamLastActivityAge,
  updateStreamStatusNote,
  updateStreamThinkingNote,
} from '../../../../bridge/turn/stream-state.js';
import {
  formatFooterClockTime,
  formatFooterDuration,
} from '../../../../shared/progress/footer.js';
import {
  _testOnly as timeZoneTestOnly,
  resolveSystemTimeZone,
} from '../../../../shared/time-zone.js';

describe('stream-state', () => {
  it('formats durations without zero middle units and accumulates hours', () => {
    assert.equal(formatRuntimeDuration(10_000), '10s');
    assert.equal(formatRuntimeDuration(70_000), '1m10s');
    assert.equal(formatRuntimeDuration(60_000), '1m');
    assert.equal(formatRuntimeDuration(3_600_000), '1h');
    assert.equal(formatRuntimeDuration(3_610_000), '1h10s');
    assert.equal(formatRuntimeDuration(3_720_000), '1h2m');
    assert.equal(formatRuntimeDuration(3_730_000), '1h2m10s');
  });

  it('formats duration compactly and clock time explicitly in Beijing time', () => {
    assert.equal(formatFooterDuration(191_000), '3m11s');
    assert.equal(formatFooterClockTime(Date.UTC(2026, 6, 25, 2, 4, 23), 'Asia/Shanghai'), '10:04:23');
    assert.equal(formatFooterClockTime(Date.UTC(2026, 6, 25, 2, 4, 23), 'UTC'), '02:04:23');
  });

  it('recognizes common Unix localtime zoneinfo links', () => {
    assert.equal(
      timeZoneTestOnly.timeZoneFromLocaltimePath('/usr/share/zoneinfo/Asia/Shanghai'),
      'Asia/Shanghai',
    );
    assert.equal(
      timeZoneTestOnly.timeZoneFromLocaltimePath('/var/db/timezone/zoneinfo/America/Los_Angeles'),
      'America/Los_Angeles',
    );
  });

  it('uses the runtime system zone on macOS and Windows when TZ is not supplied', () => {
    const timeZone = resolveSystemTimeZone();
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone }).format(0));
    if ((process.platform === 'darwin' || process.platform === 'win32') && !process.env.TZ) {
      assert.equal(timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    }
  });

  it('shows elapsed time from the first sub-second update', () => {
    assert.equal(
      formatStreamRuntimeStatus(33, null, '❌ invalid_request_error'),
      '当前步骤：❌ invalid_request_error\n已运行 0s',
    );
  });

  it('shows last response age immediately when the configured delay is zero', () => {
    const state = createStreamState(1_000);

    assert.equal(
      shouldShowStreamLastActivityAge(state, 1_000, {
        idleStartMs: 0,
        heartbeatMs: 10_000,
      }),
      true,
    );
    assert.equal(
      buildStreamRuntimeStatus(state, 1_000, { includeLastActivityAge: true }),
      `${formatFooterClockTime(1_000)} · 已运行 0s · 上次响应 0s`,
    );
  });

  it('uses thinking and tool activity as the visible last response time', () => {
    const state = createStreamState(0);
    recordStreamContentResponse(state, 1_000);
    recordStreamActivity(state, 180_000);
    updateStreamStatusNote(state, '正在执行工具', 190_000);

    assert.equal(state.lastActivityAtMs, 190_000);
    assert.equal(state.lastContentResponseAtMs, 1_000);
    assert.equal(
      buildStreamRuntimeStatus(state, 191_000, { includeLastActivityAge: true }),
      `当前步骤：正在执行工具\n${formatFooterClockTime(191_000)} · 已运行 3m11s · 上次响应 1s`,
    );
  });

  it('uses turn start as fallback when no content response exists', () => {
    const state = createStreamState(0);

    assert.equal(
      shouldShowStreamLastActivityAge(state, 179_000, {
        idleStartMs: 180_000,
        heartbeatMs: 10_000,
      }),
      false,
    );
    assert.equal(
      shouldShowStreamLastActivityAge(state, 180_000, {
        idleStartMs: 180_000,
        heartbeatMs: 10_000,
      }),
      true,
    );
    assert.equal(
      buildStreamRuntimeStatus(state, 180_000, { includeLastActivityAge: true }),
      `${formatFooterClockTime(180_000)} · 已运行 3m · 上次响应 3m`,
    );
  });

  it('formats context usage and turn input output tokens in runtime status', () => {
    const state = createStreamState(0);
    state.contextUsage = {
      modelContextWindow: 200_000,
      lastTokenUsage: {
        inputTokens: 125_300,
        outputTokens: 4_600,
      },
    };

    assert.equal(
      buildStreamRuntimeStatus(state, 10_000),
      `${formatFooterClockTime(10_000)} · 已运行 10s · Context 125k(63%) · ↑125k ↓4.6k`,
    );
  });

  it('shows bounded current thinking in runtime status', () => {
    const state = createStreamState(0);
    updateStreamStatusNote(state, '思考', 1_000);
    updateStreamThinkingNote(state, '甲'.repeat(610), 2_000);

    assert.equal(
      buildStreamRuntimeStatus(state, 10_000),
      `当前步骤：思考\n当前思考：${'甲'.repeat(600)}...\n${formatFooterClockTime(10_000)} · 已运行 10s`,
    );
  });
});
