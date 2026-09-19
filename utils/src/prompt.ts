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
 * Temporal formatting patterns（不含 dayPeriod 和时区，由 projectLocalTime 拼接）。
 *
 * dayPeriod 通过 Intl toLocaleString({ dayPeriod: 'long' }) 获取（"in the morning" 等）。
 */
export enum TimeSensitivity {
  Day = 'yyyy-MM-dd EEEE',
  Hour = 'yyyy-MM-dd EEEE hh a',
  Minute = 'yyyy-MM-dd EEEE HH:mm',
}

export type PromptDateTime = string | Temporal.Instant | Temporal.ZonedDateTime;
/** `projectLocalTime` 的输入：一个绝对时刻（`PromptDateTime`），或一整个日历日（`Temporal.PlainDate`）。 */
export type LocalTimeValue = PromptDateTime | Temporal.PlainDate;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/**
 * 给模型看的单个时间点。`text` 是唯一能直接拼进 prompt 的一行；其余字段是同一次投影的结构化
 * 结果，供需要单独判断形状/归属的消费者用（裁判状态、跨区标注），不必重新解析 `text`。
 *
 * `dayPeriod` 只有 `shape === 'instant'` 才有——日历日没有确定的时段。`ownZone`/`sameZone`/
 * `ownText` 描述"这个值本来属于谁"跟"现在给谁看"是否一致：`projectLocalTime` 不传 `ownZone`
 * 时两者是同一个值（`formatLocalDateTime`/Now 行走的就是这条路径，恒为同区）；传了不同的
 * `ownZone`（例如别人时区的事件）时才会出现 `sameZone: false` 与 `ownText`。
 */
export interface ModelTime {
  text: string;
  shape: 'instant' | 'date';
  zone: Zone;
  ownZone: Zone;
  sameZone: boolean;
  ownText?: string;
  weekday: string;
  dayPeriod?: string;
}

/** 一段起止时间给模型看的样子，语义同 {@link ModelTime}，`text` 换成一段而非一个点。 */
export interface ModelSpan {
  text: string;
  shape: 'instant';
  zone: Zone;
  ownZone: Zone;
  sameZone: boolean;
  ownText?: string;
}

function toInstant(dateOrIso?: PromptDateTime | null): Temporal.Instant {
  if (!dateOrIso) return Temporal.Now.instant();
  if (dateOrIso instanceof Temporal.ZonedDateTime) return dateOrIso.toInstant();
  return typeof dateOrIso === 'string' ? Temporal.Instant.from(dateOrIso) : dateOrIso;
}

/**
 * 构造 + 投影一个 instant，各只走一次：校验交给 `Anchored`（`assertZone`），换算交给
 * `Anchored.in()`，这里不重新判定时区合法性。`ownZone` 与 `observerZone` 相同时（`zonedAt`、
 * `projectLocalTime` 的默认路径）这一步是恒等投影，只是复用同一实现，不是特别绕路。
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
function renderLocalMoment(zdt: Temporal.ZonedDateTime, sensitivity: TimeSensitivity, dayPeriod: string): string {
  return `${formatTemporal(zdt, sensitivity)} ${dayPeriod}`;
}

/**
 * 给模型看的时间投影：本模块**唯一**的校验 + 投影 + 渲染实现，其余导出函数都是它的薄壳。
 *
 * - `value` 是 instant（会议、"现在"）或 `Temporal.PlainDate`（生日、假期这类全天日期）。
 * - `observer` 是看这段文字的人所在的时区，必填——没有默认值，缺省或非法直接抛错
 *   （`Anchored`/`assertZone` 的协议），不会像以前那样悄悄落回 `process.env.TZ`。
 * - `ownZone` 省略时等于 `observer`（值本来就是"观察者自己的现在"，如 Now 行），
 *   传入时表示这个值实际归属另一个时区（例如别人时区的事件），会产生 `sameZone: false`
 *   与 `ownText`（这件事在归属方自己时区里读起来是几点/哪一天）。
 *
 * `text` 对 instant 保留一直以来的 Now 行措辞——星期 + 钟点 + 时段短语 + 时区，例如
 * `2026-03-21 Saturday 04:20 in the morning (Asia/Tokyo)`——这不是装饰：模型曾经常忽略
 * 当前时间说出不合时宜的话，把"现在"写成人话是让它注意到时间的手段，不只是给一个可解析的
 * 时间戳。对 date，`text` 就是日期本身（`2026-09-20`），不随观察者位移。
 */
