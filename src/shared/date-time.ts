import { resolveSystemTimeZone } from './time-zone.js';

type DateTimeValue = string | number | Date;

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = dateTimeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    dateTimeFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function dateTimeParts(value: DateTimeValue, timeZone: string): Record<string, string> | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
}

export function formatLocalDateTime(
  value: DateTimeValue,
  timeZone = resolveSystemTimeZone(),
): string | null {
  const parts = dateTimeParts(value, timeZone);
  if (!parts) return null;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function formatLocalMonthDayTime(
  value: DateTimeValue,
  timeZone = resolveSystemTimeZone(),
): string | null {
  const parts = dateTimeParts(value, timeZone);
  if (!parts) return null;
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

export function formatLocalClockTime(
  value: DateTimeValue,
  timeZone = resolveSystemTimeZone(),
): string | null {
  const parts = dateTimeParts(value, timeZone);
  if (!parts) return null;
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}
