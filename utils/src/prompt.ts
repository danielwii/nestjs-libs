import { Anchored, assertZone } from './anchored';

import type { AnchoredProjection, Zone } from './anchored';
import type { z } from 'zod';

export function generateJsonFormat(schema: z.ZodType, indent = 0): string {
  const definition = Reflect.get(schema, '_def');
  const serialized = JSON.stringify(definition, (_key, value) => (typeof value === 'function' ? undefined : value), 2);
  const indentPrefix = ' '.repeat(indent);
  return serialized
    .split('\n')
    .map((line) => `${indentPrefix}${line}`)
    .join('\n');
}

/**
 * Temporal formatting patterns（不含 dayPeriod 和时区，由 readLocalTime 拼接）。
 *
 * dayPeriod 通过 Intl toLocaleString({ dayPeriod: 'long' }) 获取（"in the morning" 等）。
 */
export enum TimeSensitivity {
  Day = 'yyyy-MM-dd EEEE',
  Hour = 'yyyy-MM-dd EEEE hh a',
  Minute = 'yyyy-MM-dd EEEE HH:mm',
}

export type PromptDateTime = string | Temporal.Instant | Temporal.ZonedDateTime;
/** `readLocalTime` 的输入：一个绝对时刻（`PromptDateTime`），或一整个日历日（`Temporal.PlainDate`）。 */
export type LocalTimeValue = PromptDateTime | Temporal.PlainDate;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/**
 * 一个时间在某个读者眼中的「读数」（reading）：投影到读者的时区之后，写成 AI 能直接读的一行，
 * 再附上同一次投影得到的事实字段。
 *
 * **为谁存在**：读这段文字的是语言模型（prompt 里的 Now 行、日历候选、空档、受理回话、
 * 裁判状态）。它防的失败是「模型拿到裸 UTC 或没有时区的钟点，只能自己换算或猜」——
 * 换算会错、猜会静默。所以本类型只回答一个问题：**这个时间，在读者看来，是几点、哪一天、
 * 属于谁**。
 *
 * **不是什么**：`text` 是给人／模型读的呈现，不是时间的序列化，也不是事件的身份。两个不同
 * 瞬时在墙钟上本来就可能撞（DST 回拨那一小时、跨午夜），呈现层只在会撞的地方补偏移量让读者
 * 分得开，身份与精确比较请用 {@link TimeReading.instant}（ISO-8601 UTC，程序用），不要从
 * `text` 反解析。
 *
 * **字段为什么存在**：
 * - `text`：只有一行能放时给模型读的完整形态。instant 保留一直以来的 Now 行措辞——
 *   `2026-03-21 Saturday 04:20 in the morning (Asia/Tokyo)`——星期与时段短语不是装饰：模型曾
 *   经常忽略当前时间说出不合时宜的话，把时间写成人话是让它注意到时间的手段（时间注意力锚点）。
 *   date 就是日期本身（`2026-09-20`），不随读者位移。读者本地钟点在其时区有两个可能瞬时
 *   （回拨重叠小时）时，钟点后附 UTC 偏移量，例如 `01:30-07:00`。
 * - `instant`：这个读数对应的绝对时刻（ISO-8601 UTC）；只有 instant 形态有。程序要比较、
 *   排序、去重时用它，不用 `text`。
 * - `shape`：instant 还是 date。消费者据此决定要不要附钟点、要不要按观察者换算。
 * - `zone`：`text` 所用的读者时区。prompt 只需宣告一次「以下时间均为 X」。
 * - `ownZone`：这个值本来属于谁的时区（归属，来自存储的 originalTimezone 或调用方）；
 *   `Anchored` 的规则是没有归属的值不存在，所以这里永远有值。
 * - `sameZone`：归属是否就是读者时区。要不要标注归属由代码据此决定，不交给模型判断。
 * - `ownText`：仅 `sameZone === false` 时有——同一时刻在归属时区里读起来是几点；若归属方的
 *   日期与读者的不同（跨午夜），一并带上日期，例如 `2026-09-22 17:30 (America/Los_Angeles)`，
 *   否则读者无法知道「对方那边其实还是前一天」。
 * - `weekday`：星期是模型判「周日」「下周三」这类词的事实依据，不让模型自己算。
 * - `dayPeriod`：时段短语（见 `text`），仅 instant 有——日历日没有确定的时段。
 *
 * **延展**：新增字段只能是同一次投影的事实（additive），不改既有字段语义；需要另一种措辞
 * 的消费者先说明是谁、为什么，再加参数，不给默认开关。全天多日区间见 {@link SpanReading}。
 */
