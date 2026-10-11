import { getAppLogger } from '@app/utils/app-logger';

import { err, ok } from 'neverthrow';

import type { Result } from 'neverthrow';
import type { z } from 'zod';

/**
 * Entry points for reading a value that was stored earlier (a JSON column, a cached JSON text).
 *
 * Goal: the reader can tell three situations apart — nothing there (`ok(undefined)`), read (`ok(value)`), and something
 *   there that cannot be read (`err`). Unreadable is not "nothing": it leaves one `stored_json_unreadable` record carrying
 *   the reader's name and the failing paths, so the caller decides how to degrade (say "unavailable", skip a button, …)
 *   instead of silently reading an empty value.
 * Design: two entries, split by what the stored thing is. `decodeJsonText` takes JSON text and parses it; `decodeJsonValue`
 *   takes an already-parsed value (a JSON column) and never parses a string, so a string that happens to hold JSON stays
 *   a string for the schema to judge. Both validate with the caller's zod schema. The record never carries the content.
 * Not covered: how the caller degrades — that stays with the caller (match / isOk / isErr on the result).
 * Exit condition: none.
 */
const logger = getAppLogger('StoredJson');

export interface StoredJsonUnreadable {
  readonly kind: 'stored_json_unreadable';
  readonly reader: string;
  readonly paths: readonly string[];
}

/**
 * @param text Stored JSON text; `null` / `undefined` / empty string = nothing there.
 * @param reader Identifier of the reading site; appears in the record. Keep it low-cardinality (e.g. `invoice_lines`).
 */
export function decodeJsonText<S extends z.ZodType>(
  schema: S,
  text: string | null | undefined,
  reader: string,
): Result<z.infer<S> | undefined, StoredJsonUnreadable> {
  if (text === undefined || text === null || text === '') return ok(undefined);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return unreadable(reader, ['(json)']);
  }
  return validate(schema, value, reader);
}

/**
 * @param value An already-parsed stored value; `null` / `undefined` = nothing there. A string is handed to the schema as is.
 * @param reader Identifier of the reading site (see `decodeJsonText`).
 */
export function decodeJsonValue<S extends z.ZodType>(
  schema: S,
  value: unknown,
  reader: string,
): Result<z.infer<S> | undefined, StoredJsonUnreadable> {
  if (value === undefined || value === null) return ok(undefined);
  return validate(schema, value, reader);
}

function validate<S extends z.ZodType>(
  schema: S,
  value: unknown,
  reader: string,
): Result<z.infer<S> | undefined, StoredJsonUnreadable> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return ok(parsed.data);
  return unreadable(
    reader,
    parsed.error.issues.map((issue) => issue.path.map(String).join('.') || '(root)'),
  );
}

function unreadable(reader: string, paths: readonly string[]): Result<never, StoredJsonUnreadable> {
  logger.error('stored_json_unreadable reader={reader} paths={paths}', {
    event: 'stored_json_unreadable',
    reader,
    paths: [...paths],
  });
  return err({ kind: 'stored_json_unreadable', reader, paths });
}
