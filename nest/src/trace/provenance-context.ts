import {
  mergeProvenanceLlmTags as mergeProvenanceLlmTagsFromTags,
  sanitizeProvenanceTags,
  toProvenanceLlmTags as toProvenanceLlmTagsFromTags,
  toProvenanceLogTags as toProvenanceLogTagsFromTags,
} from './provenance-format';
import { RequestContext } from './request-context';

import type { ProvenanceTags } from './provenance-format';

const PROVENANCE_TAGS_KEY = 'provenance.tags';

function hasRequestContext(): boolean {
  return RequestContext.entries() !== undefined;
}

export function setProvenanceTags(tags: Record<string, unknown>): void {
  if (!hasRequestContext()) return;

  const sanitized = sanitizeProvenanceTags(tags, { warn: true });
  RequestContext.set(PROVENANCE_TAGS_KEY, sanitized);
}

export function mergeProvenanceTags(tags: Record<string, unknown>): void {
  if (!hasRequestContext()) return;

  const merged = {
    ...getProvenanceTags(),
    ...sanitizeProvenanceTags(tags, { warn: true }),
  };
  const sanitized = sanitizeProvenanceTags(merged);
  RequestContext.set(PROVENANCE_TAGS_KEY, sanitized);
}

export function getProvenanceTags(): ProvenanceTags {
  const current = RequestContext.get<Record<string, unknown>>(PROVENANCE_TAGS_KEY);
  return sanitizeProvenanceTags(current);
}

export function clearProvenanceTags(): void {
  if (!hasRequestContext()) return;
  RequestContext.set(PROVENANCE_TAGS_KEY, undefined);
}

export function toProvenanceLogTags(tags: ProvenanceTags = getProvenanceTags()): string[] {
  return toProvenanceLogTagsFromTags(tags);
}

export function toProvenanceLlmTags(tags: ProvenanceTags = getProvenanceTags()): string[] {
  return toProvenanceLlmTagsFromTags(tags);
}

export function mergeProvenanceLlmTags(
  existingTags: readonly string[] = [],
  tags: ProvenanceTags = getProvenanceTags(),
): string[] {
  return mergeProvenanceLlmTagsFromTags(existingTags, tags);
}
