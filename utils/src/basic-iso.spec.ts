import { formatBasicDate, formatBasicFloating, formatBasicUtc, parseBasicDate, parseBasicDateTime } from './basic-iso';

import { describe, expect, it } from 'bun:test';

describe('basic ISO (RFC 5545) text', () => {
  describe('parseBasicDate', () => {
    it('reads yyyyMMdd as the calendar date', () => {
      expect(parseBasicDate('20261012').toString()).toBe('2026-10-12');
      expect(parseBasicDate('20280229').toString()).toBe('2028-02-29');
    });

    it.each(['2026-10-12', '2026101', '202610120', '20260230', '20261301', '20261232', '', ' 20261012', '2026101a'])(
      'throws on %p',
      (text) => {
        expect(() => parseBasicDate(text)).toThrow(RangeError);
      },
    );
  });

  describe('parseBasicDateTime', () => {
    it('a trailing Z is an instant', () => {
      const parsed = parseBasicDateTime('20261012T093000Z');
      expect(parsed.kind).toBe('utc');
      if (parsed.kind === 'utc') expect(parsed.instant.toString()).toBe('2026-10-12T09:30:00Z');
    });

    it('no Z is a floating wall-clock reading, not an instant', () => {
      const parsed = parseBasicDateTime('20261012T093000');
      expect(parsed.kind).toBe('floating');
      if (parsed.kind === 'floating') expect(parsed.dateTime.toString()).toBe('2026-10-12T09:30:00');
    });

    it('the caller has to switch on the kind (the two never share a field)', () => {
      const describeIt = (text: string): string => {
        const parsed = parseBasicDateTime(text);
        switch (parsed.kind) {
          case 'utc':
            return `utc ${parsed.instant.epochMilliseconds}`;
          case 'floating':
            return `floating ${parsed.dateTime.hour}`;
        }
      };
      expect(describeIt('20261012T093000Z')).toBe(`utc ${Date.UTC(2026, 9, 12, 9, 30)}`);
      expect(describeIt('20261012T093000')).toBe('floating 9');
    });

    it.each([
      '20261012',
      '20261012T0930',
      '20261012T093000z',
      '2026-10-12T09:30:00Z',
      '20261012T240000',
      '20261012T093060',
      '20261012T096000',
      '20260230T093000',
      '20261012T093000+0800',
      '',
    ])('throws on %p', (text) => {
      expect(() => parseBasicDateTime(text)).toThrow(RangeError);
    });
  });

  describe('format', () => {
    it('a date', () => {
      expect(formatBasicDate(Temporal.PlainDate.from('2026-10-02'))).toBe('20261002');
    });

    it('an instant is printed in UTC with Z, truncated to the second', () => {
      expect(formatBasicUtc(Temporal.Instant.from('2026-10-12T09:30:00Z'))).toBe('20261012T093000Z');
      expect(formatBasicUtc(Temporal.Instant.from('2026-10-12T23:59:59.999Z'))).toBe('20261012T235959Z');
    });

    it('a floating date-time is printed as written, without Z', () => {
      expect(formatBasicFloating(Temporal.PlainDateTime.from('2026-03-08T02:30:00'))).toBe('20260308T023000');
    });

    it('a zoned value must be turned into one of the two explicitly, and the two differ', () => {
      const zoned = Temporal.ZonedDateTime.from('2026-10-12T09:30:00-07:00[America/Los_Angeles]');
      expect(formatBasicUtc(zoned.toInstant())).toBe('20261012T163000Z');
      expect(formatBasicFloating(zoned.toPlainDateTime())).toBe('20261012T093000');
    });

    it('refuses a year that does not fit four digits', () => {
      expect(() => formatBasicDate(Temporal.PlainDate.from('+010000-01-01'))).toThrow(RangeError);
    });
  });

  it('round-trips both forms', () => {
    for (const text of ['20261012T093000Z', '20261012T093000']) {
      const parsed = parseBasicDateTime(text);
      expect(parsed.kind === 'utc' ? formatBasicUtc(parsed.instant) : formatBasicFloating(parsed.dateTime)).toBe(text);
    }
    expect(formatBasicDate(parseBasicDate('20261012'))).toBe('20261012');
  });
});
