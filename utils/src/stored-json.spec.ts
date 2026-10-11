import { decodeJsonText, decodeJsonValue } from './stored-json';

import { configure, reset } from '@logtape/logtape';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { LogRecord } from '@logtape/logtape';

const schema = z.object({ a: z.string() });
let records: LogRecord[] = [];

beforeEach(async () => {
  records = [];
  await configure({
    reset: true,
    // LogTape announces its own configuration through the meta logger; only the library's own records matter here.
    sinks: { memory: (record) => void (record.category[0] !== 'logtape' && records.push(record)) },
    loggers: [{ category: [], sinks: ['memory'], lowestLevel: 'debug' }],
  });
});
afterEach(async () => {
  await reset();
});

const recorded = () => JSON.stringify(records.map((record) => [record.message, record.properties]));

describe('decodeJsonText', () => {
  it.each([undefined, null, ''])('%p is nothing there: ok(undefined), no record', (text) => {
    const result = decodeJsonText(schema, text, 'r');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeUndefined();
    expect(records).toEqual([]);
  });

  it('reads JSON text that fits the schema', () => {
    expect(decodeJsonText(schema, '{"a":"x"}', 'r')._unsafeUnwrap()).toEqual({ a: 'x' });
    expect(records).toEqual([]);
  });

  it('broken JSON is an error at (json) and leaves a content-free record', () => {
    const result = decodeJsonText(schema, '{"a": "do-not-log"', 'reader_x');
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: 'stored_json_unreadable',
      reader: 'reader_x',
      paths: ['(json)'],
    });
    expect(records.map((record) => record.properties)).toEqual([
      { event: 'stored_json_unreadable', reader: 'reader_x', paths: ['(json)'] },
    ]);
    expect(recorded()).not.toContain('do-not-log');
  });

  it('JSON that does not fit the schema is an error at the failing paths; the root is (root)', () => {
    expect(decodeJsonText(schema, '{"a":7,"secret":"do-not-log"}', 'r1')._unsafeUnwrapErr().paths).toEqual(['a']);
    expect(decodeJsonText(schema, '[]', 'r2')._unsafeUnwrapErr().paths).toEqual(['(root)']);
    expect(records.map((record) => record.properties)).toEqual([
      { event: 'stored_json_unreadable', reader: 'r1', paths: ['a'] },
      { event: 'stored_json_unreadable', reader: 'r2', paths: ['(root)'] },
    ]);
    expect(recorded()).not.toContain('do-not-log');
  });
});

describe('decodeJsonValue', () => {
  it.each([undefined, null])('%p is nothing there: ok(undefined), no record', (value) => {
    const result = decodeJsonValue(schema, value, 'r');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeUndefined();
    expect(records).toEqual([]);
  });

  it('reads a parsed value that fits the schema', () => {
    expect(decodeJsonValue(schema, { a: 'x' }, 'r')._unsafeUnwrap()).toEqual({ a: 'x' });
    expect(records).toEqual([]);
  });

  it('a value that does not fit the schema is an error at the failing paths, with a content-free record', () => {
    const result = decodeJsonValue(schema, { a: 7, secret: 'do-not-log' }, 'reader_y');
    expect(result._unsafeUnwrapErr()).toEqual({ kind: 'stored_json_unreadable', reader: 'reader_y', paths: ['a'] });
    expect(records.map((record) => record.properties)).toEqual([
      { event: 'stored_json_unreadable', reader: 'reader_y', paths: ['a'] },
    ]);
    expect(recorded()).not.toContain('do-not-log');
  });

  it('never parses a string: JSON text is handed to the schema as a string', () => {
    expect(decodeJsonValue(schema, '{"a":"x"}', 'r').isErr()).toBe(true);
    expect(decodeJsonValue(z.string(), '{"a":"x"}', 'r')._unsafeUnwrap()).toBe('{"a":"x"}');
  });

  it('an empty string is a value for the schema, not nothing there', () => {
    expect(decodeJsonValue(z.string(), '', 'r')._unsafeUnwrap()).toBe('');
  });
});
