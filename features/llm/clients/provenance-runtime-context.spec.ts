import 'reflect-metadata';

import { SysEnv } from '@app/env';
import { setProvenanceTags } from '@app/nest/trace/provenance-tags';
import { RequestContext } from '@app/nest/trace/request-context';

import { llm } from './auto.client';
import { mergeProvenanceRuntimeContext } from './llm.class';
import { resetLLMClients } from './llm.clients';

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
});
