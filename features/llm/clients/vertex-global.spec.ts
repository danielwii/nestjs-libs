import 'reflect-metadata';

import { SysEnv } from '@app/env';

import { getProvider } from '../types/model.types';
import { LLM } from './llm.class';
import { resetLLMClients } from './llm.clients';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

interface InspectableLanguageModel {
  config?: {
    baseURL?: string;
  };
}

const sysEnvMut = SysEnv as unknown as Record<string, string | undefined>;

const originalSysEnv = {
  AI_GOOGLE_VERTEX_API_KEY: sysEnvMut.AI_GOOGLE_VERTEX_API_KEY,
  GOOGLE_VERTEX_PROJECT: sysEnvMut.GOOGLE_VERTEX_PROJECT,
  GOOGLE_VERTEX_LOCATION: sysEnvMut.GOOGLE_VERTEX_LOCATION,
};

beforeEach(() => {
  sysEnvMut.AI_GOOGLE_VERTEX_API_KEY = 'test-express-mode-key';
  sysEnvMut.GOOGLE_VERTEX_PROJECT = 'test-project';
  sysEnvMut.GOOGLE_VERTEX_LOCATION = 'global';
  resetLLMClients();
});

afterEach(() => {
  sysEnvMut.AI_GOOGLE_VERTEX_API_KEY = originalSysEnv.AI_GOOGLE_VERTEX_API_KEY;
  sysEnvMut.GOOGLE_VERTEX_PROJECT = originalSysEnv.GOOGLE_VERTEX_PROJECT;
  sysEnvMut.GOOGLE_VERTEX_LOCATION = originalSysEnv.GOOGLE_VERTEX_LOCATION;
  resetLLMClients();
});

describe('vertex-global provider routing', () => {
  it('resolves a registered vertex-global route as its own provider', () => {
    expect(getProvider('vertex-global:gemini-2.5-flash')).toBe('vertex-global');
  });

  it('uses the project/global v1 Vertex endpoint even when a Vertex API key is present', () => {
    const languageModel = LLM.model('vertex-global:gemini-2.5-flash') as unknown as InspectableLanguageModel;

    expect(languageModel.config?.baseURL).toBe(
      'https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/google',
    );
  });

  it('rejects non-global locations because Priority PayGo only supports global', () => {
    sysEnvMut.GOOGLE_VERTEX_LOCATION = 'us-central1';
    resetLLMClients();

    expect(() => LLM.model('vertex-global:gemini-2.5-flash')).toThrow(/requires GOOGLE_VERTEX_LOCATION=global/);
  });
});