export interface TimeReading {
  text: string;
  instant?: string;
  shape: 'instant' | 'date';
  zone: Zone;
  ownZone: Zone;
  sameZone: boolean;
  ownText?: string;
  weekday: string;
  dayPeriod?: string;
}

/**
 * 一段起止时间在读者眼中的读数，语义同 {@link TimeReading}，`text` 换成一段：
 * `2026-09-23 15:00–16:00 (Asia/Taipei)`，本地跨日则 `2026-09-23 23:30 → 2026-09-24 00:30 (…)`。
 * 两端任一钟点在读者时区里有歧义（回拨重叠小时），或两端偏移量不同（跨转换点），两端钟点都
 * 附偏移量：`01:30-07:00–01:30-08:00`。`start`/`end` 是两端的绝对时刻（ISO-8601 UTC），程序用。
 * 归属（`ownZone`/`sameZone`/`ownText`）与 {@link TimeReading} 同义：别人的事件区间在读者钟点里
 * 是几点到几点，在其本人钟点里是几点到几点（`ownText`，本人日期与读者不同时带日期）。
 *
 * 只覆盖 instant 起止（事件、空档的开始/结束）。全天多日区间还没有消费者要求过这个函数产出，
 * 出现时再加，不先猜格式。
 */
export interface SpanReading {
  text: string;
  start: string;
  end: string;
  shape: 'instant';
  zone: Zone;
  ownZone: Zone;
  sameZone: boolean;
  ownText?: string;
}

/** A fixed-instant parameter must never silently become the current clock (Codex P2). */
function requireFixedInstant(at: PromptDateTime | null | undefined, fn: string): PromptDateTime {
  if (at === null || at === undefined || (typeof at === 'string' && at.trim() === '')) {
    throw new TypeError(`${fn}: a fixed instant is required (got ${JSON.stringify(at)})`);
  }
  return at;
}

/**
 * `null`/`undefined` 表示"现在"——只有 `readLocalTime`/`formatLocalDateTime` 的 Now 行路径
 * 会省略这个参数。显式传入的空串是别的东西（漏了插值、拼错了变量），不是"没给"，不能被同一个
 * falsy 判断悄悄读成"现在"（Codex P2）：那会让一个本该报错的调用方看到一个能用但错误的
 * Now 行。`readLocalSpan`/`zonedAt` 走 `requireFixedInstant`，到这里之前已经排除了空串，
 * 这条分支实际只服务 `readLocalTime` 的省略参数场景。
 */
function toInstant(dateOrIso?: PromptDateTime | null): Temporal.Instant {
  if (dateOrIso === null || dateOrIso === undefined) return Temporal.Now.instant();
  if (typeof dateOrIso === 'string' && dateOrIso.trim() === '') {
    throw new TypeError(
      'readLocalTime: an empty string is not "now" — omit the value entirely for the current instant',
    );
  }
  if (dateOrIso instanceof Temporal.ZonedDateTime) return dateOrIso.toInstant();
  return typeof dateOrIso === 'string' ? Temporal.Instant.from(dateOrIso) : dateOrIso;
}

