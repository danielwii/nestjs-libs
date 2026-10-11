import { getAppLogger } from '@app/utils/app-logger';

import type { z } from 'zod';

/**
 * Single entry point for decoding a value that was stored earlier (a JSON column, a cached JSON text).
 *
 * Goal: the reader can tell three situations apart — nothing there (`absent`), read (`ok`), and something there that
 *   cannot be read (`unreadable`). Unreadable is not "nothing": it leaves one `stored_json_unreadable` record carrying the
 *   reader's name and the failing paths, so the caller decides how to degrade (say "unavailable", skip a button, …)
 *   instead of silently reading an empty value.
 * Design: absent = `undefined` / `null` / empty string; a string is parsed as JSON text first; any other value is taken as
 *   an already-parsed JSON value; a schema mismatch records the zod issue paths. The record never carries the content.
 * Not covered: how the caller degrades — that stays with the caller.
 * Exit condition: none.
 */
const logger = getAppLogger('StoredJson');

export type StoredJsonRead<T> =
  { readonly status: 'absent' } | { readonly status: 'unreadable' } | { readonly status: 'ok'; readonly value: T };

/**
 * @param reader Identifier of the reading site; appears in the record. Keep it low-cardinality (e.g. `invoice_lines`).
 * @param raw The stored value (see the design note above for how each shape is read).
 */
export function decodeStoredJson<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  reader: string,
): StoredJsonRead<z.infer<S>> {
  if (raw === undefined || raw === null || raw === '') return { status: 'absent' };
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return unreadable(reader, ['(json)']);
    }
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { status: 'ok', value: parsed.data };
  return unreadable(
    reader,
    parsed.error.issues.map((issue) => issue.path.map(String).join('.') || '(root)'),
  );
}

function unreadable(reader: string, paths: readonly string[]): { readonly status: 'unreadable' } {
  logger.error('stored_json_unreadable reader={reader} paths={paths}', {
    event: 'stored_json_unreadable',
    reader,
    paths: [...paths],
  });
  return { status: 'unreadable' };
}
