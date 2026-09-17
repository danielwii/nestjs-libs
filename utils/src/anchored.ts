/**
 * 带归属的时间。
 *
 * 一个时间值离开创建它的地方之后，「它属于哪个时区」必须跟着一起走。缺了它，下游只能任选一个
 * 时区来渲染，选错了也没有信号。这类缺陷有固定的三种形状：
 *
 *   1. 跨时区的区间被按单一时区展开，时长凭空变长或变短；
 *   2. 「今天」按服务器或某个默认时区计算，跨时区的接收方看到错误的一天；
 *   3. 历史数据没有记下时区，之后照常渲染，错误无声。
 *
 * 规则一条：**没有归属的时间值不存在。** 构造时归属必须给出，给不出就抛错，由应用层先补。
 * 本模块不吸收债务——存储里归属为空的行是坏数据，业务在写入那一刻就已经错了，类型不替它掩盖。
 *
 * 形态从「渲染出来长什么样」倒推，只有三种：
 *
 *   instant   今晚 7:00 PM        会议、航班、约定——某个绝对时刻
 *   date      9 月 21 日 全天      节日、假期、生日——一整个日历日
 *   time      每天早上 7:00        循环的钟点——服药、晨跑、例行提醒
 *
 * 归属只有两种取值：IANA 时区名，或 `FLOATING`。`FLOATING` 取自 RFC 5545 的原词，意为「不绑定
 * 任何特定时区」——每天早上 7 点的提醒，人到了哪个时区就是哪个时区的 7 点。它必须显式写出来而
 * 不能靠留空表示：iCalendar 用「没有 TZID」表示 floating，这里不能照搬，因为空值已经被坏数据
 * 占用。留空是事故，floating 是决定，两者必须长得不一样。
 *
 * 渲染必须知道观察者在哪，所以 `in()` 的参数没有默认值：同一个落地时刻，出发地的人看是下午，
 * 目的地的人看可能已是次日凌晨。`in()` 返回结构而不是字符串——文案属于渲染层，本模块不替它决定
 * 「什么时候该标注时区」。
 *
 * @example 会议：东京 19:00，洛杉矶的同事看到的是同一时刻的当地墙上时间
 * ```ts
 * const meeting = Anchored.instant(new Date('2026-09-21T10:00:00Z'), 'Asia/Tokyo');
 * meeting.in('Asia/Tokyo').at.toPlainTime().toString();      // '19:00:00'
 * meeting.in('America/Los_Angeles').at.toPlainDate().toString(); // '2026-09-21'
 * meeting.in('America/Los_Angeles').at.toPlainTime().toString(); // '03:00:00'
 * ```
 *
 * @example 全日：日期不随观察者改变，但要让渲染层知道它按谁的日历
 * ```ts
 * const holiday = Anchored.date('2026-09-21', 'Asia/Tokyo');
 * holiday.in('America/Los_Angeles'); // { date: 2026-09-21, ownZone: 'Asia/Tokyo', sameZone: false }
 * ```
 *
 * @example 循环钟点：floating 跟着人走，锚定时区不跟
 * ```ts
 * Anchored.time('07:00', FLOATING).in('Asia/Singapore').ownZone;   // 'Asia/Singapore'
 * Anchored.time('07:00', 'Asia/Tokyo').in('Asia/Singapore').ownZone; // 'Asia/Tokyo'
 * ```
 */
import { Temporal } from '@js-temporal/polyfill';

/** 跟着观察者走。等价于 RFC 5545 §3.3.5 FORM #1 的 "floating"。 */
export const FLOATING = 'floating' as const;

/** IANA 时区名，或 `FLOATING`。空字符串与 undefined 都不是合法值。 */
export type Zone = string;

export type AnchoredShape = 'instant' | 'date' | 'time';

export type AnchoredProjection =
  | { shape: 'instant'; at: Temporal.ZonedDateTime; ownZone: Zone; sameZone: boolean }
  | { shape: 'date'; date: Temporal.PlainDate; ownZone: Zone; sameZone: boolean }
  | { shape: 'time'; time: Temporal.PlainTime; ownZone: Zone; sameZone: boolean };

export interface AnchoredJson {
  readonly shape: AnchoredShape;
  readonly value: string;
  readonly zone: Zone;
}

export class Anchored {
  private constructor(
    readonly shape: AnchoredShape,
    readonly value: Temporal.ZonedDateTime | Temporal.PlainDate | Temporal.PlainTime,
    readonly zone: Zone,
  ) {}

  /** 某个绝对时刻。`zone` 是它「属于」的时区，与观察者无关。 */
  static instant(at: Date | Temporal.Instant, zone: Zone): Anchored {
    const checked = assertZone(zone, 'instant');
    const instant = at instanceof Date ? Temporal.Instant.fromEpochMilliseconds(at.getTime()) : at;
    return new Anchored('instant', instant.toZonedDateTimeISO(checked), checked);
  }

  /** 一整个日历日。`zone` 决定这是谁的日历上的那一天。 */
  static date(date: Temporal.PlainDate | string, zone: Zone): Anchored {
    return new Anchored('date', Temporal.PlainDate.from(date), assertZone(zone, 'date'));
  }

  /** 一个钟点。`zone` 可以是 `FLOATING`，表示跟着人走。 */
  static time(time: Temporal.PlainTime | string, zone: Zone): Anchored {
    return new Anchored('time', Temporal.PlainTime.from(time), assertZone(zone, 'time'));
  }

