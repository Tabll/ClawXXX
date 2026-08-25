import { Cron, CronPattern } from 'croner';
import type { CanonicalSchedule } from '@shared/domains/cron';
import type { CronSchedule } from '@shared/types/cron';

export const MIN_CRON_INTERVAL_MS = 1_000;
export const MAX_CRON_INTERVAL_MS = 365 * 24 * 60 * 60 * 1_000;

export type ScheduleNormalizationOptions = {
  now?: Date;
  defaultTimezone?: string;
};

/** Parse UI/compatibility input into the kernel-independent schedule model. */
export function normalizeCanonicalSchedule(
  value: string | CronSchedule,
  options: ScheduleNormalizationOptions = {},
): CanonicalSchedule {
  const now = options.now ?? new Date();
  const defaultTimezone = normalizeTimezone(options.defaultTimezone ?? 'UTC');
  if (typeof value === 'string') {
    return normalizeCron(value, defaultTimezone);
  }
  if (value.kind === 'at') {
    const at = parseDate(value.at, 'one-time schedule');
    return { kind: 'at', at: at.toISOString() };
  }
  if (value.kind === 'every') {
    if (!Number.isSafeInteger(value.everyMs)
      || value.everyMs < MIN_CRON_INTERVAL_MS
      || value.everyMs > MAX_CRON_INTERVAL_MS) {
      throw new Error(
        `Interval schedule must be an integer between ${MIN_CRON_INTERVAL_MS} and ${MAX_CRON_INTERVAL_MS} milliseconds`,
      );
    }
    const anchor = value.anchorMs === undefined
      ? now
      : parseDate(value.anchorMs, 'interval anchor');
    return { kind: 'interval', everyMs: value.everyMs, anchorAt: anchor.toISOString() };
  }
  return normalizeCron(value.expr, value.tz?.trim() || defaultTimezone);
}

export function validateCanonicalSchedule(schedule: CanonicalSchedule): CanonicalSchedule {
  if (schedule.kind === 'at') {
    return { kind: 'at', at: parseDate(schedule.at, 'one-time schedule').toISOString() };
  }
  if (schedule.kind === 'interval') {
    if (!Number.isSafeInteger(schedule.everyMs)
      || schedule.everyMs < MIN_CRON_INTERVAL_MS
      || schedule.everyMs > MAX_CRON_INTERVAL_MS) {
      throw new Error('Canonical interval is outside the supported range');
    }
    return {
      kind: 'interval',
      everyMs: schedule.everyMs,
      ...(schedule.anchorAt
        ? { anchorAt: parseDate(schedule.anchorAt, 'interval anchor').toISOString() }
        : {}),
    };
  }
  return normalizeCron(schedule.expression, schedule.timezone);
}

/** Return the first scheduled instant strictly after `after`. */
export function nextScheduleAt(schedule: CanonicalSchedule, after: Date): Date | undefined {
  const validated = validateCanonicalSchedule(schedule);
  const afterMs = requireFiniteDate(after, 'schedule cursor').getTime();
  if (validated.kind === 'at') {
    const at = Date.parse(validated.at);
    return at > afterMs ? new Date(at) : undefined;
  }
  if (validated.kind === 'interval') {
    const anchor = validated.anchorAt ? Date.parse(validated.anchorAt) : 0;
    if (anchor > afterMs) return new Date(anchor);
    const elapsed = afterMs - anchor;
    const steps = Math.floor(elapsed / validated.everyMs) + 1;
    const next = anchor + steps * validated.everyMs;
    if (!Number.isSafeInteger(next)) throw new Error('Interval schedule exceeds the supported date range');
    return new Date(next);
  }
  const cron = new Cron(validated.expression, {
    timezone: validated.timezone,
    paused: true,
    mode: '5-part',
  });
  try {
    return cron.nextRun(new Date(afterMs)) ?? undefined;
  } finally {
    cron.stop();
  }
}

/** Enumerate due instants, including `firstDue`, up to `through`. */
export function enumerateDueScheduleTimes(
  schedule: CanonicalSchedule,
  firstDue: Date,
  through: Date,
  limit = 1_000,
): Date[] {
  const start = requireFiniteDate(firstDue, 'first due time');
  const end = requireFiniteDate(through, 'due horizon');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error('Due-time enumeration limit is invalid');
  }
  if (start.getTime() > end.getTime()) return [];
  const result = [new Date(start)];
  while (result.length < limit) {
    const next = nextScheduleAt(schedule, result.at(-1)!);
    if (!next || next.getTime() > end.getTime()) break;
    if (next.getTime() <= result.at(-1)!.getTime()) throw new Error('Schedule failed to advance');
    result.push(next);
  }
  return result;
}

export function scheduleTimezone(schedule: CanonicalSchedule): string {
  return schedule.kind === 'cron' ? normalizeTimezone(schedule.timezone) : 'UTC';
}

export function calendarDayAt(instant: Date, timezone: string): string {
  const date = requireFiniteDate(instant, 'calendar instant');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: normalizeTimezone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = new Map(parts.map(part => [part.type, part.value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

function normalizeCron(expressionValue: string, timezoneValue: string): CanonicalSchedule {
  const expression = expressionValue.trim().replace(/\s+/g, ' ');
  if (expression.split(' ').length !== 5) throw new Error('Cron schedule must use exactly five fields');
  const timezone = normalizeTimezone(timezoneValue);
  try {
    new CronPattern(expression, timezone, { mode: '5-part' });
  } catch (error) {
    throw new Error(`Invalid cron expression: ${expression}`, { cause: error });
  }
  return { kind: 'cron', expression, timezone };
}

function normalizeTimezone(value: string): string {
  const timezone = value.trim();
  if (!timezone || timezone.length > 100) throw new Error('IANA timezone is required');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
  } catch (error) {
    throw new Error(`Invalid IANA timezone: ${timezone}`, { cause: error });
  }
  return timezone;
}

function parseDate(value: string | number, label: string): Date {
  const date = new Date(value);
  return requireFiniteDate(date, label);
}

function requireFiniteDate(value: Date, label: string): Date {
  if (!Number.isFinite(value.getTime())) throw new Error(`Invalid ${label}`);
  return value;
}
