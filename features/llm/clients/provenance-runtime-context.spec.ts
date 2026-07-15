import 'reflect-metadata';

import { SysEnv } from '@app/env';
import { setProvenanceTags } from '@app/nest/trace/provenance-tags';
import { RequestContext } from '@app/nest/trace/request-context';

import { llm } from './auto.client';
import { mergeProvenanceRuntimeContext } from './llm.class';
import { resetLLMClients } from './llm.clients';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

interface LLMBuilderTestAccess {
  _buildTelemetryRuntimeContext(): unknown;
}

const sysEnvMut = SysEnv as unknown as Record<string, string | undefined>;
const originalSysEnv = {
  GOOGLE_VERTEX_PROJECT: sysEnvMut.GOOGLE_VERTEX_PROJECT,
  GOOGLE_VERTEX_LOCATION: sysEnvMut.GOOGLE_VERTEX_LOCATION,
  GOOGLE_CLOUD_PROJECT: sysEnvMut.GOOGLE_CLOUD_PROJECT,
  GOOGLE_CLOUD_LOCATION: sysEnvMut.GOOGLE_CLOUD_LOCATION,
};
const originalProcessGoogleVertexApiKey = process.env.GOOGLE_VERTEX_API_KEY;

beforeEach(() => {
  sysEnvMut.GOOGLE_VERTEX_PROJECT = 'test-project';
  sysEnvMut.GOOGLE_VERTEX_LOCATION = 'global';
  delete sysEnvMut.GOOGLE_CLOUD_PROJECT;
  delete sysEnvMut.GOOGLE_CLOUD_LOCATION;
  process.env.GOOGLE_VERTEX_API_KEY = 'test-express-mode-key';
  resetLLMClients();
});

afterEach(() => {
  sysEnvMut.GOOGLE_VERTEX_PROJECT = originalSysEnv.GOOGLE_VERTEX_PROJECT;
  sysEnvMut.GOOGLE_VERTEX_LOCATION = originalSysEnv.GOOGLE_VERTEX_LOCATION;
  sysEnvMut.GOOGLE_CLOUD_PROJECT = originalSysEnv.GOOGLE_CLOUD_PROJECT;
  sysEnvMut.GOOGLE_CLOUD_LOCATION = originalSysEnv.GOOGLE_CLOUD_LOCATION;
  if (originalProcessGoogleVertexApiKey === undefined) {
    delete process.env.GOOGLE_VERTEX_API_KEY;
  } else {
    process.env.GOOGLE_VERTEX_API_KEY = originalProcessGoogleVertexApiKey;
  }
  resetLLMClients();
});

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

  it('adds provenance tags to the deprecated builder telemetry runtime context', () => {
    RequestContext.run({}, () => {
      setProvenanceTags({
        'origin.channel': 'api',
        'sandbox.client_type': 'browser',
      });

      const builder = llm('vertex-global:gemini-2.5-flash').telemetry({
        userId: 'user-1',
        tags: ['task:reply'],
      }) as unknown as LLMBuilderTestAccess;

      expect(builder._buildTelemetryRuntimeContext()).toEqual({
        userId: 'user-1',
        tags: ['task:reply', 'origin.channel:api', 'sandbox.client_type:browser'],
      });
    });
  });

  it('keeps LLM client provenance formatting independent from tracing span helpers', () => {
    const autoClient = readFileSync(join(import.meta.dir, 'auto.client.ts'), 'utf8');
    const llmClass = readFileSync(join(import.meta.dir, 'llm.class.ts'), 'utf8');
    const provenanceContext = readFileSync(
      join(import.meta.dir, '../../../nest/src/trace/provenance-context.ts'),
      'utf8',
    );
    const provenanceFormat = readFileSync(
      join(import.meta.dir, '../../../nest/src/trace/provenance-format.ts'),
      'utf8',
    );

    expect(autoClient).not.toContain('@app/nest/trace/provenance-tags');
    expect(llmClass).not.toContain('@app/nest/trace/provenance-tags');
    expect(autoClient).toContain('@app/nest/trace/provenance-context');
    expect(llmClass).toContain('@app/nest/trace/provenance-context');
    expect(provenanceContext).not.toContain('@opentelemetry/api');
    expect(provenanceFormat).not.toContain('@opentelemetry/api');
  });
});
