import { sanitizeProvenanceTags, sortedProvenanceEntries } from './provenance-format';
import { getProvenanceTags } from './provenance-tags';

import { context, propagation } from '@opentelemetry/api';

import type { ProvenanceTags } from './provenance-format';
import type { Context } from '@opentelemetry/api';

export const PROVENANCE_BAGGAGE_KEY = 'provenance.tags';

const MAX_PROVENANCE_BAGGAGE_VALUE_LENGTH = 4_096;
const MAX_W3C_BAGGAGE_MEMBER_LENGTH = 4_096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyProvenanceTags(): ProvenanceTags {
  return sanitizeProvenanceTags(undefined);
}

function fitsW3cBaggageMember(value: string): boolean {
  const encodedMember = `${encodeURIComponent(PROVENANCE_BAGGAGE_KEY)}=${encodeURIComponent(value)}`;
  return encodedMember.length <= MAX_W3C_BAGGAGE_MEMBER_LENGTH;
}

/** Normalizes transport data only; callers must establish trust before storing these tags in request context. */
export function readProvenanceBaggage(activeContext: Context = context.active()): ProvenanceTags {
  const value = propagation.getBaggage(activeContext)?.getEntry(PROVENANCE_BAGGAGE_KEY)?.value;
  if (!value || value.length > MAX_PROVENANCE_BAGGAGE_VALUE_LENGTH) {
    return emptyProvenanceTags();
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? sanitizeProvenanceTags(parsed) : emptyProvenanceTags();
  } catch {
    return emptyProvenanceTags();
  }
}

export function contextWithProvenanceBaggage(
  tags: Record<string, unknown> = getProvenanceTags(),
  activeContext: Context = context.active(),
): Context {
  const baggage = propagation.getBaggage(activeContext);
  const merged = sanitizeProvenanceTags(
    {
      ...readProvenanceBaggage(activeContext),
      ...tags,
    },
    { warn: true },
  );

  if (Object.keys(merged).length === 0) {
    return baggage ? propagation.setBaggage(activeContext, baggage.removeEntry(PROVENANCE_BAGGAGE_KEY)) : activeContext;
  }

  const value = JSON.stringify(Object.fromEntries(sortedProvenanceEntries(merged)));
  if (value.length > MAX_PROVENANCE_BAGGAGE_VALUE_LENGTH || !fitsW3cBaggageMember(value)) {
    return baggage ? propagation.setBaggage(activeContext, baggage.removeEntry(PROVENANCE_BAGGAGE_KEY)) : activeContext;
  }

  const nextBaggage = (baggage ?? propagation.createBaggage()).setEntry(PROVENANCE_BAGGAGE_KEY, { value });
  return propagation.setBaggage(activeContext, nextBaggage);
}
