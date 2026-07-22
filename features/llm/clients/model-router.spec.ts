import 'reflect-metadata';

import { SysEnv } from '@app/env';

import { LLM } from './llm.class';
import { resetLLMClients } from './llm.clients';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { LLMModelSpec } from '../types/model.types';

interface InspectableLanguageModel {
  provider: string;
  modelId: string;
}

const sysEnvMut = SysEnv as unknown as Record<string, string | undefined>;
const ENV_KEYS = [
  'AI_OPENROUTER_API_KEY',
  'AI_GOOGLE_API_KEY',
  'AI_GOOGLE_VERTEX_API_KEY',
  'GOOGLE_VERTEX_PROJECT',
  'GOOGLE_VERTEX_LOCATION',
  'AI_BEDROCK_API_KEY',
] as const;
let originalEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
  originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, sysEnvMut[key]])) as typeof originalEnv;
  sysEnvMut.AI_OPENROUTER_API_KEY = 'test-openrouter-key';
  sysEnvMut.AI_GOOGLE_API_KEY = 'test-google-key';
  sysEnvMut.AI_GOOGLE_VERTEX_API_KEY = 'test-vertex-key';
  sysEnvMut.GOOGLE_VERTEX_PROJECT = 'test-project';
  sysEnvMut.GOOGLE_VERTEX_LOCATION = 'global';
  sysEnvMut.AI_BEDROCK_API_KEY = 'test-bedrock-key';
  resetLLMClients();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete sysEnvMut[key];
    else sysEnvMut[key] = originalEnv[key];
  }
  resetLLMClients();
});

describe('LLM.model registered-model routing', () => {
  it('routes every supported provider through the sole public direct-model boundary', () => {
    const cases: Array<{
      key: LLMModelSpec;
      provider: string;
      modelId: string;
    }> = [
      { key: 'openrouter:gemini-2.5-flash', provider: 'openrouter', modelId: 'google/gemini-2.5-flash' },
      { key: 'google:gemini-2.5-flash', provider: 'google.generative-ai', modelId: 'gemini-2.5-flash' },
      { key: 'vertex:gemini-2.5-flash', provider: 'google.vertex.chat', modelId: 'gemini-2.5-flash' },
      {
        key: 'vertex-global:gemini-2.5-flash',
        provider: 'google.vertex.chat',
        modelId: 'gemini-2.5-flash',
      },
      {
        key: 'bedrock:claude-haiku-4.5',
        provider: 'amazon-bedrock',
        modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      },
    ];

    for (const expected of cases) {
      const languageModel = LLM.model(expected.key) as unknown as InspectableLanguageModel;
      expect({ provider: languageModel.provider, modelId: languageModel.modelId }).toEqual({
        provider: expected.provider,
        modelId: expected.modelId,
      });
    }
  });

  it('normalizes model-spec query parameters before routing', () => {
    const languageModel = LLM.model(
      'vertex:gemini-2.5-flash?reason=low&retry=1',
    ) as unknown as InspectableLanguageModel;

    expect(languageModel.modelId).toBe('gemini-2.5-flash');
  });
});
