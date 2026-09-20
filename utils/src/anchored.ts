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
 * `Zone`（下面 `assertZone`/`assertViewerZone` 返回的品牌类型）是唯一被 `Anchored.*`/`.in()`
 * 接受的归属形状——裸字符串必须先经过它们中的一个，校验只发生这一次。
 *
 * @example 会议：东京 19:00，洛杉矶的同事看到的是同一时刻的当地墙上时间
 * ```ts
 * const tokyo = assertZone('Asia/Tokyo', 'instant');
 * const la = assertViewerZone('America/Los_Angeles');
 * const meeting = Anchored.instant(new Date('2026-09-21T10:00:00Z'), tokyo);
 * meeting.in(tokyo).at.toPlainTime().toString();      // '19:00:00'
 * meeting.in(la).at.toPlainDate().toString(); // '2026-09-21'
 * meeting.in(la).at.toPlainTime().toString(); // '03:00:00'
 * ```
 *
 * @example 全日：日期不随观察者改变，但要让渲染层知道它按谁的日历
 * ```ts
 * const holiday = Anchored.date('2026-09-21', tokyo);
 * holiday.in(la); // { date: 2026-09-21, ownZone: 'Asia/Tokyo', sameZone: false }
 * ```
 *
 * @example 循环钟点：floating 跟着人走，锚定时区不跟
 * ```ts
 * const floatingZone = assertZone(FLOATING, 'time');
 * const singapore = assertViewerZone('Asia/Singapore');
 * Anchored.time('07:00', floatingZone).in(singapore).ownZone;   // 'Asia/Singapore'
 * Anchored.time('07:00', tokyo).in(singapore).ownZone; // 'Asia/Tokyo'
 * ```
 */

/** 跟着观察者走。等价于 RFC 5545 §3.3.5 FORM #1 的 "floating"。 */
export const FLOATING = 'floating' as const;

declare const zoneBrand: unique symbol;
/**
 * 校验过的 IANA 时区名，或 `FLOATING`。
 *
 * 品牌类型——唯一构造者是 {@link assertZone}（观察者场景用 `assertViewerZone`，同一份规则）。
 * 一个裸 `string`（哪怕内容恰好是合法时区名）在类型层面不满足 `Zone`：这不是多此一举，是把
 * 「这个值有没有校验过」从注释里的约定变成 `tsc` 能查的事实——`Anchored.*`、`.in()` 等下游
 * 只收 `Zone`，不会在类型上放过一个从未校验的裸字符串。校验只在构造者那一处发生一次；下游不再
 * 重复校验（那会是运行时债，型别已经保证过一次）。
 *
 * 见 MIGRATIONS.md：这是一次破坏性变更——任何把裸字符串传给 `Zone` 参数的调用方都要先经
 * `assertZone`/`assertViewerZone`。
 */
export type Zone = string & { readonly [zoneBrand]: true };

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

/**
 * `fromJSON`'s actual input contract — distinct from {@link AnchoredJson} (which is `toJSON`'s
 * OUTPUT contract, where `zone` is always a validated `Zone`). Wire/JSON data from outside this
 * process carries no brand — `zone` is whatever the sender put there, checked at `fromJSON`
 * itself, same untrusted-boundary posture as `fromStored`. An `AnchoredJson` (e.g. from a prior
 * `toJSON()`) is always assignable here — `Zone` is a `string`, just a narrower one.
 */
export interface AnchoredJsonInput {
  readonly shape: string;
  readonly value: string;
  readonly zone: string | null | undefined;
}

export class Anchored {
  private constructor(
    readonly shape: AnchoredShape,
    readonly value: Temporal.ZonedDateTime | Temporal.PlainDate | Temporal.PlainTime,
    readonly zone: Zone,
  ) {}

  /** 某个绝对时刻。`zone` 是它「属于」的时区，与观察者无关。 */
  static instant(at: Date | Temporal.Instant, zone: Zone): Anchored {
    const instant = at instanceof Date ? Temporal.Instant.fromEpochMilliseconds(at.getTime()) : at;
    return new Anchored('instant', instant.toZonedDateTimeISO(zone), zone);
  }

  /** 一整个日历日。`zone` 决定这是谁的日历上的那一天。 */
  static date(date: Temporal.PlainDate | string, zone: Zone): Anchored {
    return new Anchored('date', Temporal.PlainDate.from(date), zone);
  }

  /** 一个钟点。`zone` 可以是 `FLOATING`，表示跟着人走。 */
  static time(time: Temporal.PlainTime | string, zone: Zone): Anchored {
    return new Anchored('time', Temporal.PlainTime.from(time), zone);
  }

