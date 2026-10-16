import { Oops } from '@app/nest/exceptions/oops';

import { assertZone } from './anchored';
import { normalizeTimezone } from './datetime';
import { formatLocalDateTime, readLocalTime, TimeSensitivity } from './prompt';
import { PromptBuilder } from './prompt.xml';

import { describe, expect, spyOn, test } from 'bun:test';

describe('prompt clock display without geographic attribution', () => {
  const instant = '2026-10-16T05:00:00Z';

  for (const [zone, expected] of [
    ['-04:00', '2026-10-16 Friday 01:00 in the morning (UTC-4)'],
    ['America/Los_Angeles', '2026-10-15 Thursday 22:00 at night (America/Los_Angeles)'],
    ['+8', '2026-10-16 Friday 13:00 in the afternoon (UTC+8)'],
    ['+05:30', '2026-10-16 Friday 10:30 in the morning (UTC+5:30)'],
    ['UTC', '2026-10-16 Friday 05:00 in the morning (UTC)'],
  ] satisfies Array<[string, string]>) {
    test(`projects the same instant into ${zone}`, () => {
      expect(formatLocalDateTime(instant, TimeSensitivity.Minute, zone)).toBe(expected);
      expect(
        PromptBuilder.from({ id: 'sample', role: 'assistant', objective: 'answer' }).render({
          now: instant,
          timezone: zone,
        }),
      ).toContain(`Now:${expected}`);
    });
  }

  test('IANA display retains DST disambiguation and existing attributed reading text', () => {
    const zone = assertZone('America/Los_Angeles');
    const before = '2026-11-01T08:30:00Z';
    const after = '2026-11-01T09:30:00Z';
    expect(formatLocalDateTime(before, TimeSensitivity.Minute, zone)).toBe(readLocalTime(before, zone, zone).text);
    expect(formatLocalDateTime(after, TimeSensitivity.Minute, zone)).toBe(readLocalTime(after, zone, zone).text);
    expect(formatLocalDateTime(before, TimeSensitivity.Hour, zone)).toContain('01:30-07:00');
    expect(formatLocalDateTime(after, TimeSensitivity.Hour, zone)).toContain('01:30-08:00');
    expect(formatLocalDateTime(instant, TimeSensitivity.Day, '+8')).toBe('2026-10-16 Friday in the afternoon (UTC+8)');
  });

  test('offsets remain invalid geographic attribution despite being valid display inputs', () => {
    expect(() => assertZone('+08:00')).toThrow();
    expect(() => assertZone('-04:00')).toThrow();
  });

  for (const zone of [undefined, null, '', ' ', 'unknown-zone', '+14:30', '+25:00']) {
    test(`rejects invalid display timezone ${String(zone)}`, () => {
      expect(() => formatLocalDateTime(instant, TimeSensitivity.Minute, zone)).toThrow(Oops.Block);
    });
  }

  test('timeless prompts do not require a timezone', () => {
    expect(
      PromptBuilder.from({ id: 'classification', role: 'assistant', objective: 'classify' }).render({ now: null }),
    ).not.toContain('Now:');
  });

  test('normalization does not disguise runtime faults as invalid caller input', () => {
    const fault = new Error('Synthetic clock runtime failure');
    const projection = spyOn(Temporal.Instant.prototype, 'toZonedDateTimeISO').mockImplementation(() => {
      throw fault;
    });
    try {
      expect(() => normalizeTimezone('UTC')).toThrow(fault);
    } finally {
      projection.mockRestore();
    }
  });
});
