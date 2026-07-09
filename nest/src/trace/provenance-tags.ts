import {
  getProvenanceTags,
  mergeProvenanceTags as mergeContextProvenanceTags,
  mergeProvenanceLlmTags,
  setProvenanceTags as setContextProvenanceTags,
} from './provenance-context';
import { sortedProvenanceEntries } from './provenance-format';

import { context, createContextKey, trace } from '@opentelemetry/api';

import type { ProvenanceTags } from './provenance-format';
import type { Context, Span } from '@opentelemetry/api';

const ACTIVE_SPAN_LLM_TAGS_CONTEXT_KEY = createContextKey('provenance.active_span_llm_tags');

export type { ProvenanceTags } from './provenance-format';
export { sanitizeProvenanceTags } from './provenance-format';
export {
  clearProvenanceTags,
  getProvenanceTags,
  mergeProvenanceLlmTags,
  toProvenanceLlmTags,
  toProvenanceLogTags,
} from './provenance-context';

export function withActiveSpanLlmTags(activeContext: Context, tags: readonly string[] | undefined): Context {
  if (tags === undefined) {
    return activeContext.deleteValue(ACTIVE_SPAN_LLM_TAGS_CONTEXT_KEY);
  }

  return activeContext.setValue(ACTIVE_SPAN_LLM_TAGS_CONTEXT_KEY, [...tags]);
}

export function getActiveSpanLlmTags(activeContext: Context = context.active()): readonly string[] {
  const tags = activeContext.getValue(ACTIVE_SPAN_LLM_TAGS_CONTEXT_KEY);
  return Array.isArray(tags) && tags.every((tag) => typeof tag === 'string') ? tags : [];
}

export function setProvenanceTags(tags: Record<string, unknown>): void {
  setContextProvenanceTags(tags);
  applyProvenanceToActiveSpan();
}

export function mergeProvenanceTags(tags: Record<string, unknown>): void {
  mergeContextProvenanceTags(tags);
  applyProvenanceToActiveSpan();
}

export function applyProvenanceToSpan(
  span: Span,
  tags: ProvenanceTags = getProvenanceTags(),
  existingLlmTags: readonly string[] = [],
): void {
  const entries = sortedProvenanceEntries(tags);
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
