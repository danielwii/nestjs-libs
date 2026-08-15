import 'reflect-metadata';

import { SysEnv } from '@app/env';
import { ApiFetcher } from '@app/utils/fetch';

import { LLM } from './llm.class';
import { resetLLMClients } from './llm.clients';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

const sysEnvMut = SysEnv as unknown as Record<string, string | undefined>;
sysEnvMut.AI_OPENROUTER_API_KEY ??= 'test-openrouter-key';

const originalFetch = ApiFetcher.fetch;

function openRouterToolStream(): string {
  const chunks = [
    {
      id: 'chatcmpl-fixture',
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
                id: 'call-fixture',
                type: 'function',
                function: { name: 'extract', arguments: '' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'chatcmpl-fixture',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'fixture-model',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"value":"ok"}' } }],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'chatcmpl-fixture',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'fixture-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    },
  ];

  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
}

function createTrackingAbortSignal(): { signal: AbortSignal; removed: () => number } {
  let removeCount = 0;
  const listeners = new Set<unknown>();
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(type: string, listener: unknown) {
      if (type === 'abort') listeners.add(listener);
    },
    removeEventListener(type: string, listener: unknown) {
      if (type === 'abort' && listeners.delete(listener)) removeCount += 1;
    },
  } as unknown as AbortSignal;

  return { signal, removed: () => removeCount };
}

beforeEach(() => {
  (ApiFetcher as unknown as { fetch: typeof fetch }).fetch = (async () =>
    new Response(openRouterToolStream(), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as unknown as typeof fetch;
  resetLLMClients();
});

afterEach(() => {
  (ApiFetcher as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  resetLLMClients();
});

describe('LLM.streamObjectViaTool lifecycle', () => {
  it('removes the caller abort listener when the consumer returns early', async () => {
    const tracking = createTrackingAbortSignal();
    const iterator = LLM.streamObjectViaTool({
      id: 'generator-early-return',
      model: 'openrouter:grok-4.3',
      schema: z.object({ value: z.string() }),
      messages: [{ role: 'user', content: 'extract value' }],
      abortSignal: tracking.signal,
      maxRetries: 0,
    });

    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ type: 'start', toolCallId: 'call-fixture' });
    expect(tracking.removed()).toBe(0);

    await iterator.return(undefined);

    expect(tracking.removed()).toBe(1);
  });
});
