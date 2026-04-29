import 'reflect-metadata';

import { SysEnv } from '@app/env';

import { model, parseProvider } from './auto.client';
import { resetLLMClients } from './llm.clients';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

interface InspectableLanguageModel {
  config?: {
    baseURL?: string;
  };
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

describe('vertex-global provider routing', () => {
  it('parses vertex-global as its own provider', () => {
    expect(parseProvider('vertex-global:gemini-2.5-flash')).toBe('vertex-global');
    expect(parseProvider('vertex-global')).toBe('vertex-global');
  });

  it('uses the project/global v1 Vertex endpoint even when a Vertex API key is present', () => {
    const languageModel = model('vertex-global:gemini-2.5-flash') as unknown as InspectableLanguageModel;

    expect(languageModel.config?.baseURL).toBe(
      'https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/google',
    );
  });

  it('rejects non-global locations because Priority PayGo only supports global', () => {
    sysEnvMut.GOOGLE_VERTEX_LOCATION = 'us-central1';
    resetLLMClients();

    expect(() => model('vertex-global:gemini-2.5-flash')).toThrow(/requires GOOGLE_VERTEX_LOCATION=global/);
  });
});
