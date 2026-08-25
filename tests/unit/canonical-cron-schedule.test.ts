// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  calendarDayAt,
  enumerateDueScheduleTimes,
  nextScheduleAt,
  normalizeCanonicalSchedule,
} from '@electron/scheduler/schedule';

describe('canonical Cron schedule parser', () => {
  it('normalizes five-field cron, one-time and anchored interval schedules', () => {
    expect(normalizeCanonicalSchedule(' 0   9 * * 1-5 ')).toEqual({
      kind: 'cron', expression: '0 9 * * 1-5', timezone: 'UTC',
    });
    expect(normalizeCanonicalSchedule({ kind: 'at', at: '2026-08-24T00:00:00Z' })).toEqual({
      kind: 'at', at: '2026-08-24T00:00:00.000Z',
    });
    expect(normalizeCanonicalSchedule(
      { kind: 'every', everyMs: 60_000 },
      { now: new Date('2026-08-24T00:00:00Z') },
    )).toEqual({
      kind: 'interval', everyMs: 60_000, anchorAt: '2026-08-24T00:00:00.000Z',
    });
  });

  it('rejects malformed expressions, unsafe intervals and invalid IANA timezones', () => {
    expect(() => normalizeCanonicalSchedule('* * * * * *')).toThrow(/exactly five/i);
    expect(() => normalizeCanonicalSchedule({ kind: 'every', everyMs: 999 })).toThrow(/between/i);
    expect(() => normalizeCanonicalSchedule({ kind: 'cron', expr: '* * * * *', tz: 'Mars/Olympus' }))
      .toThrow(/timezone/i);
  });

  it('computes DST-aware cron instants and timezone calendar days', () => {
    const schedule = normalizeCanonicalSchedule({
      kind: 'cron', expr: '0 9 * * *', tz: 'America/New_York',
    });
    expect(nextScheduleAt(schedule, new Date('2026-03-08T12:00:00Z'))?.toISOString())
      .toBe('2026-03-08T13:00:00.000Z');
    expect(calendarDayAt(new Date('2026-03-08T04:30:00Z'), 'America/New_York')).toBe('2026-03-07');
  });

  it('enumerates due interval times without duplicates and advances strictly', () => {
    const schedule = normalizeCanonicalSchedule({
      kind: 'every', everyMs: 60_000, anchorMs: Date.parse('2026-08-24T00:00:00Z'),
    });
    expect(enumerateDueScheduleTimes(
      schedule,
      new Date('2026-08-24T00:01:00Z'),
      new Date('2026-08-24T00:03:00Z'),
    ).map(date => date.toISOString())).toEqual([
      '2026-08-24T00:01:00.000Z',
      '2026-08-24T00:02:00.000Z',
      '2026-08-24T00:03:00.000Z',
    ]);
  });
});
