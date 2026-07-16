import { contextWithProvenanceBaggage, PROVENANCE_BAGGAGE_KEY, readProvenanceBaggage } from './provenance-baggage';
import { getProvenanceTags, setProvenanceTags } from './provenance-tags';
import { RequestContext } from './request-context';

import { configure, reset } from '@logtape/logtape';
import { defaultTextMapGetter, defaultTextMapSetter, propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import { W3CBaggagePropagator } from '@opentelemetry/core';
import { describe, expect, it } from 'bun:test';

import type { LogRecord } from '@logtape/logtape';
import type { Context } from '@opentelemetry/api';

function contextWithBaggage(entries: Record<string, { value: string }>): Context {
  return propagation.setBaggage(ROOT_CONTEXT, propagation.createBaggage(entries));
}

describe('provenance baggage', () => {
  it('normalizes provenance and preserves unrelated baggage entries', () => {
    const baseContext = contextWithBaggage({
      'vendor.trace': { value: 'keep' },
    });

    const propagatedContext = contextWithProvenanceBaggage(
      {
        'fixture.source': ' eval ',
        'fixture.attempt': 2,
        'fixture.synthetic': true,
      },
      baseContext,
    );

    expect(propagation.getBaggage(propagatedContext)?.getEntry('vendor.trace')).toEqual({ value: 'keep' });
    expect(readProvenanceBaggage(propagatedContext)).toEqual({
      'fixture.attempt': '2',
      'fixture.source': 'eval',
      'fixture.synthetic': 'true',
    });
    expect(propagation.getBaggage(propagatedContext)?.getEntry(PROVENANCE_BAGGAGE_KEY)?.value).toBe(
      '{"fixture.attempt":"2","fixture.source":"eval","fixture.synthetic":"true"}',
    );
  });

  it('uses the existing sanitizer for untrusted outbound tags', () => {
    const propagatedContext = contextWithProvenanceBaggage({
      'fixture.source': 'eval',
      'fixture.attempt': 2,
      'fixture.api_key': 'must-not-propagate',
      'bad key': 'invalid',
      empty: ' ',
      unsupported: { nested: true },
    });

    expect(readProvenanceBaggage(propagatedContext)).toEqual({
      'fixture.attempt': '2',
      'fixture.source': 'eval',
    });
  });

  it('survives a real W3C baggage inject and extract round trip', () => {
    const propagatedContext = contextWithProvenanceBaggage({
      'fixture.origin': 'synthetic',
      'fixture.source': 'eval',
    });
    const carrier: Record<string, string> = {};
    const propagator = new W3CBaggagePropagator();

    propagator.inject(propagatedContext, carrier, defaultTextMapSetter);
    const extractedContext = propagator.extract(ROOT_CONTEXT, carrier, defaultTextMapGetter);

    expect(carrier.baggage).toContain('provenance.tags=');
    expect(readProvenanceBaggage(extractedContext)).toEqual({
      'fixture.origin': 'synthetic',
      'fixture.source': 'eval',
    });
  });

  it('rejects malformed, non-object, and oversized inbound values without throwing', () => {
    const invalidValues = ['{', '[]', '"text"', '7', 'x'.repeat(4_097)];

    for (const value of invalidValues) {
      const tags = readProvenanceBaggage(
        contextWithBaggage({
          [PROVENANCE_BAGGAGE_KEY]: { value },
        }),
      );

      expect(tags).toEqual({});
      expect(Object.isFrozen(tags)).toBe(true);
    }
  });

  it('lets current provenance override an older propagated value', () => {
    const baseContext = contextWithProvenanceBaggage({
      'fixture.source': 'old',
      'fixture.scenario': 'case-1',
    });

    const propagatedContext = contextWithProvenanceBaggage({ 'fixture.source': 'new' }, baseContext);

    expect(readProvenanceBaggage(propagatedContext)).toEqual({
      'fixture.scenario': 'case-1',
      'fixture.source': 'new',
    });
  });

  it('does not let invalid local tags erase valid propagated provenance', () => {
    const baseContext = contextWithProvenanceBaggage({
      'fixture.source': 'eval',
    });

    const propagatedContext = contextWithProvenanceBaggage({ 'fixture.source': ' ' }, baseContext);

    expect(readProvenanceBaggage(propagatedContext)).toEqual({
      'fixture.source': 'eval',
    });
  });

  it('warns when the tag limit drops additional outbound provenance', async () => {
    const records: LogRecord[] = [];
    await configure({
      reset: true,
      sinks: {
        recorder: (record) => records.push(record),
      },
      loggers: [
        { category: [], sinks: ['recorder'], lowestLevel: 'warning' },
        { category: ['logtape', 'meta'], sinks: [] },
      ],
    });

    try {
      const fullContext = contextWithProvenanceBaggage(
        Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`upstream.tag_${index}`, String(index)])),
      );

      const propagatedContext = contextWithProvenanceBaggage({ 'local.source': 'service' }, fullContext);

      expect(readProvenanceBaggage(propagatedContext)['local.source']).toBeUndefined();
      expect(records.map((record) => record.message.map(String).join(''))).toContain(
        'Dropped 1 invalid or excess provenance tag(s)',
      );
    } finally {
      await reset();
    }
  });

  it('removes an empty provenance entry without dropping unrelated baggage', () => {
    const baseContext = contextWithBaggage({
      'vendor.trace': { value: 'keep' },
      [PROVENANCE_BAGGAGE_KEY]: { value: '{' },
    });

    const propagatedContext = contextWithProvenanceBaggage({ 'bad key': 'invalid' }, baseContext);
    const baggage = propagation.getBaggage(propagatedContext);

    expect(baggage?.getEntry(PROVENANCE_BAGGAGE_KEY)).toBeUndefined();
    expect(baggage?.getEntry('vendor.trace')).toEqual({ value: 'keep' });
  });

  it('does not create a member that the W3C propagator would drop for encoded size', () => {
    const tags = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [`fixture.tag_${index}`, '\\'.repeat(128)]),
    );

    const propagatedContext = contextWithProvenanceBaggage(tags);

    expect(propagation.getBaggage(propagatedContext)?.getEntry(PROVENANCE_BAGGAGE_KEY)).toBeUndefined();
  });

  it('normalizes inbound baggage without trusting it into request-local provenance', () => {
    const propagatedContext = contextWithProvenanceBaggage({
      'fixture.origin': 'synthetic',
      'fixture.source': 'eval',
    });

    RequestContext.run({}, () => {
      setProvenanceTags({ 'fixture.source': 'local' });

      expect(readProvenanceBaggage(propagatedContext)).toEqual({
        'fixture.origin': 'synthetic',
        'fixture.source': 'eval',
      });
      expect(getProvenanceTags()).toEqual({ 'fixture.source': 'local' });
    });
  });
});
