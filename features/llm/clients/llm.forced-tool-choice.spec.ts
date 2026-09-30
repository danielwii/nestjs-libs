/**
 * Forced tool choice on a mandatory-reasoning Anthropic-family model (supportsForcedToolChoice, model.types.ts).
 *
 * Mocks the shared ApiFetcher, so the request boundary is asserted without calling a provider: what `toolChoice` the
 * request carries, what comes back for a tool call and for text only, and that a refused call never reaches the network.
 */

import 'reflect-metadata';

import { SysEnv } from '@app/env';
import { ApiFetcher } from '@app/utils/fetch';

import { LLM } from './llm.class';
import { resetLLMClients } from './llm.clients';

import { tool } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

const sysEnvMut = SysEnv as unknown as Record<string, string | undefined>;
sysEnvMut.AI_OPENROUTER_API_KEY ??= 'test-openrouter-key';

const UNSUPPORTED = 'openrouter:claude-sonnet-5.5'; // reasoningRequired + Anthropic family
const SUPPORTED = 'openrouter:claude-sonnet-5'; // reasoning optional: forced tool choice accepted
const MESSAGES = [{ role: 'user' as const, content: 'extract the city' }];
const schema = z.object({ city: z.string() });
const lookupTool = tool({ description: 'Lookup a city', inputSchema: schema, execute: async ({ city }) => ({ city }) });

let requests: { body: Record<string, unknown> }[] = [];
let respond: () => Response;
const originalFetch = ApiFetcher.fetch;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const usage = { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 };
const toolCallResponse = () =>
  json({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model: 'fixture-model',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call-1', type: 'function', function: { name: 'extract', arguments: '{"city":"Taipei"}' } },
          ],
        },
      },
    ],
    usage,
  });
const textOnlyResponse = () =>
  json({
    id: 'chatcmpl-2',
    object: 'chat.completion',
    created: 0,
    model: 'fixture-model',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'The city is Taipei.' } }],
    usage,
  });

beforeEach(() => {
  requests = [];
  respond = toolCallResponse;
  (ApiFetcher as unknown as { fetch: typeof fetch }).fetch = (async (_url: unknown, init?: RequestInit) => {
    requests.push({ body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return respond();
  }) as typeof fetch;
  resetLLMClients();
});

afterEach(() => {
  (ApiFetcher as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  resetLLMClients();
});

describe('generateObjectViaTool on a model that rejects a forced tool choice', () => {
  it('M2 sends toolChoice auto with the single tool, and returns the object when that tool is called', async () => {
    const result = await LLM.generateObjectViaTool({
      id: 'forced-tool-unsupported',
      model: UNSUPPORTED,
      schema,
      messages: MESSAGES,
      maxRetries: 0,
    });

    expect(result.object).toEqual({ city: 'Taipei' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.tool_choice).toBe('auto');
    expect((requests[0]!.body.tools as unknown[]).length).toBe(1);
  });

  it('M2 returns the typed generation error when only text comes back: no object parsed from the text, no retry', async () => {
    respond = textOnlyResponse;
    await expect(
      LLM.generateObjectViaTool({
        id: 'forced-tool-text-only',
        model: UNSUPPORTED,
        schema,
        messages: MESSAGES,
        maxRetries: 2,
      }),
    ).rejects.toMatchObject({ oopsCode: 'AI04', internalDetails: expect.stringContaining('no-tool-call') });
    expect(requests).toHaveLength(1);
  });

  it('M2 leaves a supporting model unchanged: the request still forces the tool', async () => {
    await LLM.generateObjectViaTool({
      id: 'forced-tool-supported',
      model: SUPPORTED,
      schema,
      messages: MESSAGES,
      maxRetries: 0,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.tool_choice).toEqual({ type: 'function', function: { name: 'extract' } });
  });
});

describe('generateText with a forced tool choice', () => {
  it('M3 refuses required on an unsupported model before any request, naming the model and the rule', async () => {
    await expect(
      LLM.generateText({
        id: 'forced-required-unsupported',
        model: UNSUPPORTED,
        messages: MESSAGES,
        maxRetries: 0,
        ai: { tools: { lookup: lookupTool }, toolChoice: 'required' },
      }),
    ).rejects.toMatchObject({
      oopsCode: 'AI05',
      internalDetails: expect.stringMatching(/claude-sonnet-5\.5.*toolChoice=required.*supportsForcedToolChoice/),
    });
    expect(requests).toHaveLength(0);
  });

  it('M3 refuses a named tool on an unsupported model before any request', async () => {
    await expect(
      LLM.generateText({
        id: 'forced-named-unsupported',
        model: UNSUPPORTED,
        messages: MESSAGES,
        maxRetries: 0,
        ai: { tools: { lookup: lookupTool }, toolChoice: { type: 'tool', toolName: 'lookup' } },
      }),
    ).rejects.toMatchObject({ oopsCode: 'AI05', internalDetails: expect.stringContaining('toolChoice=tool:lookup') });
    expect(requests).toHaveLength(0);
  });

  it('M3 lets auto through on an unsupported model, unchanged', async () => {
    await LLM.generateText({
      id: 'forced-auto-unsupported',
      model: UNSUPPORTED,
      messages: MESSAGES,
      maxRetries: 0,
      ai: { tools: { lookup: lookupTool }, toolChoice: 'auto' },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.tool_choice).toBe('auto');
  });

  it('M3 lets required through on a supporting model, unchanged', async () => {
    await LLM.generateText({
      id: 'forced-required-supported',
      model: SUPPORTED,
      messages: MESSAGES,
      maxRetries: 0,
      ai: { tools: { lookup: lookupTool }, toolChoice: 'required' },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.tool_choice).toBe('required');
  });
});

describe('streamObjectViaTool on a model that rejects a forced tool choice', () => {
  it('refuses before any request', async () => {
    const stream = LLM.streamObjectViaTool({
      id: 'forced-stream-unsupported',
      model: UNSUPPORTED,
      schema,
      messages: MESSAGES,
      maxRetries: 0,
    });
    await expect(stream.next()).rejects.toMatchObject({ oopsCode: 'AI05' });
    expect(requests).toHaveLength(0);
  });
});
