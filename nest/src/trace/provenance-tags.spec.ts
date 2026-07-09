import {
  applyProvenanceToActiveSpan,
  applyProvenanceToSpan,
  clearProvenanceTags,
  getActiveSpanLlmTags,
  getProvenanceTags,
  mergeProvenanceLlmTags,
  mergeProvenanceTags,
  sanitizeProvenanceTags,
  setProvenanceTags,
  toProvenanceLlmTags,
  toProvenanceLogTags,
  withActiveSpanLlmTags,
} from './provenance-tags';
import { RequestContext } from './request-context';

import { context } from '@opentelemetry/api';
import { describe, expect, it } from 'bun:test';

import type { Span } from '@opentelemetry/api';

function captureSpan() {
  const attributes: Record<string, unknown> = {};
  const span = {
    setAttribute: (key: string, value: unknown) => {
      attributes[key] = value;
      return span;
    },
  } as unknown as Span;

  return { span, attributes };
}

describe('provenance tag sanitization', () => {
  it('accepts valid namespaced scalar tags and sorts keys deterministically', () => {
    const input = {
      'origin.channel': ' api ',
      'sandbox.run_id': 123,
      'sandbox.enabled': true,
    };

    expect(sanitizeProvenanceTags(input)).toEqual({
      'origin.channel': 'api',
      'sandbox.enabled': 'true',
      'sandbox.run_id': '123',
    });
    expect(input['origin.channel']).toBe(' api ');
  });

  it('drops invalid keys, empty values, objects, arrays, and sensitive keys', () => {
    expect(
      sanitizeProvenanceTags({
        sandbox: 'missing namespace',
        'Sandbox.client_type': 'uppercase',
        'sandbox.client-type': 'illegal char',
        'sandbox.empty': '   ',
        'sandbox.object': { raw: true },
        'sandbox.array': ['raw'],
        'sandbox.token': 'secret-token',
        'sandbox.access_token': 'access-token',
        'sandbox.refresh_token': 'refresh-token',
        'sandbox.csrf_token': 'csrf-token',
        'sandbox.cookie': 'session=raw',
        'sandbox.client_type': 'browser',
      }),
    ).toEqual({
      'sandbox.client_type': 'browser',
    });
  });

  it('enforces key length, value length, and max tag count', () => {
    const tooLongKey = `sandbox.${'x'.repeat(80)}`;
    const input: Record<string, unknown> = {
      [tooLongKey]: 'drop',
      'sandbox.too_long': 'x'.repeat(257),
    };

    for (let i = 0; i < 20; i += 1) {
      input[`k${i}.v`] = i;
    }

    const result = sanitizeProvenanceTags(input);

    expect(result[tooLongKey]).toBeUndefined();
    expect(result['sandbox.too_long']).toBeUndefined();
    expect(Object.keys(result)).toHaveLength(16);
    expect(result['k0.v']).toBe('0');
    expect(result['k15.v']).toBe('15');
    expect(result['k16.v']).toBeUndefined();
  });
});

describe('RequestContext provenance tags', () => {
  it('stores, merges, and clears sanitized tags inside RequestContext', () => {
    RequestContext.run({}, () => {
      setProvenanceTags({
        'sandbox.client_type': 'browser',
        'sandbox.token': 'drop',
      });

      expect(getProvenanceTags()).toEqual({
        'sandbox.client_type': 'browser',
      });

      mergeProvenanceTags({
        'origin.channel': 'api',
        'sandbox.client_type': 'worker',
      });

      expect(getProvenanceTags()).toEqual({
        'origin.channel': 'api',
        'sandbox.client_type': 'worker',
      });

      clearProvenanceTags();
      expect(getProvenanceTags()).toEqual({});
    });
  });

  it('no-ops outside RequestContext', () => {
    setProvenanceTags({ 'sandbox.client_type': 'browser' });
    mergeProvenanceTags({ 'origin.channel': 'api' });
    clearProvenanceTags();

    expect(getProvenanceTags()).toEqual({});
  });
});

describe('provenance projections', () => {
  it('creates log tags and LLM tags with stable formatting', () => {
    const tags = {
      'origin.channel': 'api',
      'sandbox.client_type': 'browser',
    };

    expect(toProvenanceLogTags(tags)).toEqual([
      'provenance:origin.channel=api',
      'provenance:sandbox.client_type=browser',
    ]);
    expect(toProvenanceLlmTags(tags)).toEqual(['origin.channel:api', 'sandbox.client_type:browser']);
  });

  it('merges provenance LLM tags after caller tags without mutating caller tags', () => {
    const callerTags = ['task:reply'];
    const result = mergeProvenanceLlmTags(callerTags, {
      'sandbox.client_type': 'browser',
    });

    expect(result).toEqual(['task:reply', 'sandbox.client_type:browser']);
    expect(callerTags).toEqual(['task:reply']);
  });

  it('applies provenance to a span as attributes and AI telemetry tags', () => {
    const { span, attributes } = captureSpan();

    applyProvenanceToSpan(span, {
      'sandbox.client_type': 'browser',
    });

    expect(attributes['provenance.sandbox.client_type']).toBe('browser');
    expect(attributes['ai.telemetry.metadata.tags']).toEqual(['sandbox.client_type:browser']);
  });

  it('appends span AI telemetry tags after existing caller tags', () => {
    const { span, attributes } = captureSpan();

    applyProvenanceToSpan(
      span,
      {
        'sandbox.client_type': 'browser',
      },
      ['task:reply'],
    );

    expect(attributes['ai.telemetry.metadata.tags']).toEqual(['task:reply', 'sandbox.client_type:browser']);
  });

  it('does not throw when no active span exists', () => {
    expect(() => applyProvenanceToActiveSpan({ 'sandbox.client_type': 'browser' })).not.toThrow();
  });

  it('scopes active span caller tags per OTel context', () => {
    const base = context.active();
    const taskContext = withActiveSpanLlmTags(base, ['task:reply']);
    const reviewContext = withActiveSpanLlmTags(base, ['task:review']);

    expect(getActiveSpanLlmTags(taskContext)).toEqual(['task:reply']);
    expect(getActiveSpanLlmTags(reviewContext)).toEqual(['task:review']);
    expect(getActiveSpanLlmTags(base)).toEqual([]);
  });

  it('does not inherit caller tags when a child OTel context has no span tags', () => {
    const parentContext = withActiveSpanLlmTags(context.active(), ['task:reply']);
    const childContext = withActiveSpanLlmTags(parentContext, undefined);

    expect(getActiveSpanLlmTags(parentContext)).toEqual(['task:reply']);
    expect(getActiveSpanLlmTags(childContext)).toEqual([]);
  });
});
