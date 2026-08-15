/**
 * Vertex Gemini thinking policy → HTTP request regression guard.
 *
 * Gemini 3.5 Flash-Lite has access-profile-specific evidence:
 * - Express `none` uses the live-proven `thinkingBudget: 0` switch;
 * - project/global `none` conservatively falls back to `thinkingLevel: low`;
 * - explicit low/medium/high use the official `thinkingLevel` field.
 */

import 'reflect-metadata';

import { SysEnv } from '@app/env';
import { ApiFetcher } from '@app/utils/fetch';

import { LLM } from './llm.class';
import { resetLLMClients } from './llm.clients';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { LLMModelKey } from '../types/model.types';

const sysEnvMut = SysEnv as unknown as Record<string, string | undefined>;
sysEnvMut.AI_GOOGLE_API_KEY ??= 'test-google-key';
sysEnvMut.AI_GOOGLE_VERTEX_API_KEY ??= 'test-vertex-key';
sysEnvMut.GOOGLE_VERTEX_PROJECT ??= 'test-project';
sysEnvMut.GOOGLE_VERTEX_LOCATION ??= 'global';

const originalFetch = ApiFetcher.fetch;
let capturedBodies: unknown[] = [];

beforeEach(() => {
  capturedBodies = [];
  (ApiFetcher as unknown as { fetch: typeof fetch }).fetch = (async (
    _url: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (typeof init?.body === 'string') capturedBodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ error: { code: 400, message: 'mock-fetch' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  resetLLMClients();
});

afterEach(() => {
  (ApiFetcher as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  resetLLMClients();
});

async function captureThinkingConfig(model: LLMModelKey, thinking: 'none' | 'low'): Promise<unknown> {
  capturedBodies = [];
  try {
    await LLM.generateText({
      id: `vertex-thinking-${model}-${thinking}`,
      model,
      messages: [{ role: 'user', content: 'test' }],
      thinking,
      maxRetries: 0,
    });
  } catch {
    // The mock response deliberately fails after the request has been captured.
  }

  expect(capturedBodies.length).toBeGreaterThanOrEqual(1);
  const body = capturedBodies[0] as { generationConfig?: { thinkingConfig?: unknown } };
  return body.generationConfig?.thinkingConfig;
}

describe('LLM Vertex Gemini 3.5 Flash-Lite thinking requests', () => {
  it('does not extend Express no-thinking evidence to project/global', async () => {
    expect(await captureThinkingConfig('vertex:gemini-3.5-flash-lite', 'none')).toEqual({ thinkingBudget: 0 });
    expect(await captureThinkingConfig('vertex-global:gemini-3.5-flash-lite', 'none')).toEqual({
      thinkingLevel: 'low',
    });
  });

  it('uses thinkingLevel minimal for Google 3.6 none, not thinkingBudget zero', async () => {
    expect(await captureThinkingConfig('google:gemini-3.6-flash', 'none')).toEqual({ thinkingLevel: 'minimal' });
    expect(await captureThinkingConfig('vertex:gemini-3.6-flash', 'none')).toEqual({ thinkingBudget: 0 });
  });

  it('emits thinkingLevel for non-none effort on both access profiles', async () => {
    for (const model of [
      'vertex:gemini-3.5-flash-lite',
      'vertex-global:gemini-3.5-flash-lite',
    ] as const satisfies readonly LLMModelKey[]) {
      expect(await captureThinkingConfig(model, 'low')).toEqual({ thinkingLevel: 'low' });
    }
  });
});
