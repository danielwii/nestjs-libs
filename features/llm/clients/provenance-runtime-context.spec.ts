import 'reflect-metadata';

import { contextWithProvenanceBaggage, readProvenanceBaggage } from '@app/nest/trace/provenance-baggage';
import { setProvenanceTags } from '@app/nest/trace/provenance-tags';
import { RequestContext } from '@app/nest/trace/request-context';

import { mergeProvenanceRuntimeContext } from './llm.class';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

describe('LLM provenance runtime context', () => {
  it('appends request provenance after caller runtime tags', () => {
    RequestContext.run({}, () => {
      setProvenanceTags({
        'sandbox.client_type': 'browser',
        'sandbox.token': 'drop',
      });

      expect(
        mergeProvenanceRuntimeContext({
          parentObservationId: 'parent-1',
          tags: ['task:reply'],
        }),
      ).toEqual({
        parentObservationId: 'parent-1',
        tags: ['task:reply', 'sandbox.client_type:browser'],
      });
    });
  });

  it('does not create runtime context outside RequestContext when caller context has no tags', () => {
    const callerContext = { parentObservationId: 'parent-1' };

    expect(mergeProvenanceRuntimeContext(callerContext)).toBe(callerContext);
  });

  it('projects propagated provenance into AI SDK v7 runtime context', () => {
    const propagatedContext = contextWithProvenanceBaggage({
      'fixture.origin': 'synthetic',
      'fixture.source': 'eval',
    });

    const normalizedBaggage = readProvenanceBaggage(propagatedContext);
    const runtimeContext = RequestContext.run({}, () => {
      // Boundary acceptance is explicit: normalization alone does not establish source trust.
      setProvenanceTags(normalizedBaggage);
      return mergeProvenanceRuntimeContext({
        tags: ['task:reply'],
      });
    });

    expect(runtimeContext).toEqual({
      tags: ['task:reply', 'fixture.origin:synthetic', 'fixture.source:eval'],
    });
  });

  it('keeps LLM client provenance formatting independent from tracing span helpers', () => {
    const llmClass = readFileSync(join(import.meta.dir, 'llm.class.ts'), 'utf8');
    const provenanceContext = readFileSync(
      join(import.meta.dir, '../../../nest/src/trace/provenance-context.ts'),
      'utf8',
    );
    const provenanceFormat = readFileSync(
      join(import.meta.dir, '../../../nest/src/trace/provenance-format.ts'),
      'utf8',
    );

    expect(llmClass).not.toContain('@app/nest/trace/provenance-tags');
    expect(llmClass).toContain('@app/nest/trace/provenance-context');
    expect(provenanceContext).not.toContain('@opentelemetry/api');
    expect(provenanceFormat).not.toContain('@opentelemetry/api');
  });
});