  /**
   * 从持久化的两列（值 + 时区）读回。
   *
   * 归属为空即抛：这一步是坏数据唯一的拦截点。放过去之后，没有任何下游能分辨「东京的 7 点」和
   * 「某个没被记下来的地方的 7 点」。
   */
  static fromStored(
    value: Date | Temporal.Instant | Temporal.PlainDate | Temporal.PlainTime | string,
    zone: string | null | undefined,
    shape: AnchoredShape,
  ): Anchored {
    if (!zone) throw new Error(`Anchored: ${shape} 缺少归属；由应用层补齐后再构造`);
    // 唯一的校验点：`zone` 在这里是持久层给的裸字符串，从未经过任何构造者——本函数本身
    // 就是它的写入闸门 (`assertZone`)，不是转发给 `Anchored.instant/date/time` 去再查一次。
    const checked = assertZone(zone, shape);
    if (shape === 'instant') {
      if (!(value instanceof Date) && !(value instanceof Temporal.Instant))
        throw new Error('Anchored: instant 需要 Date 或 Temporal.Instant');
      return Anchored.instant(value, checked);
    }
    if (shape === 'date') {
      if (!(typeof value === 'string' || value instanceof Temporal.PlainDate))
        throw new Error('Anchored: date 需要字符串或 Temporal.PlainDate');
      return Anchored.date(value, checked);
    }
    if (!(typeof value === 'string' || value instanceof Temporal.PlainTime))
      throw new Error('Anchored: time 需要字符串或 Temporal.PlainTime');
    return Anchored.time(value, checked);
  }

