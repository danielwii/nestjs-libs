/**
 * 渲染侧的时区宽容层。
 *
 * 只做一件事：把一个来路不明的时区字符串，变成「能拿去渲染的东西，或者 null」。它**不是**时区解析
 * 器，也**不是** {@link ./anchored} 的前置适配器——两者的策略是相反的：
 *
 *   - `Anchored` 只认 IANA 名，拿到 `+08:00` 直接抛错。因为偏移量里没有地区身份，且同一时区在夏令时
 *     前后是两个偏移；把偏移量当归属存下来，跨季节会静默差一小时。
 *   - 本模块拿到 `+8` 会补成 `+08:00` 原样放行。它不翻译成 IANA 名，也翻译不了。
 *
 * 所以：**本模块的输出不得进入 `Anchored`，也不得写入持久层。** 它的合法用途只有一个——在纯展示路径
 * 上（日志 banner、给模型看的时间、调试输出）避免因为一个脏时区字符串让整条渲染崩掉。
 *
 * 它之所以还存在，是因为存量数据里通常仍有极少量裸偏移量。那些行是坏数据，正确的处理是在应用侧用别的
 * 证据（用户地址/国家、设备上报的 IANA 名、locale）把它们迁成 IANA 名——见 `anchored.ts` 里关于迁移
 * 输入的说明。**那批数据清干净之后，本模块就该被删掉**，调用点直接用 `Anchored` 的规则：认不出来的
 * 时区就是认不出来，回落到显式的默认值，不要先洗一道。
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
  } catch {
    // 宽容层的契约就是不抛：认不出来返回 null，让调用方用自己的显式默认值。
    return null;
  }
}
