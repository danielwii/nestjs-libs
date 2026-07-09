/**
 * LLM `ai` namespace integration tests.
 *
 * These tests mock the shared ApiFetcher so they verify the request boundary
 * without calling external providers.
 */

import 'reflect-metadata';

import { SysEnv } from '@app/env';
import { ApiFetcher } from '@app/utils/fetch';

import { LLM, VERTEX_TIER_HEADER } from './llm.class';
import { resetLLMClients } from './llm.clients';

import { tool } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

const sysEnvMut = SysEnv as unknown as Record<string, string | undefined>;
sysEnvMut.AI_OPENROUTER_API_KEY ??= 'test-openrouter-key';
sysEnvMut.AI_GOOGLE_VERTEX_API_KEY ??= 'test-vertex-key';

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: string | undefined;
}

let capturedRequests: CapturedRequest[] = [];
const originalFetch = ApiFetcher.fetch;

beforeEach(() => {
  capturedRequests = [];
  (ApiFetcher as unknown as { fetch: typeof fetch }).fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    capturedRequests.push({
      url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

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

async function callIgnoringError(fn: () => Promise<unknown> | unknown): Promise<void> {
  try {
    const res = fn();
    if (res && typeof (res as Promise<unknown>).then === 'function') {
      await res;
    }
  } catch {
    // mock fetch returns 400; tests only assert the emitted request.
  }
}

function firstJsonBody(): Record<string, unknown> {
  expect(capturedRequests.length).toBeGreaterThanOrEqual(1);
  const body = capturedRequests[0]?.body;
  expect(body).toBeDefined();
  return JSON.parse(body!) as Record<string, unknown>;
}

const SIMPLE_MESSAGE = [{ role: 'user' as const, content: 'test' }];
const lookupTool = tool({
  description: 'Lookup a city',
  inputSchema: z.object({ city: z.string() }),
});

describe('LLM ai namespace', () => {
  it('generateText passes ai.tools and ai.toolChoice to AI SDK', async () => {
    await callIgnoringError(() =>
      LLM.generateText({
        id: 'ai-generateText-tools',
        model: 'openrouter:grok-4.1-fast',
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
        ai: {
          tools: { lookup: lookupTool },
          toolChoice: { type: 'tool', toolName: 'lookup' },
        },
      }),
    );

    const body = firstJsonBody();
    expect(body.tools).toBeArray();
    expect(JSON.stringify(body.tools)).toContain('lookup');
    expect(JSON.stringify(body.tool_choice)).toContain('lookup');
  });

  it('streamText passes ai.tools and ai.toolChoice to AI SDK', async () => {
    await callIgnoringError(async () => {
      const stream = LLM.streamText({
        id: 'ai-streamText-tools',
        model: 'openrouter:grok-4.1-fast',
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
        ai: {
          tools: { lookup: lookupTool },
          toolChoice: { type: 'tool', toolName: 'lookup' },
        },
      });

      for await (const _chunk of stream.textStream) {
        // consume stream to trigger fetch
      }
    });

    const body = firstJsonBody();
    expect(body.tools).toBeArray();
    expect(JSON.stringify(body.tools)).toContain('lookup');
    expect(JSON.stringify(body.tool_choice)).toContain('lookup');
  });

  it('prepareStep.llm.model is translated through LLM model routing and ignores step-level tier headers', async () => {
    await callIgnoringError(() =>
      LLM.generateText({
        id: 'ai-prepareStep-llm-model',
        model: 'openrouter:grok-4.1-fast',
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
        ai: {
          prepareStep: () => ({
            llm: { model: 'vertex:gemini-2.5-flash?tier=priority' },
          }),
        },
      }),
    );

    expect(capturedRequests.length).toBeGreaterThanOrEqual(1);
    const first = capturedRequests[0]!;
    expect(first.url).toContain('aiplatform.googleapis.com');
    expect(first.headers.get(VERTEX_TIER_HEADER)).toBeNull();
  });
});
