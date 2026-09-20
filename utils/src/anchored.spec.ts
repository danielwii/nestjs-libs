import { Anchored, assertViewerZone, assertZone, FLOATING } from './anchored';

import { describe, expect, it } from 'bun:test';

// tz-d7 (Zone 品牌化) — 品牌类型唯一的构造者是 assertZone/assertViewerZone；下面这些常量是
// 本文件所有测试共用的、已校验过的 Zone 值。构造/投影方法（Anchored.instant/date/time、.in()）
// 不再接受裸字符串，也不再自己二次校验——校验只在这里发生一次。真实 IANA 名对哪个 shape 校验
// 结果都一样（shape 只影响 FLOATING 是否放行），所以一套常量可以喂给所有形态。
const TOKYO = assertZone('Asia/Tokyo', 'instant');
const LA = assertZone('America/Los_Angeles', 'instant');
const SINGAPORE = assertZone('Asia/Singapore', 'instant');
const CALCUTTA = assertZone('Asia/Calcutta', 'instant');
const KOLKATA = assertZone('Asia/Kolkata', 'instant');
const SHANGHAI = assertZone('Asia/Shanghai', 'instant');
const KIRITIMATI = assertZone('Pacific/Kiritimati', 'instant');
const UTC = assertZone('UTC', 'instant');
const GMT = assertZone('GMT', 'instant');
const JAPAN = assertZone('Japan', 'instant');
const GB = assertZone('GB', 'instant');
const FLOATING_ZONE = assertZone(FLOATING, 'time');

/**
 * Anchored 测试
 *
 * 设计意图：
 * - 归属缺失必须在构造处失败，而不是在渲染处静默选一个时区
 * - 三种形态对「观察者是谁」的反应各不相同，逐一钉死
 * - 序列化必须可往返，且 floating 与锚定时区不能在往返中互相变形
 */
