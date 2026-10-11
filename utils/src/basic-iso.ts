/**
 * RFC 5545 "basic" date and date-time text (`20261012`, `20261012T093000`, `20261012T093000Z`) <-> Temporal values.
 *
 * Temporal parses and prints the extended ISO form (`2026-10-12T09:30:00Z`) only. The basic form is what iCalendar
 * properties (UNTIL, RDATE, EXDATE, DTSTART, RECURRENCE-ID) and several calendar APIs carry, so every caller used to hand-roll
 * a format string. This module is the one place that reads and writes it.
 *
 * The two date-time forms mean different things and are never one type:
 *   - `...Z` is an instant (UTC);
 *   - without `Z` it is floating: a wall-clock reading that belongs to no zone until the caller anchors it.
 * {@link parseBasicDateTime} returns a discriminated union so the caller must switch on which one it got; there is no boolean
 * to ignore and no way to read a UTC value as a wall time by accident. Printing is two functions for the same reason:
 * {@link formatBasicUtc} takes an instant, {@link formatBasicFloating} takes a plain date-time, and a zoned value must be
 * turned into one of them explicitly (`.toInstant()` or `.toPlainDateTime()`) — that choice is the decision.
 *
 * Every malformed input throws a `RangeError`; nothing returns a "maybe valid" value. Printing truncates to whole seconds
 * (the format has no fraction) and requires a four-digit year.
 */

const BASIC_DATE = /^(\d{4})(\d{2})(\d{2})$/;
const BASIC_DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;

export type BasicDateTime =
  { kind: 'utc'; instant: Temporal.Instant } | { kind: 'floating'; dateTime: Temporal.PlainDateTime };

function malformed(text: string, expected: string): never {
  throw new RangeError(`basic ISO: expected ${expected}, got "${text}"`);
}

/** `yyyyMMdd` -> the calendar date. A date that does not exist (`20260230`) throws. */
export function parseBasicDate(text: string): Temporal.PlainDate {
  const match = BASIC_DATE.exec(text);
  if (!match) return malformed(text, 'yyyyMMdd');
  try {
    return Temporal.PlainDate.from(
      { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) },
      { overflow: 'reject' },
    );
  } catch {
    return malformed(text, 'a real calendar date');
  }
}

/** `yyyyMMdd'T'HHmmss'Z'` -> an instant; `yyyyMMdd'T'HHmmss` -> a floating wall-clock date-time. */
export function parseBasicDateTime(text: string): BasicDateTime {
  const match = BASIC_DATE_TIME.exec(text);
  if (!match) return malformed(text, "yyyyMMdd'T'HHmmss with an optional Z");
  let dateTime: Temporal.PlainDateTime;
  try {
    dateTime = Temporal.PlainDateTime.from(
      {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour: Number(match[4]),
        minute: Number(match[5]),
        second: Number(match[6]),
      },
      { overflow: 'reject' },
    );
  } catch {
    return malformed(text, 'a real calendar date and time');
  }
  return match[7] === 'Z'
    ? { kind: 'utc', instant: dateTime.toZonedDateTime('UTC').toInstant() }
    : { kind: 'floating', dateTime };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function year4(year: number): string {
  if (year < 0 || year > 9999) throw new RangeError(`basic ISO: year ${year} does not fit four digits`);
  return pad(year, 4);
}

/** The calendar date as `yyyyMMdd`. */
export function formatBasicDate(date: Temporal.PlainDate): string {
  return `${year4(date.year)}${pad(date.month, 2)}${pad(date.day, 2)}`;
}

function formatDateTimeParts(dateTime: Temporal.PlainDateTime): string {
  return `${formatBasicDate(dateTime.toPlainDate())}T${pad(dateTime.hour, 2)}${pad(dateTime.minute, 2)}${pad(dateTime.second, 2)}`;
}

/** An instant as `yyyyMMdd'T'HHmmss'Z'`, truncated to the second. */
export function formatBasicUtc(instant: Temporal.Instant): string {
  return `${formatDateTimeParts(instant.toZonedDateTimeISO('UTC').toPlainDateTime())}Z`;
}

/** A floating wall-clock date-time as `yyyyMMdd'T'HHmmss` (no `Z`), truncated to the second. */
export function formatBasicFloating(dateTime: Temporal.PlainDateTime): string {
  return formatDateTimeParts(dateTime);
}