/**
 * 构造 + 投影一个 instant，各只走一次：校验交给 `Anchored`（`assertZone`），换算交给
 * `Anchored.in()`，这里不重新判定时区合法性。`ownZone` 与 `observerZone` 相同时（`zonedAt`、
 * `readLocalTime` 的默认路径）这一步是恒等投影，只是复用同一实现，不是特别绕路。
 */
function projectInstant(
  value: PromptDateTime | null | undefined,
  observerZone: Zone,
  ownZone: Zone,
): Extract<AnchoredProjection, { shape: 'instant' }> {
  const instant = toInstant(value);
  return Anchored.instant(instant, ownZone).in(observerZone) as Extract<AnchoredProjection, { shape: 'instant' }>;
}

function formatZoneName(zdt: Temporal.ZonedDateTime): string {
  const tz = zdt.timeZoneId;
  const offset = /^([+-])(\d{2}):(\d{2})$/.exec(tz);
  if (!offset) return tz;

  const [, sign, hour, minute] = offset;
  const hourText = String(Number(hour));
  const minuteText = minute === '00' ? '' : `:${minute}`;
  return `UTC${sign}${hourText}${minuteText}`;
}

function formatTemporal(zdt: Temporal.ZonedDateTime, sensitivity: TimeSensitivity): string {
  const date = `${zdt.year.toString().padStart(4, '0')}-${zdt.month.toString().padStart(2, '0')}-${zdt.day.toString().padStart(2, '0')}`;
  const weekday = weekdayOf(zdt.dayOfWeek);
  const hour24 = zdt.hour.toString().padStart(2, '0');
  const minute = zdt.minute.toString().padStart(2, '0');

  if (sensitivity === TimeSensitivity.Day) return `${date} ${weekday}`;
  if (sensitivity === TimeSensitivity.Hour) {
    const hour12 = (zdt.hour % 12 || 12).toString().padStart(2, '0');
    const period = zdt.hour < 12 ? 'AM' : 'PM';
    return `${date} ${weekday} ${hour12} ${period}`;
  }
  return `${date} ${weekday} ${hour24}:${minute}`;
}

function formatDayPeriod(zdt: Temporal.ZonedDateTime): string {
  if (zdt.hour < 12) return 'in the morning';
  if (zdt.hour === 12 && zdt.minute === 0 && zdt.second === 0 && zdt.millisecond === 0) return 'noon';
  if (zdt.hour < 18) return 'in the afternoon';
  if (zdt.hour < 21) return 'in the evening';
  return 'at night';
}

function plainTimeToClock(time: Temporal.PlainTime): string {
  return `${time.hour.toString().padStart(2, '0')}:${time.minute.toString().padStart(2, '0')}`;
}

/** ISO `dayOfWeek`（1=Monday..7=Sunday，Temporal 的 date/zoned-date-time 都用这个编号）→ 英文星期名。 */
function weekdayOf(dayOfWeek: number): string {
  const weekday = WEEKDAYS[dayOfWeek - 1];
  if (!weekday) throw new Error(`prompt: 非法的 dayOfWeek ${dayOfWeek}`);
  return weekday;
}

/**
 * 星期 + 钟点 + 时段短语的人话本体，不含时区。`formatLocalDateTime` 的 `Now:` 行文本与
 * `decorateWithNow` 的 `<now>` 标签内文都是这句话——前者在外面再拼一段 `(zone)`，后者的时区
 * 走 XML 属性——共用这一步是为了不让同一段措辞在两处各自拼一遍。
 */
