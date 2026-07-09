import { getAppLogger } from '@app/utils/app-logger';

import { RequestContext } from './request-context';

import { context, trace } from '@opentelemetry/api';

import type { Span } from '@opentelemetry/api';

export type ProvenanceTags = Readonly<Record<string, string>>;

const logger = getAppLogger('ProvenanceTags');

const PROVENANCE_TAGS_KEY = 'provenance.tags';
const ACTIVE_SPAN_LLM_TAGS_KEY = 'provenance.active_span_llm_tags';
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

function hasRequestContext(): boolean {
  return RequestContext.entries() !== undefined;
}

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

export function setProvenanceTags(tags: Record<string, unknown>): void {
  if (!hasRequestContext()) return;

  const sanitized = sanitizeProvenanceTags(tags, { warn: true });
  RequestContext.set(PROVENANCE_TAGS_KEY, sanitized);
  applyProvenanceToActiveSpan(sanitized);
}

export function mergeProvenanceTags(tags: Record<string, unknown>): void {
  if (!hasRequestContext()) return;

  const merged = {
    ...getProvenanceTags(),
    ...sanitizeProvenanceTags(tags, { warn: true }),
  };
  const sanitized = sanitizeProvenanceTags(merged);
  RequestContext.set(PROVENANCE_TAGS_KEY, sanitized);
  applyProvenanceToActiveSpan(sanitized);
}

export function getProvenanceTags(): ProvenanceTags {
  const current = RequestContext.get<Record<string, unknown>>(PROVENANCE_TAGS_KEY);
  return sanitizeProvenanceTags(current);
}

export function clearProvenanceTags(): void {
  if (!hasRequestContext()) return;
  RequestContext.set(PROVENANCE_TAGS_KEY, undefined);
}

export function setActiveSpanLlmTags(tags: readonly string[] | undefined): readonly string[] | undefined {
  if (!hasRequestContext()) return undefined;

  const previous = RequestContext.get<readonly string[]>(ACTIVE_SPAN_LLM_TAGS_KEY);
  RequestContext.set(ACTIVE_SPAN_LLM_TAGS_KEY, tags !== undefined ? [...tags] : undefined);
  return previous;
}

export function getActiveSpanLlmTags(): readonly string[] {
  return RequestContext.get<readonly string[]>(ACTIVE_SPAN_LLM_TAGS_KEY) ?? [];
}

function sortedEntries(tags: ProvenanceTags | undefined): Array<[string, string]> {
  return Object.entries(sanitizeProvenanceTags(tags)).sort(([a], [b]) => a.localeCompare(b));
}

export function toProvenanceLogTags(tags: ProvenanceTags = getProvenanceTags()): string[] {
  return sortedEntries(tags).map(([key, value]) => `provenance:${key}=${value}`);
}

export function toProvenanceLlmTags(tags: ProvenanceTags = getProvenanceTags()): string[] {
  return sortedEntries(tags).map(([key, value]) => `${key}:${value}`);
}

export function mergeProvenanceLlmTags(
  existingTags: readonly string[] = [],
  tags: ProvenanceTags = getProvenanceTags(),
): string[] {
  const provenanceTags = toProvenanceLlmTags(tags);
  return provenanceTags.length > 0 ? [...existingTags, ...provenanceTags] : [...existingTags];
}

export function applyProvenanceToSpan(
  span: Span,
  tags: ProvenanceTags = getProvenanceTags(),
  existingLlmTags: readonly string[] = [],
): void {
  const entries = sortedEntries(tags);
  if (entries.length === 0) return;

  for (const [key, value] of entries) {
    span.setAttribute(`provenance.${key}`, value);
  }

  span.setAttribute('ai.telemetry.metadata.tags', mergeProvenanceLlmTags(existingLlmTags, tags));
}

export function applyProvenanceToActiveSpan(tags: ProvenanceTags = getProvenanceTags()): void {
  const span = trace.getSpan(context.active());
  if (!span) return;
  applyProvenanceToSpan(span, tags, getActiveSpanLlmTags());
}