export function projectLocalTime(
  value: LocalTimeValue | null | undefined,
  observer: Zone,
  ownZone?: Zone,
  sensitivity: TimeSensitivity = TimeSensitivity.Minute,
): ModelTime {
  const observerZone = assertZone(observer, 'instant');
  const attribution = ownZone ? assertZone(ownZone, 'instant') : observerZone;

  if (value instanceof Temporal.PlainDate) {
    const projection = Anchored.date(value, attribution).in(observerZone) as Extract<
      AnchoredProjection,
      { shape: 'date' }
    >;
    const result: ModelTime = {
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
  const text = `${renderLocalMoment(zdt, sensitivity, dayPeriod)} (${formatZoneName(zdt)})`;
  const result: ModelTime = {
    text,
    shape: 'instant',
    zone: observerZone,
    ownZone: projection.ownZone,
    sameZone: projection.sameZone,
    weekday: weekdayOf(zdt.dayOfWeek),
    dayPeriod,
  };
  if (!projection.sameZone) {
    const ownClock = plainTimeToClock(zdt.withTimeZone(projection.ownZone).toPlainTime());
    result.ownText = `${ownClock} (${projection.ownZone})`;
  }
  return result;
}

export function formatLocalDateTime(
  dateOrIso?: PromptDateTime | null,
  sensitivity: TimeSensitivity = TimeSensitivity.Minute,
  timezone?: string | null,
): string {
  return projectLocalTime(dateOrIso, timezone ?? '', undefined, sensitivity).text;
}

/**
 * 一段起止时间给模型看的样子：`2026-09-23 15:00–16:00 (Asia/Taipei)`，本地跨日则
 * `2026-09-23 23:30 → 2026-09-24 00:30 (Asia/Taipei)`。
 *
 * 只覆盖 instant 起止（会议、事件的开始/结束）——全天多日区间还没有消费者要求过这个函数
 * 产出，出现时再加，不先猜格式。
 */
export function formatLocalSpan(start: PromptDateTime, end: PromptDateTime, observer: Zone): ModelSpan {
  const observerZone = assertZone(observer, 'instant');
  const startZdt = projectInstant(start, observerZone, observerZone).at;
  const endZdt = projectInstant(end, observerZone, observerZone).at;
  const sameDay = startZdt.toPlainDate().equals(endZdt.toPlainDate());
  const zoneLabel = formatZoneName(startZdt);
  const startClock = plainTimeToClock(startZdt.toPlainTime());
  const endClock = plainTimeToClock(endZdt.toPlainTime());
  const text = sameDay
    ? `${startZdt.toPlainDate().toString()} ${startClock}–${endClock} (${zoneLabel})`
    : `${startZdt.toPlainDate().toString()} ${startClock} → ${endZdt.toPlainDate().toString()} ${endClock} (${zoneLabel})`;
  return {
    text,
    shape: 'instant',
    zone: observerZone,
    ownZone: observerZone,
    sameZone: true,
  };
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
  // A fixed-instant API must never silently become the current clock: reject blank inputs here.
  if (typeof at === 'string' && at.trim() === '') throw new TypeError('zonedAt: empty timestamp');
  const observerZone = assertZone(timezone ?? '', 'instant');
  return projectInstant(at, observerZone, observerZone).at;
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