function renderLocalMoment(
  zdt: Temporal.ZonedDateTime,
  sensitivity: TimeSensitivity,
  dayPeriod: string,
  clockSuffix = '',
): string {
  if (sensitivity === TimeSensitivity.Day) return `${formatTemporal(zdt, sensitivity)} ${dayPeriod}`;
  // Hour 精度写成 "01 AM" 这种形状——偏移量接在 AM/PM 后面会读成别的东西（"01 AM-07:00" 像一段
  // 范围，不像"一个钟点+它的时区"）。Minute 精度是 "01:30"，偏移量接在数字后面本身就清楚
  // （Codex P2）。所以只在真的有歧义（`clockSuffix` 非空）时退化成 Minute，不影响不歧义的
  // 调用方；歧义时"退化成更细精度"永远安全，因为更细精度只会多给信息，不会丢信息。
  const effective = clockSuffix && sensitivity === TimeSensitivity.Hour ? TimeSensitivity.Minute : sensitivity;
  return `${formatTemporal(zdt, effective)}${clockSuffix} ${dayPeriod}`;
}

/**
 * 歧义时的偏移量后缀，否则空串——这是本模块**唯一**把"这个钟点有没有歧义"变成"要不要附
 * 偏移量"的地方。单点的观察者钟点、单点的归属方钟点（`ownText`）、区间两端的钟点，都调这
 * 一个函数，不是各自重新判一遍 `isAmbiguousLocalClock(...) ? zdt.offset : ''`。
 */
function ambiguityOffset(zdt: Temporal.ZonedDateTime, force = false): string {
  return force || isAmbiguousLocalClock(zdt) ? zdt.offset : '';
}

/** 钟点 + 偏移量后缀（仅在该钟点有歧义时）：观察者文本与归属方文本用同一条规则。 */
function clockWithDisambiguation(zdt: Temporal.ZonedDateTime, force = false): string {
  return plainTimeToClock(zdt.toPlainTime()) + ambiguityOffset(zdt, force);
}

/**
 * 一段起止在某个时区里写成一行：同日 `2026-09-23 15:00–16:00`，跨日 `2026-09-23 23:30 → 2026-09-24 00:30`。
 * 两端任一钟点有歧义或两端偏移量不同时两端都附偏移量。`leadingDate=false` 时同日形态省掉日期
 * （归属方文本已在观察者文本旁，日期相同就不重复）。
 */
function renderSpanClocks(
  startZdt: Temporal.ZonedDateTime,
  endZdt: Temporal.ZonedDateTime,
  leadingDate: boolean,
): string {
  const force = startZdt.offset !== endZdt.offset || isAmbiguousLocalClock(startZdt) || isAmbiguousLocalClock(endZdt);
  const startClock = clockWithDisambiguation(startZdt, force);
  const endClock = clockWithDisambiguation(endZdt, force);
  const startDate = startZdt.toPlainDate();
  const endDate = endZdt.toPlainDate();
  if (startDate.equals(endDate)) return `${leadingDate ? `${startDate.toString()} ` : ''}${startClock}–${endClock}`;
  return `${startDate.toString()} ${startClock} → ${endDate.toString()} ${endClock}`;
}

/**
 * 读者本地钟点在其时区里是否对应两个瞬时（DST 回拨的重叠小时）。是的话呈现层要在钟点后附
 * 偏移量，否则两个不同时刻会写成同一行字。用 Temporal 的 earlier/later 消歧比较，不自己算规则。
 */
function isAmbiguousLocalClock(zdt: Temporal.ZonedDateTime): boolean {
  const wall = zdt.toPlainDateTime();
  const earlier = wall.toZonedDateTime(zdt.timeZoneId, { disambiguation: 'earlier' });
  const later = wall.toZonedDateTime(zdt.timeZoneId, { disambiguation: 'later' });
  return !earlier.equals(later);
}

