import type { Span } from '@opentelemetry/api';

export interface AttributesSpan extends Span {
  attributes: Record<string, any>;
}