  /**
   * 投影给看的人。`viewer` 不可省，也没有默认值，且必须已是 `Zone`——观察者场景校验一次的
   * 地方是 {@link assertViewerZone}（调用方的裸字符串输入进这里之前先过那道闸），本方法信任
   * 类型，不重复校验。
   */
  in(viewer: Zone): AnchoredProjection {
    if (this.shape === 'instant') {
      const own = this.value as Temporal.ZonedDateTime;
      return {
        shape: 'instant',
        at: own.withTimeZone(viewer),
        ownZone: this.zone,
        sameZone: sameZone(this.zone, viewer),
      };
    }
    if (this.shape === 'date') {
      // 日历日不随观察者位移：东京的 9 月 21 日在任何地方都叫 9 月 21 日，
      // 变的只是「要不要标注它按谁的日历」，那由 sameZone 交给渲染层判断。
      return {
        shape: 'date',
        date: this.value as Temporal.PlainDate,
        ownZone: this.zone,
        sameZone: sameZone(this.zone, viewer),
      };
    }
    const floating = this.zone === FLOATING;
    return {
      shape: 'time',
      time: this.value as Temporal.PlainTime,
      // floating 的归属在渲染那一刻才确定，就是看的人所在的时区。
      ownZone: floating ? viewer : this.zone,
      sameZone: floating || sameZone(this.zone, viewer),
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
  static fromJSON(json: AnchoredJsonInput): Anchored {
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
 * 拒绝裸偏移量（`+08:00`、`+8`）是有代价的，存量数据里通常确实有。但偏移量不是时区，差距有两层：
 *
 * **一、偏移量只说明某一刻，时区是从任意时刻到偏移的函数。** 给一个纽约用户存 `-05:00`，一月算出来
 * 的早上 9:00 是对的，七月同一条会落到 10:00——因为该时区七月的真实偏移是 `-04:00`。中间没有任何
 * 报错。任何循环的或指向未来的时间，用偏移量都会在夏令时切换那天静默错一小时。
 *
 * **二、偏移量里没有地区身份，所以它不能被机械地翻译成时区。** `+08:00` 可以是上海、新加坡、台北、
 * 吉隆坡、珀斯；`-05:00` 在一月是纽约/多伦多/波哥大/利马，在七月却是芝加哥/波哥大/利马——**候选集
 * 随记录日期变化**。因此 `+8 → Asia/Shanghai` 这类映射表从构造上就是错的。
 *
 * 由此得到迁移该怎么做：**输入不能是偏移量那一列**，只能是别处关于「这个人在哪」的证据——用户填的
 * 地址或国家、设备上报的 IANA 名、账号的 locale。偏移量在迁移里只有一个正当用途：**校验**——拿候选
 * 时区在那个时刻的真实偏移，跟存下来的偏移比对，对不上说明猜错了。它是检查器，不是数据源。
 *
 * 也因此建议保留原有的偏移量列：作为归属它是错的，作为「客户端当时声称了什么」的 provenance 它是对
 * 的，而且正是上面那步校验要用的东西。
 *
 * 还有一类值不是「缺时区」而是「本该没有时区」：如果那一列只是个过去的绝对时刻，从不需要还原当时当
 * 地的墙上时间，那它就该是 UTC instant 加渲染时传入的观察者时区，即本模块的 `instant` 形态。这类行
 * 的迁移是重新分类，不是补时区。
 *
 * 补不出来的就是坏数据，应当被标出来。本模块在这里抛错，是把一个在写入那一刻就已经错了的业务事实暴
 * 露出来，而不是替它猜一个看起来能渲染的答案。
 */
/**
 * 校验并规范化一个归属时区名。这是本模块内部构造时用的同一份判定，导出给写入闸门使用：
 * 应用层在落库前调它，和读出来构造 `Anchored` 时用的是同一条规则，不会出现「写得进去、读不出来」。
 *
 * `shape` 是调用方正在校验的形态（instant / date / time）——它决定 `FLOATING` 是否合法：
 * 只有钟点（time）能跟着人走，一个时刻或一个日期不能。规则留在这里，调用方只陈述形态。
 *
 * - 返回 Temporal 规范化后的 IANA 标识（`asia/tokyo` → `Asia/Tokyo`）。
 * - 空值、未知名、偏移量（`+08:00` / `+8`，以及规范化后以符号开头的任何写法）抛错。
 * - `FLOATING`：`shape === 'time'` 接受并原样返回，其它形态抛错。
 *
 */
export function assertZone(zone: string, shape: AnchoredShape): Zone {
  return checkZone(zone, shape, shape === 'time');
}

/**
 * 观察者时区的构造者——`.in()` 的 `viewer` 参数只收 `Zone`，裸字符串（用户请求头、设备上报）
 * 先经这里。只做 IANA 判定，永远不能是 floating（观察者是具体的人，不是一个跟着人走的钟点）；
 * 标签只进文案。
 */
export function assertViewerZone(viewer: string): Zone {
  return checkZone(viewer, 'viewer', false);
}

function checkZone(zone: string, shape: string, allowFloating: boolean): Zone {
  if (!zone) throw new Error(`Anchored: ${shape} 缺少归属`);
  if (zone === FLOATING) {
    if (!allowFloating) throw new Error(`Anchored: 只有 time 可以是 ${FLOATING}，收到 shape=${shape}`);
    return zone as Zone;
  }
  // 长得像偏移量的先拦下来给对的解释。Temporal 只认 +08:00 / +0800 这两种写法，"+8" 会被它当成
  // 未知标识——但对调用方来说问题不是「不认识」，是「偏移量不是归属」。
  if (/^[+-]\d/.test(zone)) throw new Error(`Anchored: 归属必须是 IANA 时区名，不能是偏移量，收到 "${zone}"`);
  // 让 Temporal 做唯一的校验，并拿回它规范化过的标识（大小写归一：asia/tokyo → Asia/Tokyo）。
  // 不再用正则预筛：正则会误拒 Japan、GB 这类没有斜杠的合法名，却放过 Foo/Bar。
  let canonical: string;
  try {
    canonical = REFERENCE_INSTANT.toZonedDateTimeISO(zone).timeZoneId;
  } catch (cause) {
    // 只有 RangeError 表示「不是合法的时区标识」。别的错误（例如运行时根本没有 Temporal）
    // 原样抛出，不冒充成坏时区——否则运维会去查 tzdata，而真正的原因是跑错了运行时。
    if (cause instanceof RangeError) throw new Error(`Anchored: 未知的 IANA 时区 "${zone}"`, { cause });
    throw cause;
  }
  // Temporal 本身接受 "+08:00" 这样的偏移时区，规范化后以符号开头。偏移量不是归属，理由见上。
  if (canonical.startsWith('+') || canonical.startsWith('-'))
    throw new Error(`Anchored: 归属必须是 IANA 时区名，不能是偏移量，收到 "${zone}"`);
  // 唯一的品牌构造点：走到这里说明 Temporal 认可这是合法 IANA 标识（或上面已放行的 FLOATING）。
  return canonical as Zone;
}

/** 任意一个固定时刻即可：时区相等比较的是标识身份，不是那一刻的偏移。 */
const REFERENCE_INSTANT = Temporal.Instant.fromEpochMilliseconds(0);

/**
 * 同一个时区的两种拼法算同一个。
 *
 * 字符串相等做不到：Asia/Calcutta 与 Asia/Kolkata 是同一时区的新旧名，`timeZoneId` 会保留调用方
 * 给的拼写而不解析别名；只有 Temporal 的相等比较会把两边都解析到主标识再比。迁移时新旧名
 * 混存是常态，靠字符串比就会给同一时区的观察者多标一个时区后缀。
 */
function sameZone(a: Zone, b: Zone): boolean {
  return REFERENCE_INSTANT.toZonedDateTimeISO(a).equals(REFERENCE_INSTANT.toZonedDateTimeISO(b));
}
