import { Anchored, FLOATING } from './anchored';

import { describe, expect, it } from 'bun:test';

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
    const meeting = Anchored.instant(new Date('2026-09-21T10:00:00Z'), 'Asia/Tokyo');

    it('归属时区的观察者看到归属时区的墙上时间', () => {
      const view = meeting.in('Asia/Tokyo');
      expect(view.shape).toBe('instant');
      if (view.shape !== 'instant') throw new Error('unreachable');
      expect(view.at.toPlainTime().toString()).toBe('19:00:00');
      expect(view.at.toPlainDate().toString()).toBe('2026-09-21');
      expect(view.sameZone).toBe(true);
    });

    it('其他时区的观察者看到同一时刻的当地墙上时间', () => {
      const la = meeting.in('America/Los_Angeles');
      if (la.shape !== 'instant') throw new Error('unreachable');
      expect(la.at.toPlainTime().toString()).toBe('03:00:00');
      expect(la.sameZone).toBe(false);
      expect(la.ownZone).toBe('Asia/Tokyo');

      const sg = meeting.in('Asia/Singapore');
      if (sg.shape !== 'instant') throw new Error('unreachable');
      expect(sg.at.toPlainTime().toString()).toBe('18:00:00');
    });

    it('投影不改变绝对时刻', () => {
      const tokyo = meeting.in('Asia/Tokyo');
      const la = meeting.in('America/Los_Angeles');
      if (tokyo.shape !== 'instant' || la.shape !== 'instant') throw new Error('unreachable');
      expect(tokyo.at.epochMilliseconds).toBe(la.at.epochMilliseconds);
    });

    it('跨时区区间：两端各自带归属，时长不被单一时区的展开扭曲', () => {
      // 起飞 2026-09-23T17:10Z（东京 9/24 02:10），落地 5 小时后
      const depart = Anchored.instant(new Date('2026-09-23T17:10:00Z'), 'Asia/Tokyo');
      const arrive = Anchored.instant(new Date('2026-09-23T22:10:00Z'), 'America/Los_Angeles');

      const departLa = depart.in('America/Los_Angeles');
      const arriveLa = arrive.in('America/Los_Angeles');
      if (departLa.shape !== 'instant' || arriveLa.shape !== 'instant') throw new Error('unreachable');

      // 同一个观察者看两端：起飞 9/23 10:10，落地 9/23 15:10，跨度仍是 5 小时
      expect(departLa.at.toPlainTime().toString()).toBe('10:10:00');
      expect(arriveLa.at.toPlainTime().toString()).toBe('15:10:00');
      expect(arriveLa.at.epochMilliseconds - departLa.at.epochMilliseconds).toBe(5 * 3600_000);
    });

    it('接受 Temporal.Instant 与 Date 两种输入', () => {
      const fromDate = Anchored.instant(new Date('2026-09-21T10:00:00Z'), 'UTC');
      const fromInstant = Anchored.instant(Temporal.Instant.from('2026-09-21T10:00:00Z'), 'UTC');
      expect(fromDate.toString()).toBe(fromInstant.toString());
    });
  });

  describe('date：日历日，不随观察者位移', () => {
    const holiday = Anchored.date('2026-09-21', 'Asia/Tokyo');

    it('任何观察者看到的都是同一个日期', () => {
      for (const viewer of ['Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
        const view = holiday.in(viewer);
        if (view.shape !== 'date') throw new Error('unreachable');
        expect(view.date.toString()).toBe('2026-09-21');
      }
    });

    it('观察者不在归属时区时 sameZone 为 false，供渲染层决定是否标注', () => {
      expect(holiday.in('Asia/Tokyo').sameZone).toBe(true);
      expect(holiday.in('America/Los_Angeles').sameZone).toBe(false);
      expect(holiday.in('America/Los_Angeles').ownZone).toBe('Asia/Tokyo');
    });

    it('拒绝 floating：一个日历日必须属于某本日历', () => {
      expect(() => Anchored.date('2026-09-21', FLOATING)).toThrow(/只有 time 可以是 floating/);
    });

    it('接受 Temporal.PlainDate 与字符串两种输入', () => {
      const a = Anchored.date(Temporal.PlainDate.from('2026-09-21'), 'Asia/Tokyo');
      const b = Anchored.date('2026-09-21', 'Asia/Tokyo');
      expect(a.toString()).toBe(b.toString());
    });
  });

  describe('time：钟点，floating 跟着人走', () => {
    it('floating 的归属在渲染时才确定，就是观察者所在时区', () => {
      const reminder = Anchored.time('07:00', FLOATING);

      const sg = reminder.in('Asia/Singapore');
      if (sg.shape !== 'time') throw new Error('unreachable');
      expect(sg.time.toString()).toBe('07:00:00');
      expect(sg.ownZone).toBe('Asia/Singapore');
      expect(sg.sameZone).toBe(true);

      const tokyo = reminder.in('Asia/Tokyo');
      expect(tokyo.ownZone).toBe('Asia/Tokyo');
      expect(tokyo.sameZone).toBe(true);
    });

    it('锚定时区的钟点不跟着人走，归属始终是原时区', () => {
      const officeHours = Anchored.time('07:00', 'Asia/Tokyo');

      expect(officeHours.in('Asia/Tokyo').sameZone).toBe(true);
      const sg = officeHours.in('Asia/Singapore');
      expect(sg.ownZone).toBe('Asia/Tokyo');
      expect(sg.sameZone).toBe(false);
    });

    it('同一个观察者下，floating 与锚定时区给出不同结果', () => {
      const floating = Anchored.time('07:00', FLOATING).in('Asia/Singapore');
      const anchored = Anchored.time('07:00', 'Asia/Tokyo').in('Asia/Singapore');
      expect(floating.ownZone).not.toBe(anchored.ownZone);
      expect(floating.sameZone).not.toBe(anchored.sameZone);
    });

    it('观察者本身不能是 floating：渲染必须发生在某个具体时区', () => {
      expect(() => Anchored.time('07:00', FLOATING).in(FLOATING)).toThrow(/只有 time 可以是 floating/);
    });
  });

  describe('归属缺失：在构造处失败，不进入渲染', () => {
    it('构造时空归属抛错', () => {
      expect(() => Anchored.instant(new Date(), '')).toThrow(/缺少归属/);
      expect(() => Anchored.date('2026-09-21', '')).toThrow(/缺少归属/);
      expect(() => Anchored.time('07:00', '')).toThrow(/缺少归属/);
    });

    it('fromStored 对 null / undefined 归属抛错，指明由应用层补齐', () => {
      expect(() => Anchored.fromStored(new Date(), null, 'instant')).toThrow(/缺少归属/);
      expect(() => Anchored.fromStored(new Date(), null, 'instant')).toThrow(/应用层补齐/);
      expect(() => Anchored.fromStored('2026-09-21', undefined, 'date')).toThrow(/缺少归属/);
      expect(() => Anchored.fromStored('07:00', '', 'time')).toThrow(/缺少归属/);
    });

    it('fromStored 归属齐备时正常构造', () => {
      const stored = Anchored.fromStored(new Date('2026-09-21T10:00:00Z'), 'Asia/Tokyo', 'instant');
      const view = stored.in('Asia/Tokyo');
      if (view.shape !== 'instant') throw new Error('unreachable');
      expect(view.at.toPlainTime().toString()).toBe('19:00:00');
    });

    it('fromStored 拒绝与形态不匹配的值', () => {
      expect(() => Anchored.fromStored('2026-09-21T10:00:00Z', 'Asia/Tokyo', 'instant')).toThrow(/需要 Date/);
      expect(() => Anchored.fromStored(new Date(), 'Asia/Tokyo', 'date')).toThrow(/需要字符串/);
    });
  });

  describe('归属取值：IANA 名或 floating，不接受裸偏移量', () => {
    it('拒绝偏移量：同一时区在夏令时前后是两个偏移，用它算墙上时间会静默差一小时', () => {
      expect(() => Anchored.instant(new Date(), '+08:00')).toThrow(/必须是 IANA 时区名/);
      expect(() => Anchored.instant(new Date(), '+8')).toThrow(/必须是 IANA 时区名/);
    });

    it('拒绝未知的 IANA 名', () => {
      expect(() => Anchored.instant(new Date(), 'Asia/Atlantis')).toThrow(/未知的 IANA 时区/);
    });

    it('接受 UTC 与 GMT', () => {
      expect(Anchored.instant(new Date('2026-09-21T10:00:00Z'), 'UTC').zone).toBe('UTC');
      expect(Anchored.instant(new Date('2026-09-21T10:00:00Z'), 'GMT').zone).toBe('GMT');
    });
  });

  describe('序列化：可往返，且归属不在往返中丢失', () => {
    it('instant 的 toString 是 RFC 9557（IXDTF），时区名在方括号内', () => {
      const at = Anchored.instant(new Date('2026-09-21T10:00:00Z'), 'Asia/Tokyo');
      expect(at.toString()).toBe('2026-09-21T19:00:00+09:00[Asia/Tokyo]');
    });

    it('date / time 的 toString 供人读，归属以方括号附在后面', () => {
      expect(Anchored.date('2026-09-21', 'Asia/Tokyo').toString()).toBe('2026-09-21[Asia/Tokyo]');
      expect(Anchored.time('07:00', FLOATING).toString()).toBe('07:00:00[floating]');
    });

    it('三种形态都能 JSON 往返', () => {
      const cases = [
        Anchored.instant(new Date('2026-09-21T10:00:00Z'), 'Asia/Tokyo'),
        Anchored.date('2026-09-21', 'America/Los_Angeles'),
        Anchored.time('07:00', 'Asia/Singapore'),
        Anchored.time('07:00', FLOATING),
      ];
      for (const original of cases) {
        const restored = Anchored.fromJSON(JSON.parse(JSON.stringify(original)));
        expect(restored.shape).toBe(original.shape);
        expect(restored.zone).toBe(original.zone);
        expect(restored.toString()).toBe(original.toString());
      }
    });

    it('往返后 floating 仍是 floating，不被折叠成某个具体时区', () => {
      const restored = Anchored.fromJSON(Anchored.time('07:00', FLOATING).toJSON());
      expect(restored.zone).toBe(FLOATING);
      expect(restored.in('Asia/Tokyo').ownZone).toBe('Asia/Tokyo');
      expect(restored.in('America/Los_Angeles').ownZone).toBe('America/Los_Angeles');
    });

    it('fromJSON 对缺归属或未知形态抛错', () => {
      expect(() =>
        Anchored.fromJSON({ shape: 'instant', value: '2026-09-21T19:00:00+09:00[Asia/Tokyo]', zone: '' }),
      ).toThrow(/缺少归属/);
      expect(() => Anchored.fromJSON({ shape: 'date', value: '2026-09-21', zone: '' })).toThrow(/缺少归属/);
      expect(() => Anchored.fromJSON({ shape: 'duration' as never, value: 'PT1H', zone: 'UTC' })).toThrow(/未知形态/);
    });
  });
});