/**
 * 把一个时间读给读者：本模块唯一的投影 + 渲染实现，其余导出函数都是它的薄壳。
 * 返回值的字段与措辞的理由见 {@link TimeReading}。
 *
 * - `value`：instant（会议、"现在"）或 `Temporal.PlainDate`（生日、假期这类全天日期）。
 *   `null`/`undefined` 表示"现在"，只允许在 Now 行这条路径上出现（`formatLocalDateTime`）。
 * - `observer`：读这段文字的人所在的时区，**必填、无默认**，且必须已是 `Zone`——校验只发生
 *   一次，在调用方把裸字符串变成 `Zone` 的那一步（`assertZone`，例如 `formatLocalDateTime`/
 *   `zonedAt` 这类真正的写入闸门），不在这里重来一遍。默认值本身曾是事故来源：缺省时静默落回
 *   `process.env.TZ`，让台北的家庭读到洛杉矶的 Now 行——这条规则没变，只是校验点挪到了闸门。
 * - `ownZone`：这个值实际归属的时区，同样必须已是 `Zone`。`undefined` 表示"就是读者自己的"
 *   （Now 行），不会悄悄改写成读者时区去把别人的事件标成 `sameZone: true`。
 * - `sensitivity`：Now 行的精度（分钟/小时/日），沿用既有 `formatLocalDateTime` 的参数。
 */
export function readLocalTime(
  value: LocalTimeValue | null | undefined,
  observer: Zone,
  ownZone?: Zone,
  sensitivity: TimeSensitivity = TimeSensitivity.Minute,
): TimeReading {
  // `observer`/`ownZone` are `Zone`, not `string` — the caller (a resolver function, or one of
  // this module's own boundary entry points below) already ran `assertZone`; re-validating here
  // would be exactly the redundant runtime check the brand exists to make unnecessary.
  const observerZone = observer;
  const attribution = ownZone ?? observerZone;

  if (value instanceof Temporal.PlainDate) {
    const projection = Anchored.date(value, attribution).in(observerZone) as Extract<
      AnchoredProjection,
      { shape: 'date' }
    >;
    const result: TimeReading = {
      text: projection.date.toString(),
      shape: 'date',
      zone: observerZone,
      ownZone: projection.ownZone,
      sameZone: projection.sameZone,
      weekday: weekdayOf(projection.date.dayOfWeek),
    };
    if (!projection.sameZone) result.ownText = `(${projection.ownZone})`;
    return result;
  }

  const projection = projectInstant(value, observerZone, attribution);
  const zdt = projection.at;
  const dayPeriod = formatDayPeriod(zdt);
  const clockSuffix = ambiguityOffset(zdt);
  const text = `${renderLocalMoment(zdt, sensitivity, dayPeriod, clockSuffix)} (${formatZoneName(zdt)})`;
  const result: TimeReading = {
    text,
    instant: zdt.toInstant().toString(),
    shape: 'instant',
    zone: observerZone,
    ownZone: projection.ownZone,
    sameZone: projection.sameZone,
    weekday: weekdayOf(zdt.dayOfWeek),
    dayPeriod,
  };
  if (!projection.sameZone) {
    // 归属方钟点套同一条歧义规则：归属方处在回拨重叠小时而读者不在时，两个瞬时的 ownText 否则会一样。
    const own = zdt.withTimeZone(projection.ownZone);
    const crossesDay = !own.toPlainDate().equals(zdt.toPlainDate());
    result.ownText = `${crossesDay ? `${own.toPlainDate().toString()} ` : ''}${clockWithDisambiguation(own)} (${projection.ownZone})`;
  }
  return result;
}

export function formatLocalDateTime(
  dateOrIso?: PromptDateTime | null,
  sensitivity: TimeSensitivity = TimeSensitivity.Minute,
  timezone?: string | null,
): string {
  // This function (like `zonedAt`) is the untrusted boundary — `timezone` is a raw caller string
  // (possibly missing/empty), validated here once via `assertZone` before it ever becomes a `Zone`.
  return readLocalTime(dateOrIso, assertZone(timezone ?? '', 'instant'), undefined, sensitivity).text;
}

/**
 * 把一段起止时间读给读者：语义与理由见 {@link SpanReading}。两端都必须是确定的瞬时——空值
 * 不会被当成"现在"（`requireFixedInstant`）。`ownZone` 与 {@link readLocalTime} 同义：这段区间
 * 本来属于谁的时区（别人的事件、别人的空档）；不传即读者自己的。
 */
