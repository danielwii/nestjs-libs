import { getAppLogger } from '@app/utils/app-logger';

export type ProvenanceTags = Readonly<Record<string, string>>;

const logger = getAppLogger('ProvenanceTags');

const MAX_TAGS = 16;
const MAX_KEY_LENGTH = 64;
const MAX_VALUE_LENGTH = 256;
const KEY_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
const SENSITIVE_KEY_PARTS = new Set([
  'authorization',
  'cookie',
  'csrf_token',
  'id_token',
  'api_key',
  'password',
  'refresh_token',
  'secret',
  'token',
]);

function isSensitiveKey(key: string): boolean {
  return key.split('.').some((part) => SENSITIVE_KEY_PARTS.has(part) || part.endsWith('_token'));
}

function normalizeValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : undefined;
  }

  if (typeof value === 'boolean') {
    return String(value);
  }

  return undefined;
}

function warnDropped(dropped: number): void {
  if (dropped > 0) {
    logger.warning`Dropped ${dropped} invalid provenance tag(s)`;
  }
}

export function sanitizeProvenanceTags(
  input: Record<string, unknown> | undefined,
  options?: { warn?: boolean },
): ProvenanceTags {
  if (!input) return Object.freeze({});

  const output: Record<string, string> = {};
  let accepted = 0;
  let dropped = 0;

  for (const [key, rawValue] of Object.entries(input)) {
    const value = normalizeValue(rawValue);
    const valid =
      key.length <= MAX_KEY_LENGTH &&
      KEY_PATTERN.test(key) &&
      !isSensitiveKey(key) &&
      value !== undefined &&
      value.length <= MAX_VALUE_LENGTH &&
      accepted < MAX_TAGS;

    if (!valid) {
      dropped += 1;
      continue;
    }

    output[key] = value;
    accepted += 1;
  }

  if (options?.warn) {
    warnDropped(dropped);
  }
  return Object.freeze(output);
}

export function sortedProvenanceEntries(tags: ProvenanceTags | undefined): Array<[string, string]> {
  return Object.entries(sanitizeProvenanceTags(tags)).sort(([a], [b]) => a.localeCompare(b));
}

export function toProvenanceLogTags(tags: ProvenanceTags | undefined = {}): string[] {
  return sortedProvenanceEntries(tags).map(([key, value]) => `provenance:${key}=${value}`);
}

export function toProvenanceLlmTags(tags: ProvenanceTags | undefined = {}): string[] {
  return sortedProvenanceEntries(tags).map(([key, value]) => `${key}:${value}`);
}

export function mergeProvenanceLlmTags(
  existingTags: readonly string[] = [],
  tags: ProvenanceTags | undefined = {},
): string[] {
  const provenanceTags = toProvenanceLlmTags(tags);
  return provenanceTags.length > 0 ? [...existingTags, ...provenanceTags] : [...existingTags];
}
