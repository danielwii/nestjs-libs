import { decodeStoredJson } from './stored-json';

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

describe('decodeStoredJson', () => {
  it.each([undefined, null, ''])('%p is absent, not unreadable, and records nothing', (raw) => {
    expect(decodeStoredJson(schema, raw, 'r')).toEqual({ status: 'absent' });
    expect(records).toEqual([]);
  });

  it('reads an already-parsed value and a JSON text the same way', () => {
    expect(decodeStoredJson(schema, { a: 'x' }, 'r')).toEqual({ status: 'ok', value: { a: 'x' } });
    expect(decodeStoredJson(schema, '{"a":"x"}', 'r')).toEqual({ status: 'ok', value: { a: 'x' } });
  });

  it('unreadable leaves a record with the reader and the failing paths, never the content', () => {
    expect(decodeStoredJson(schema, { a: 7, secret: 'do-not-log' }, 'reader_x')).toEqual({ status: 'unreadable' });
    expect(decodeStoredJson(schema, 'not json', 'reader_y')).toEqual({ status: 'unreadable' });
    expect(records.map((record) => record.properties)).toEqual([
      { event: 'stored_json_unreadable', reader: 'reader_x', paths: ['a'] },
      { event: 'stored_json_unreadable', reader: 'reader_y', paths: ['(json)'] },
    ]);
    expect(JSON.stringify(records.map((record) => [record.message, record.properties]))).not.toContain('do-not-log');
  });
});
