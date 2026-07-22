/**
 * Vertex Gemini thinking policy → HTTP request regression guard.
 *
 * Gemini 3.5 Flash-Lite uses a mixed provider contract:
 * - public `none` intent uses the Vertex-compatible `thinkingBudget: 0` switch;
 * - low/medium/high use the official `thinkingLevel` field.
 *
 * Both Vertex access profiles must emit the same thinking configuration.
 */

import 'reflect-metadata';

import { SysEnv } from '@app/env';
import { ApiFetcher } from '@app/utils/fetch';

import { LLM } from './llm.class';
import { resetLLMClients } from './llm.clients';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { LLMModelKey } from '../types/model.types';

const sysEnvMut = SysEnv as unknown as Record<string, string | undefined>;
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

const FLASH_LITE_VERTEX_KEYS = [
  'vertex:gemini-3.5-flash-lite',
  'vertex-global:gemini-3.5-flash-lite',
] as const satisfies readonly LLMModelKey[];

describe('LLM Vertex Gemini 3.5 Flash-Lite thinking requests', () => {
  it('emits thinkingBudget=0 for no-thinking on both access profiles', async () => {
    for (const model of FLASH_LITE_VERTEX_KEYS) {
      expect(await captureThinkingConfig(model, 'none')).toEqual({ thinkingBudget: 0 });
    }
  });

  it('emits thinkingLevel for non-none effort on both access profiles', async () => {
    for (const model of FLASH_LITE_VERTEX_KEYS) {
      expect(await captureThinkingConfig(model, 'low')).toEqual({ thinkingLevel: 'low' });
    }
  });
});
