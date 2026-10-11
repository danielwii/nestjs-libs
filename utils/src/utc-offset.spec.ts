import { isFixedOffsetZone, parseUtcOffsetMinutes } from './utc-offset';

import { describe, expect, it } from 'bun:test';

describe('parseUtcOffsetMinutes', () => {
  it.each([
    ['UTC+8', 480],
    ['UTC-5', -300],
    ['GMT+08:00', 480],
    ['GMT-05:30', -330],
    ['utc+05:45', 345],
    ['UTC+0530', 330],
    ['UTC+14', 840],
    ['+08:00', 480],
    ['-03:30', -210],
    [' UTC+9 ', 540],
  ])('%s -> %i minutes', (text, minutes) => {
    expect(parseUtcOffsetMinutes(text)).toBe(minutes);
  });

  it.each([
    undefined,
    null,
    '',
    ' ',
    'UTC',
    'GMT',
    'Asia/Tokyo',
    'Etc/GMT+8',
    'UTC+15',
    'UTC+8:60',
    'UTC+',
    '8',
    'UTC+8:5',
  ])('%p is not a spelled offset', (text) => {
    expect(parseUtcOffsetMinutes(text)).toBeNull();
  });
});

describe('isFixedOffsetZone', () => {
  it.each(['UTC', 'GMT', 'Etc/UTC', 'Etc/GMT', 'Etc/GMT+8', 'Etc/GMT-14', 'etc/gmt+0', ' UTC '])(
    '%s is a fixed-offset zone',
    (zone) => {
      expect(isFixedOffsetZone(zone)).toBe(true);
    },
  );

  it.each([
    undefined,
    null,
    '',
    'Asia/Tokyo',
    'America/Los_Angeles',
    'UTC+8',
    'GMT-05:30',
    'Etc/GMT+123',
    'Europe/London',
  ])('%p is not', (zone) => {
    expect(isFixedOffsetZone(zone)).toBe(false);
  });

  it('a spelled offset and a fixed-offset zone name are different questions', () => {
    expect(parseUtcOffsetMinutes('Etc/GMT+8')).toBeNull();
    expect(isFixedOffsetZone('UTC+8')).toBe(false);
  });
});