describe('Anchored', () => {
  describe('instant：绝对时刻，随观察者改变墙上时间', () => {
    // 2026-09-21T10:00:00Z = 东京 19:00 / 洛杉矶 03:00 / 新加坡 18:00
    const meeting = Anchored.instant(new Date('2026-09-21T10:00:00Z'), TOKYO);

    it('归属时区的观察者看到归属时区的墙上时间', () => {
      const view = meeting.in(TOKYO);
      expect(view.shape).toBe('instant');
      if (view.shape !== 'instant') throw new Error('unreachable');
      expect(view.at.toPlainTime().toString()).toBe('19:00:00');
      expect(view.at.toPlainDate().toString()).toBe('2026-09-21');
      expect(view.sameZone).toBe(true);
    });

    it('其他时区的观察者看到同一时刻的当地墙上时间', () => {
      const la = meeting.in(LA);
      if (la.shape !== 'instant') throw new Error('unreachable');
      expect(la.at.toPlainTime().toString()).toBe('03:00:00');
      expect(la.sameZone).toBe(false);
      expect(la.ownZone).toBe(TOKYO);

      const sg = meeting.in(SINGAPORE);
      if (sg.shape !== 'instant') throw new Error('unreachable');
      expect(sg.at.toPlainTime().toString()).toBe('18:00:00');
    });

    it('投影不改变绝对时刻', () => {
      const tokyo = meeting.in(TOKYO);
      const la = meeting.in(LA);
      if (tokyo.shape !== 'instant' || la.shape !== 'instant') throw new Error('unreachable');
      expect(tokyo.at.epochMilliseconds).toBe(la.at.epochMilliseconds);
    });

    it('跨时区区间：两端各自带归属，时长不被单一时区的展开扭曲', () => {
      // 起飞 2026-09-23T17:10Z（东京 9/24 02:10），落地 5 小时后
      const depart = Anchored.instant(new Date('2026-09-23T17:10:00Z'), TOKYO);
      const arrive = Anchored.instant(new Date('2026-09-23T22:10:00Z'), LA);

      const departLa = depart.in(LA);
      const arriveLa = arrive.in(LA);
      if (departLa.shape !== 'instant' || arriveLa.shape !== 'instant') throw new Error('unreachable');

      // 同一个观察者看两端：起飞 9/23 10:10，落地 9/23 15:10，跨度仍是 5 小时
      expect(departLa.at.toPlainTime().toString()).toBe('10:10:00');
      expect(arriveLa.at.toPlainTime().toString()).toBe('15:10:00');
      expect(arriveLa.at.epochMilliseconds - departLa.at.epochMilliseconds).toBe(5 * 3600_000);
    });

    it('接受 Temporal.Instant 与 Date 两种输入', () => {
      const fromDate = Anchored.instant(new Date('2026-09-21T10:00:00Z'), UTC);
      const fromInstant = Anchored.instant(Temporal.Instant.from('2026-09-21T10:00:00Z'), UTC);
      expect(fromDate.toString()).toBe(fromInstant.toString());
    });
  });

  describe('date：日历日，不随观察者位移', () => {
    const holiday = Anchored.date('2026-09-21', TOKYO);

    it('任何观察者看到的都是同一个日期', () => {
      for (const viewer of [TOKYO, LA, KIRITIMATI]) {
        const view = holiday.in(viewer);
        if (view.shape !== 'date') throw new Error('unreachable');
        expect(view.date.toString()).toBe('2026-09-21');
      }
    });

    it('观察者不在归属时区时 sameZone 为 false，供渲染层决定是否标注', () => {
      expect(holiday.in(TOKYO).sameZone).toBe(true);
      expect(holiday.in(LA).sameZone).toBe(false);
      expect(holiday.in(LA).ownZone).toBe(TOKYO);
    });

    it('接受 Temporal.PlainDate 与字符串两种输入', () => {
      const a = Anchored.date(Temporal.PlainDate.from('2026-09-21'), TOKYO);
      const b = Anchored.date('2026-09-21', TOKYO);
      expect(a.toString()).toBe(b.toString());
    });
  });

  describe('time：钟点，floating 跟着人走', () => {
    it('floating 的归属在渲染时才确定，就是观察者所在时区', () => {
      const reminder = Anchored.time('07:00', FLOATING_ZONE);

      const sg = reminder.in(SINGAPORE);
      if (sg.shape !== 'time') throw new Error('unreachable');
      expect(sg.time.toString()).toBe('07:00:00');
      expect(sg.ownZone).toBe(SINGAPORE);
      expect(sg.sameZone).toBe(true);

      const tokyo = reminder.in(TOKYO);
      expect(tokyo.ownZone).toBe(TOKYO);
      expect(tokyo.sameZone).toBe(true);
    });

    it('锚定时区的钟点不跟着人走，归属始终是原时区', () => {
      const officeHours = Anchored.time('07:00', TOKYO);

      expect(officeHours.in(TOKYO).sameZone).toBe(true);
      const sg = officeHours.in(SINGAPORE);
      expect(sg.ownZone).toBe(TOKYO);
      expect(sg.sameZone).toBe(false);
    });

    it('同一个观察者下，floating 与锚定时区给出不同结果', () => {
      const floating = Anchored.time('07:00', FLOATING_ZONE).in(SINGAPORE);
      const anchored = Anchored.time('07:00', TOKYO).in(SINGAPORE);
      expect(floating.ownZone).not.toBe(anchored.ownZone);
      expect(floating.sameZone).not.toBe(anchored.sameZone);
    });

    it('观察者本身不能是 floating：渲染必须发生在某个具体时区', () => {
      // `.in()` 现在只收已校验的 `Zone`，本身不再二次判定——floating-观察者的拒绝发生在
      // `assertViewerZone`（.in() 的调用方在拿到 Zone 之前必经的闸门），不是 `.in()` 内部。
      expect(() => assertViewerZone(FLOATING)).toThrow(/只有 time 可以是 floating/);
    });
  });

  describe('归属缺失：在构造处失败，不进入渲染', () => {
    it('空归属在写入闸门（assertZone）处失败——Anchored.instant/date/time 不再自己校验', () => {
      expect(() => assertZone('', 'instant')).toThrow(/缺少归属/);
      expect(() => assertZone('', 'date')).toThrow(/缺少归属/);
      expect(() => assertZone('', 'time')).toThrow(/缺少归属/);
    });

    it('fromStored 对 null / undefined 归属抛错，指明由应用层补齐', () => {
      expect(() => Anchored.fromStored(new Date(), null, 'instant')).toThrow(/缺少归属/);
      expect(() => Anchored.fromStored(new Date(), null, 'instant')).toThrow(/应用层补齐/);
      expect(() => Anchored.fromStored('2026-09-21', undefined, 'date')).toThrow(/缺少归属/);
      expect(() => Anchored.fromStored('07:00', '', 'time')).toThrow(/缺少归属/);
    });

    it('fromStored 归属齐备时正常构造', () => {
      const stored = Anchored.fromStored(new Date('2026-09-21T10:00:00Z'), 'Asia/Tokyo', 'instant');
      const view = stored.in(TOKYO);
      if (view.shape !== 'instant') throw new Error('unreachable');
      expect(view.at.toPlainTime().toString()).toBe('19:00:00');
    });

    it('fromStored 拒绝与形态不匹配的值', () => {
      expect(() => Anchored.fromStored('2026-09-21T10:00:00Z', 'Asia/Tokyo', 'instant')).toThrow(/需要 Date/);
      expect(() => Anchored.fromStored(new Date(), 'Asia/Tokyo', 'date')).toThrow(/需要字符串/);
    });
  });

  describe('归属身份：别名、大小写、同偏移不同身份', () => {
    const d = new Date('2026-09-21T10:00:00Z');

    it('同一时区的新旧名算同一个：Asia/Calcutta 与 Asia/Kolkata', () => {
      expect(Anchored.instant(d, CALCUTTA).in(KOLKATA).sameZone).toBe(true);
      expect(Anchored.date('2026-09-21', KOLKATA).in(CALCUTTA).sameZone).toBe(true);
    });

    it('大小写归一：asia/tokyo 的归属记为 Asia/Tokyo（归一化发生在 assertZone 本身）', () => {
      const v = Anchored.instant(d, assertZone('asia/tokyo', 'instant')).in(TOKYO);
      expect(v.ownZone).toBe(TOKYO);
      expect(v.sameZone).toBe(true);
      expect(Anchored.instant(d, assertZone('utc', 'instant')).zone).toBe(UTC);
    });

    it('同一偏移不等于同一时区：Asia/Shanghai 与 Asia/Singapore 此刻都是 +08:00，仍是两个归属', () => {
      expect(Anchored.instant(d, SHANGHAI).in(SINGAPORE).sameZone).toBe(false);
    });

    it('没有斜杠的合法 IANA 名也接受：Japan、GB', () => {
      expect(Anchored.instant(d, JAPAN).zone).toBe(JAPAN);
      expect(Anchored.date('2026-09-21', GB).zone).toBe(GB);
    });
  });

  describe('assertZone：唯一的写入闸门——构造与投影信任它一次性给出的结果', () => {
    it('合法名返回规范化标识', () => {
      expect(assertZone('asia/tokyo', 'instant')).toBe(TOKYO);
      expect(assertZone('UTC', 'date')).toBe(UTC);
      expect(assertZone('GMT', 'instant')).toBe(GMT);
    });

    it('偏移量、未知名、空值都在闸门处抛错', () => {
      // 同一时区在夏令时前后是两个偏移，用偏移量算墙上时间会在切换那天静默差一小时——
      // 见文件头注释；这里钉死三种偏移写法都被拒绝，不只是最常见的 "+08:00"。
      expect(() => assertZone('+08:00', 'instant')).toThrow(/必须是 IANA 时区名/);
      expect(() => assertZone('+8', 'instant')).toThrow(/必须是 IANA 时区名/);
      // Temporal 自己接受 +0800 并规范化成 +08:00；拒绝要看规范化之后的结果。
      expect(() => assertZone('+0800', 'instant')).toThrow(/不能是偏移量/);
      expect(() => assertZone('Asia/Atlantis', 'date')).toThrow(/未知的 IANA 时区/);
      expect(() => assertZone('', 'instant')).toThrow(/instant 缺少归属/);
    });

    it('floating 由形态决定：只有 time 接受，时刻与日期拒绝', () => {
      expect(assertZone(FLOATING, 'time')).toBe(FLOATING_ZONE);
      expect(() => assertZone(FLOATING, 'instant')).toThrow(/只有 time 可以是/);
      expect(() => assertZone(FLOATING, 'date')).toThrow(/只有 time 可以是/);
    });

    it(
      '构造方法信任品牌、不重复判定 shape 是否允许 floating——一个为 time 校验出的 Zone 若被' +
        '误用于 date/instant 不会在这里被拦下，那道拒绝已经在 assertZone(zone, 该 shape) 那一步' +
        '发生过一次；这不是漏洞，是「校验只在构造者那一处发生一次」这个设计选择的直接后果',
      () => {
        const misusedFloatingZone = FLOATING_ZONE; // 为 'time' 校验得到，非 'date'/'instant'
        expect(() => Anchored.date('2026-09-21', misusedFloatingZone)).not.toThrow();
      },
    );
  });

  describe('序列化：可往返，且归属不在往返中丢失', () => {
    it('instant 的 toString 是 RFC 9557（IXDTF），时区名在方括号内', () => {
      const at = Anchored.instant(new Date('2026-09-21T10:00:00Z'), TOKYO);
      expect(at.toString()).toBe('2026-09-21T19:00:00+09:00[Asia/Tokyo]');
    });

    it('date / time 的 toString 供人读，归属以方括号附在后面', () => {
      expect(Anchored.date('2026-09-21', TOKYO).toString()).toBe('2026-09-21[Asia/Tokyo]');
      expect(Anchored.time('07:00', FLOATING_ZONE).toString()).toBe('07:00:00[floating]');
    });

    it('三种形态都能 JSON 往返', () => {
      const cases = [
        Anchored.instant(new Date('2026-09-21T10:00:00Z'), TOKYO),
        Anchored.date('2026-09-21', LA),
        Anchored.time('07:00', SINGAPORE),
        Anchored.time('07:00', FLOATING_ZONE),
      ];
      for (const original of cases) {
        const restored = Anchored.fromJSON(JSON.parse(JSON.stringify(original)));
        expect(restored.shape).toBe(original.shape);
        expect(restored.zone).toBe(original.zone);
        expect(restored.toString()).toBe(original.toString());
      }
    });

    it('往返后 floating 仍是 floating，不被折叠成某个具体时区', () => {
      const restored = Anchored.fromJSON(Anchored.time('07:00', FLOATING_ZONE).toJSON());
      expect(restored.zone).toBe(FLOATING_ZONE);
      expect(restored.in(TOKYO).ownZone).toBe(TOKYO);
      expect(restored.in(LA).ownZone).toBe(LA);
    });

    it('fromJSON 对缺归属或未知形态抛错', () => {
      expect(() =>
        Anchored.fromJSON({ shape: 'instant', value: '2026-09-21T19:00:00+09:00[Asia/Tokyo]', zone: '' }),
      ).toThrow(/缺少归属/);
      expect(() => Anchored.fromJSON({ shape: 'date', value: '2026-09-21', zone: '' })).toThrow(/缺少归属/);
      expect(() => Anchored.fromJSON({ shape: 'duration' as never, value: 'PT1H', zone: 'UTC' })).toThrow(/未知形态/);
    });
  });

  describe('类型层：一个裸字符串不满足 Zone（tz-d7 compile-time 断言）', () => {
    it('未经 assertZone/assertViewerZone 的裸字符串不能喂给构造者或 .in()', () => {
      // @ts-expect-error a bare string literal, even a valid IANA name, is not a `Zone` — only
      // `assertZone`/`assertViewerZone` can produce one. Catches "forgot to validate" at compile
      // time instead of letting an unchecked string reach Anchored's write boundary.
      Anchored.instant(new Date(), 'Asia/Tokyo');
      // @ts-expect-error same rule for the observer side of a projection.
      Anchored.time('07:00', FLOATING_ZONE).in('Asia/Tokyo');
    });
  });
});