export function readLocalSpan(start: PromptDateTime, end: PromptDateTime, observer: Zone, ownZone?: Zone): SpanReading {
  const observerZone = observer;
  const attribution = ownZone ?? observerZone;
  const startProjection = projectInstant(requireFixedInstant(start, 'readLocalSpan'), observerZone, attribution);
  const endProjection = projectInstant(requireFixedInstant(end, 'readLocalSpan'), observerZone, attribution);
  const startZdt = startProjection.at;
  const endZdt = endProjection.at;
  const result: SpanReading = {
    text: `${renderSpanClocks(startZdt, endZdt, true)} (${formatZoneName(startZdt)})`,
    start: startZdt.toInstant().toString(),
    end: endZdt.toInstant().toString(),
    shape: 'instant',
    zone: observerZone,
    ownZone: startProjection.ownZone,
    sameZone: startProjection.sameZone,
  };
  if (!startProjection.sameZone) {
    const ownStart = startZdt.withTimeZone(startProjection.ownZone);
    const ownEnd = endZdt.withTimeZone(startProjection.ownZone);
    const crossesDay = !ownStart.toPlainDate().equals(startZdt.toPlainDate());
    result.ownText = `${renderSpanClocks(ownStart, ownEnd, crossesDay)} (${startProjection.ownZone})`;
  }
  return result;
}

/**
 * Prepend a `<now>` block to dynamic prompt content.
 *
 * Cache-aware prompt layout: the current time is the most volatile input, so it belongs at the
 * front of the per-turn (dynamic) message, never inside the static system prompt. Callers that
 * move the time here render their system prompt with `now: null`. The zoned time carries
 * its own timezone, so nothing else needs to be configured.
 *
 * @example
 * ```typescript
 * decorateWithNow(payload, Temporal.Now.zonedDateTimeISO('Asia/Hong_Kong'))
 * // <now timezone="Asia/Hong_Kong">2026-09-15 Tuesday 18:22 in the evening</now>
 * // ...payload
 * ```
 */
export function decorateWithNow(content: string, now: Temporal.ZonedDateTime): string {
  const label = renderLocalMoment(now, TimeSensitivity.Minute, formatDayPeriod(now));
  return `<now timezone="${now.timeZoneId}">${label}</now>\n${content}`;
}

/** A given instant (ISO string / Instant / ZonedDateTime) as a zoned Temporal value. `timezone` is required — a missing or invalid one throws (see `Anchored`/`assertZone`). */
export function zonedAt(at: PromptDateTime, timezone?: string | null): Temporal.ZonedDateTime {
  const observerZone = assertZone(timezone ?? '', 'instant');
  return projectInstant(requireFixedInstant(at, 'zonedAt'), observerZone, observerZone).at;
}

/**
 * Mark the person's verbatim words inside a runtime-composed user message, so the model can tell
 * the actual human input apart from context the runtime placed next to it.
 */
export function decorateUserInput(text: string): string {
  // Entity-escape so verbatim text can never close or open a wrapper (e.g. a literal `</user_input>`).
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<user_input>${escaped}</user_input>`;
}

export const customJsonFormatSupportOutput = (
  schema: z.ZodType,
  {
    injectJsonFormat,
    output,
  }: {
    injectJsonFormat?: boolean;
    output?: string;
  },
) =>
  [
    '严格输出符合 Schema 定义的 JSON 格式。枚举原样使用定义中的类型，不要翻译，不要输出任何其他内容，包括注释、解释、提示等。直接从 { 开始，到 } 结束, 不要输出任何其他内容。',
    injectJsonFormat
      ? `--- RESPONSE TypeScript Schema JSON FORMAT---\n${generateJsonFormat(schema)}\n--- END OF RESPONSE TYPE-SCRIPT SCHEMA JSON FORMAT ---`
      : '',
    output,
  ]
    .filter(Boolean)
    .join('\n');
