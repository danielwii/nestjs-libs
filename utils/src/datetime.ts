/**
 * Normalize a timezone for display, accepting IANA names and fixed offsets.
 * A fixed offset describes a clock projection, not geographic attribution.
 * Never promote this result to Anchored's Zone or infer a region from it.
 * Missing/invalid input returns null; callers choose an explicit rejection policy.
 */

const REFERENCE_INSTANT = Temporal.Instant.fromEpochMilliseconds(0);

/**
 * 标准化偏移格式为 Temporal 兼容格式。
 *
 * Temporal 只接受完整偏移格式 `+08:00`，不接受 `+8`。
 *
 * @returns 标准化的偏移格式，或 null（不是偏移量，或超出 ±14:00）
 */
function normalizeOffsetFormat(tz: string): string | null {
  const match = /^([+-])?(\d{1,2})(?::(\d{2}))?$/.exec(tz);
  if (!match) return null;

  const [, signStr, hoursStr, minutesStr] = match as (string | undefined)[];
  if (!hoursStr) return null;

  const sign = signStr ?? '+';
  const hours = parseInt(hoursStr, 10);
  const minutes = minutesStr ? parseInt(minutesStr, 10) : 0;

  // 有效范围：-14:00 到 +14:00，含端点；+14:30 不是合法偏移
  if (hours > 14 || minutes >= 60 || (hours === 14 && minutes > 0)) return null;

  return `${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

/**
 * 标准化时区字符串，供渲染使用。
 *
 * - 偏移量：`+8` / `8` / `+08:00` → `+08:00`。**无符号数字按正偏移读**——这是既有行为且有测试钉住。
 *   后果是一列存成字符串的整数偏移（含 `0`）会被当成真偏移，而不是「未设置」；调用方若有这类哨兵值，
 *   先自己拦下，不要指望这里替你区分。
 * - 其他一切交给 Temporal 校验并规范化：`asia/tokyo` → `Asia/Tokyo`，`utc` → `UTC`，`Japan` 原样。
 *   Temporal 不认的（`Asia/Shangai`、`invalid`）→ null，由调用方决定回落到什么。
 *
 * 只有这样本模块才做到头部承诺的事：脏字符串在这里变成 null，而不是穿过去在渲染处抛 RangeError。
 */
export function normalizeTimezone(timezone: string | null | undefined): string | null {
  if (!timezone) return null;
  const tz = timezone.trim();
  if (!tz) return null;

  const offset = normalizeOffsetFormat(tz);
  if (offset) return offset;
  // 长得像偏移量但没通过上面的校验（超出 ±14:00、格式不对）：就是 null，不再交给 Temporal——
  // Temporal 自己接受到 ±23:59 的偏移，会把 +14:30 这类值原样放回来。
  if (/^[+-]?\d/.test(tz)) return null;

  try {
    return REFERENCE_INSTANT.toZonedDateTimeISO(tz).timeZoneId;
  } catch (cause) {
    if (cause instanceof RangeError) return null;
    throw cause; // A runtime failure is not an invalid timezone.
  }
}
