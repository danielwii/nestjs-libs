import { randomInt } from 'node:crypto';

import { z } from 'zod';

const SHORT_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const SHORT_ID_LENGTH = 6;

function assertPrefix(prefix: string): void {
  if (typeof prefix !== 'string' || prefix.length === 0 || /\s/.test(prefix)) {
    throw new Error('Short ID prefix must be a non-empty string without whitespace.');
  }
}

/** Generate an ID using the caller's registered domain prefix; persistence enforces uniqueness. */
export function generateShortId(prefix: string): string {
  assertPrefix(prefix);
  let suffix = '';
  for (let index = 0; index < SHORT_ID_LENGTH; index += 1) {
    suffix += SHORT_ID_ALPHABET.charAt(randomInt(SHORT_ID_ALPHABET.length));
  }
  return `${prefix}_${suffix}`;
}

/** Bind validation to a registered prefix supplied by the application, never inferred from input. */
export function getShortIdRegex(prefix: string): RegExp {
  assertPrefix(prefix);
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escapedPrefix}_[0-9a-z]{${SHORT_ID_LENGTH}}$`);
}

/** Tool boundary schema: accepts only the configured prefix and a six-character base-36 suffix. */
export function zShortId(prefix: string, description: string) {
  const pattern = getShortIdRegex(prefix);
  const message = `Expected a short ID with registered prefix "${prefix}" and exactly 6 lowercase base-36 characters.`;
  return (
    z
      .string()
      // JavaScript's $ anchor also matches before a final newline; exact length closes that boundary.
      .length(prefix.length + 1 + SHORT_ID_LENGTH, { error: message })
      .regex(pattern, { error: message })
      .describe(description)
  );
}

/** Runtime boundary for a domain's branded short ID. The application supplies its registered prefix. */
export function createShortIdGuard<T extends string>(registeredPrefix: string) {
  const schema = zShortId(registeredPrefix, 'Stable entity short ID');
  const is = (value: unknown): value is T => schema.safeParse(value).success;
  return {
    is,
    of(value: unknown): T {
      if (!is(value)) {
        throw new Error(
          `Invalid short ID: expected registered prefix "${registeredPrefix}" and exactly 6 lowercase base-36 characters.`,
        );
      }
      return value;
    },
  };
}
