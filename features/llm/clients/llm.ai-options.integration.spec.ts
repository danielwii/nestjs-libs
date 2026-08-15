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
let responseStatuses: number[] = [];
let streamResponse: string | undefined;
const originalFetch = ApiFetcher.fetch;

beforeEach(() => {
  capturedRequests = [];
  responseStatuses = [400];
  streamResponse = undefined;
  (ApiFetcher as unknown as { fetch: typeof fetch }).fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    capturedRequests.push({
      url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

    if (streamResponse !== undefined) {
      return new Response(streamResponse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }

    const status = responseStatuses.shift() ?? 400;
    return new Response(JSON.stringify({ error: { code: 400, message: 'mock-fetch' } }), {
      status,
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
  execute: async ({ city }) => ({ city }),
});

function openRouterToolStream(): string {
  const chunks = [
    {
      id: 'chatcmpl-stop-when',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'fixture-model',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call-stop-when',
                type: 'function',
                function: { name: 'lookup', arguments: '' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'chatcmpl-stop-when',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'fixture-model',
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Taipei"}' } }] },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'chatcmpl-stop-when',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'fixture-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    },
  ];

  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
}

describe('LLM ai namespace', () => {
  it('passes the canonical stopWhen condition to AI SDK execution', async () => {
    streamResponse = openRouterToolStream();
    let stopChecks = 0;

    const stream = LLM.streamText({
      id: 'ai-stop-when',
      model: 'openrouter:grok-4.3',
      messages: SIMPLE_MESSAGE,
      maxRetries: 0,
      ai: {
        tools: { lookup: lookupTool },
        stopWhen: () => {
          stopChecks += 1;
          return true;
        },
      },
    });

    for await (const _chunk of stream.textStream) {
      // consume the provider stream so AI SDK evaluates the stop condition
    }

    expect(stopChecks).toBe(1);
  });

  it('generateText passes ai.tools and ai.toolChoice to AI SDK', async () => {
    await callIgnoringError(() =>
      LLM.generateText({
        id: 'ai-generateText-tools',
        model: 'openrouter:grok-4.3',
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
        model: 'openrouter:grok-4.3',
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
        model: 'openrouter:grok-4.3',
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
        ai: {
          prepareStep: () => ({
            llm: { model: 'vertex:gemini-2.5-flash?vertex.tier=priority' },
          }),
        },
      }),
    );

    expect(capturedRequests.length).toBeGreaterThanOrEqual(1);
    const first = capturedRequests[0]!;
    expect(first.url).toContain('aiplatform.googleapis.com');
    expect(first.headers.get(VERTEX_TIER_HEADER)).toBeNull();
  });

  it('prepareStep.llm without model keeps the current fallback attempt model', async () => {
    responseStatuses = [500, 400];

    await callIgnoringError(() =>
      LLM.generateText({
        id: 'ai-prepareStep-fallback-attempt',
        model: 'openrouter:grok-4.3?fallback=vertex:gemini-2.5-flash',
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
        ai: {
          prepareStep: () => ({
            llm: { thinking: 'low' },
          }),
        },
      }),
    );

    expect(capturedRequests.length).toBeGreaterThanOrEqual(2);
    expect(capturedRequests[0]!.url).toContain('openrouter.ai');
    expect(capturedRequests[1]!.url).toContain('aiplatform.googleapis.com');
  });

  it('model spec openrouter.routing=bedrock emits Bedrock-only provider routing', async () => {
    await callIgnoringError(() =>
      LLM.generateText({
        id: 'ai-openrouter-routing-bedrock',
        model: 'openrouter:claude-sonnet-4.5?openrouter.routing=bedrock',
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
      }),
    );

    const body = firstJsonBody();
    expect(body.provider).toEqual({
      only: ['amazon-bedrock'],
      allow_fallbacks: false,
    });
  });

  it('call-level openrouter provider routing overrides model spec routing', async () => {
    await callIgnoringError(() =>
      LLM.generateText({
        id: 'ai-openrouter-routing-call-override',
        model: 'openrouter:claude-sonnet-4.5?openrouter.routing=latency',
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
        openrouter: {
          provider: {
            only: ['amazon-bedrock'],
            allowFallbacks: false,
          },
        },
      }),
    );

    const body = firstJsonBody();
    expect(body.provider).toEqual({
      only: ['amazon-bedrock'],
      allow_fallbacks: false,
    });
  });

  it('call-level openrouter.provider.sort emits OpenRouter provider.sort', async () => {
    await callIgnoringError(() =>
      LLM.generateText({
        id: 'ai-openrouter-provider-sort',
        model: 'openrouter:claude-sonnet-4.5',
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
        openrouter: { provider: { sort: 'latency' } },
      }),
    );

    const body = firstJsonBody();
    expect(body.provider).toEqual({ sort: 'latency' });
  });

  it('prepareStep.llm.openrouter overrides current OpenRouter routing', async () => {
    await callIgnoringError(() =>
      LLM.generateText({
        id: 'ai-prepareStep-openrouter-routing',
        model: 'openrouter:claude-sonnet-4.5?openrouter.routing=latency',
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
        ai: {
          prepareStep: () => ({
            llm: {
              openrouter: {
                provider: {
                  only: ['amazon-bedrock'],
                  allowFallbacks: false,
                },
              },
            },
          }),
        },
      }),
    );

    const body = firstJsonBody();
    const provider = body.provider as Record<string, unknown>;
    expect(provider.only).toEqual(['amazon-bedrock']);
    expect(provider.allow_fallbacks).toBe(false);
  });
});
