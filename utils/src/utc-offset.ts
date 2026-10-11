/**
 * UTC offsets spelled as text, and zone names that denote a constant offset.
 *
 * Goal: one place that answers "is this string a fixed UTC offset?" and "how many minutes?", so callers stop
 *   keeping their own regular expressions for `UTC+8`, `GMT-05:30` and `Etc/GMT+8`.
 * Design:
 *   - An offset is not a zone. Attribution is always an IANA place name (`assertZone` in `./anchored` rejects offsets);
 *     these helpers exist for text that carries an offset as a *fact to apply* (structured page data, a stated clock),
 *     where the offset is used arithmetically and never stored as the zone.
 *   - `parseUtcOffsetMinutes` reads the spelled form; `isFixedOffsetZone` recognises the zone *names* whose offset never
 *     changes (`UTC`, `GMT`, `Etc/UTC`, `Etc/GMT`, `Etc/GMT±N`). They answer different questions and do not overlap:
 *     `Etc/GMT+8` is a zone name (and means UTC−8, the POSIX sign), `UTC+8` is a spelled offset.
 * Guarantees: both are pure and total (undefined / blank / malformed → null / false, never a throw); `parseUtcOffsetMinutes`
 *   accepts hours 0–14 and minutes 0–59 only.
 * Not covered: validating that a string is a usable zone (`assertZone`); mapping an offset onto a zone (impossible in general).
 * Exit: none.
 */

const SPELLED_OFFSET = /^(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$/i;
const FIXED_OFFSET_ZONE = /^(?:UTC|GMT|Etc\/(?:UTC|GMT(?:[+-]\d{1,2})?))$/i;

/** Minutes east of UTC for a spelled offset — `UTC+8`, `GMT-05:30`, `UTC+0530`, `+08:00`. Null when the text is not one. */
export function parseUtcOffsetMinutes(value: string | null | undefined): number | null {
  const match = SPELLED_OFFSET.exec(value?.trim() ?? '');
  if (!match) return null;
  const [, sign, hh, mm] = match;
  const hours = Number(hh);
  const minutes = mm ? Number(mm) : 0;
  if (hours > 14 || minutes > 59) return null;
  return (sign === '-' ? -1 : 1) * (hours * 60 + minutes);
}

/** True for the zone names whose UTC offset never changes: `UTC`, `GMT`, `Etc/UTC`, `Etc/GMT`, `Etc/GMT+8`. */
export function isFixedOffsetZone(zone: string | null | undefined): boolean {
  return FIXED_OFFSET_ZONE.test(zone?.trim() ?? '');
}