  /**
   * 从持久化的两列（值 + 时区）读回。
   *
   * 归属为空即抛：这一步是坏数据唯一的拦截点。放过去之后，没有任何下游能分辨「东京的 7 点」和
   * 「某个没被记下来的地方的 7 点」。
   */
  static fromStored(
    value: Date | Temporal.Instant | Temporal.PlainDate | Temporal.PlainTime | string,
    zone: Zone | null | undefined,
    shape: AnchoredShape,
  ): Anchored {
    if (!zone) throw new Error(`Anchored: ${shape} 缺少归属；由应用层补齐后再构造`);
    if (shape === 'instant') {
      if (!(value instanceof Date) && !(value instanceof Temporal.Instant))
        throw new Error('Anchored: instant 需要 Date 或 Temporal.Instant');
      return Anchored.instant(value, zone);
    }
    if (shape === 'date') {
      if (!(typeof value === 'string' || value instanceof Temporal.PlainDate))
        throw new Error('Anchored: date 需要字符串或 Temporal.PlainDate');
      return Anchored.date(value, zone);
    }
    if (!(typeof value === 'string' || value instanceof Temporal.PlainTime))
      throw new Error('Anchored: time 需要字符串或 Temporal.PlainTime');
    return Anchored.time(value, zone);
  }

  /** 投影给看的人。`viewer` 不可省，也没有默认值。 */
  in(viewer: Zone): AnchoredProjection {
    const checked = assertZone(viewer, 'viewer', { allowFloating: false });
    if (this.shape === 'instant') {
      const own = this.value as Temporal.ZonedDateTime;
      return { shape: 'instant', at: own.withTimeZone(checked), ownZone: this.zone, sameZone: this.zone === checked };
    }
    if (this.shape === 'date') {
      // 日历日不随观察者位移：东京的 9 月 21 日在任何地方都叫 9 月 21 日，
      // 变的只是「要不要标注它按谁的日历」，那由 sameZone 交给渲染层判断。
      return {
        shape: 'date',
        date: this.value as Temporal.PlainDate,
        ownZone: this.zone,
        sameZone: this.zone === checked,
      };
    }
    const floating = this.zone === FLOATING;
    return {
      shape: 'time',
      time: this.value as Temporal.PlainTime,
      // floating 的归属在渲染那一刻才确定，就是看的人所在的时区。
      ownZone: floating ? checked : this.zone,
      sameZone: floating || this.zone === checked,
    };
  }

  /**
   * `instant` 走 RFC 9557（IXDTF），时区名在方括号里，是可往返的标准串。
   *
   * `date` 与 `time` 没有「把归属塞进单串」的标准——RFC 5545 也是参数与值分开
   * （`TZID=America/New_York:19980119T020000`）。这里的方括号写法只用于日志与人读场景，
   * 跨进程传输请用 {@link toJSON}：`Temporal.PlainDate.from('2026-09-21[Asia/Tokyo]')` 会把
   * 后缀无声吃掉，而 `ZonedDateTime.from` 会擅自补零点，把「一天」变成「一刻」。
   */
  toString(): string {
    return this.shape === 'instant' ? this.value.toString() : `${this.value.toString()}[${this.zone}]`;
  }

  toJSON(): AnchoredJson {
    return { shape: this.shape, value: this.value.toString(), zone: this.zone };
  }

  /** 线上传来的坏数据与存储里的坏数据受同一道约束。 */
  static fromJSON(json: AnchoredJson): Anchored {
    // 声明类型说 shape 只有三种，但 JSON 来自进程外，运行时未必守约，所以这里按 string 判。
    const shape: string = json.shape;
    if (shape === 'instant') {
      if (!json.zone) throw new Error('Anchored: instant 缺少归属');
      return new Anchored('instant', Temporal.ZonedDateTime.from(json.value), assertZone(json.zone, 'instant'));
    }
    if (shape === 'date' || shape === 'time') return Anchored.fromStored(json.value, json.zone, shape);
    throw new Error(`Anchored: 未知形态 "${shape}"`);
  }
}

/**
 * 唯一的守门人。
 *
 * 拒绝裸偏移量（`+08:00`）是有代价的，存量数据里通常确实有；但偏移量不是时区：同一个时区在夏令时
 * 前后是两个不同的偏移，拿偏移去算跨季节的墙上时间会静默差一小时。要用偏移量，先在应用层翻译成
 * IANA 名，翻译不了就说明归属本来就不明确。
 */
function assertZone(zone: Zone, shape: string, options: { allowFloating?: boolean } = {}): Zone {
  const allowFloating = options.allowFloating ?? shape === 'time';
  if (!zone) throw new Error(`Anchored: ${shape} 缺少归属`);
  if (zone === FLOATING) {
    if (!allowFloating) throw new Error(`Anchored: 只有 time 可以是 ${FLOATING}，收到 shape=${shape}`);
    return zone;
  }
  if (zone === 'UTC' || zone === 'GMT') return zone;
  if (!/^[A-Za-z][A-Za-z0-9_+-]*\/[A-Za-z0-9_+\-/]+$/.test(zone))
    throw new Error(`Anchored: 归属必须是 IANA 时区名，收到 "${zone}"`);
  try {
    Temporal.Now.instant().toZonedDateTimeISO(zone);
  } catch {
    throw new Error(`Anchored: 未知的 IANA 时区 "${zone}"`);
  }
  return zone;
}
