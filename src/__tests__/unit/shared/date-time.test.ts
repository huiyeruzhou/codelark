import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatLocalClockTime,
  formatLocalDateTime,
  formatLocalMonthDayTime,
} from '../../../shared/date-time.js';
import { formatFooterClockTime } from '../../../shared/progress/footer.js';
import { resolveSystemTimeZone } from '../../../shared/time-zone.js';
import { formatCommandDateTime } from '../../../bridge/command/presentation.js';

describe('user-visible local time formatting', () => {
  const timestamp = '2026-07-27T02:04:05.000Z';

  it('formats absolute timestamps in an explicit local time zone', () => {
    assert.equal(formatLocalDateTime(timestamp, 'Asia/Shanghai'), '2026-07-27 10:04:05');
    assert.equal(formatLocalMonthDayTime(timestamp, 'Asia/Shanghai'), '07/27 10:04');
    assert.equal(formatLocalClockTime(timestamp, 'Asia/Shanghai'), '10:04:05');
  });

  it('keeps command timestamps and streaming footer clocks on the same cached system time zone', () => {
    const timeZone = resolveSystemTimeZone();
    assert.equal(formatCommandDateTime(timestamp), formatLocalDateTime(timestamp, timeZone));
    assert.equal(formatFooterClockTime(Date.parse(timestamp)), formatLocalClockTime(timestamp, timeZone));
  });

  it('keeps UTC correct without relying on process-local Date getters', () => {
    assert.equal(formatLocalDateTime(timestamp, 'UTC'), '2026-07-27 02:04:05');
  });
});
