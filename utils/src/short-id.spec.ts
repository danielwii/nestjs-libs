import { generateShortId, getShortIdRegex, zShortId } from './short-id';

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

describe('short IDs', () => {
  it('generates exactly six lowercase base-36 characters with the supplied prefix', () => {
    for (const prefix of ['tsk', 'api2', 'custom.prefix']) {
      const schema = zShortId(prefix, 'Entity short ID');
      for (let index = 0; index < 1000; index += 1) {
        const id = generateShortId(prefix);
        expect(id.slice(0, prefix.length + 1)).toBe(`${prefix}_`);
        expect(id.slice(prefix.length + 1)).toMatch(/^[0-9a-z]{6}$/);
        expect(schema.parse(id)).toBe(id);
      }
    }
  });

  it('constructs the specified pattern and supports digit-bearing prefixes', () => {
    const pattern = getShortIdRegex('api2');
    expect(pattern.source).toBe('^api2_[0-9a-z]{6}$');
    expect(pattern.test('api2_0o1l9z')).toBe(true);
    expect(pattern.test('api_0o1l9z')).toBe(false);
    expect(pattern.test('other_0o1l9z')).toBe(false);
  });

  it('escapes every regex metacharacter in a custom registered prefix', () => {
    for (const character of '.*+?^${}()|[]\\') {
      const prefix = `api${character}2`;
      const pattern = getShortIdRegex(prefix);
      expect(pattern.test(`${prefix}_abc123`)).toBe(true);
      expect(pattern.test('apiX2_abc123')).toBe(false);
      expect(zShortId(prefix, 'Custom ID').parse(`${prefix}_abc123`)).toBe(`${prefix}_abc123`);
    }
  });

  it('preserves valid values, including visually ambiguous base-36 characters', () => {
    const schema = zShortId('tsk', 'Stable task short ID');
    for (const id of ['tsk_3k9f2a', 'tsk_0o1liz', 'tsk_000000', 'tsk_zzzzzz']) {
      expect(schema.parse(id)).toBe(id);
    }
    expect(schema.description).toBe('Stable task short ID');
    expect(z.toJSONSchema(schema).pattern).toBe('^tsk_[0-9a-z]{6}$');
  });

  it.each([
    'tsk_3K9f2a',
    'TSK_3k9f2a',
    'tsk_3k-f2a',
    'tsk_3k_f2a',
    'tsk_3k f2a',
    'tsk_abc12',
    'tsk_abc1234',
    'tsk_',
    'abc123',
    'usr_abc123',
    'unknown_abc123',
    'cm1234567890abcdefghijkl',
    'tsk_cm1234567890abcdefghijkl',
    ' tsk_abc123',
    'tsk_abc123 ',
    'tsk_abc123\n',
    'tsk_abc123\r\n',
    'tsk_abc123\r',
    'tsk_abc123\u2028',
    'tsk_abc123\u2029',
    'tsk_abc12é',
    '',
  ])('rejects malformed or unregistered input: %j', (input) => {
    const result = zShortId('tsk', 'Task ID').safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('registered prefix "tsk"');
    }
  });

  it('rejects non-string input without coercion', () => {
    for (const input of [null, undefined, 123, {}, ['tsk_abc123']]) {
      expect(zShortId('tsk', 'Task ID').safeParse(input).success).toBe(false);
    }
  });

  it.each(['', ' ', 'tsk\n', 'a b'])('rejects invalid prefix configuration: %j', (prefix) => {
    expect(() => generateShortId(prefix)).toThrow('Short ID prefix');
    expect(() => getShortIdRegex(prefix)).toThrow('Short ID prefix');
    expect(() => zShortId(prefix, 'ID')).toThrow('Short ID prefix');
  });
});
