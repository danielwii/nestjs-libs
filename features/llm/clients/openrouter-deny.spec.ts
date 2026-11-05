/**
 * Every request the library sends to OpenRouter carries `provider.data_collection: 'deny'`, whichever layer the caller
 * wrote `provider` from (owner rule bcc433eb, data-exposure spec S11, test T41). The AI SDK provider is the real one;
 * only the global `fetch` underneath is replaced, so what is asserted is the body that would be sent.
 */
import { SysEnv } from '@app/env';
import { openRouterFetch } from '@app/utils/fetch';

import { getOpenRouter } from './llm.clients';
import { createOpenRouterClient } from './openrouter.client';

import { generateText } from 'ai';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

type Sent = { url: string; init?: RequestInit; body: Record<string, any> };

const sysEnvMut = SysEnv as unknown as Record<string, string | undefined>;
const originalKey = sysEnvMut.AI_OPENROUTER_API_KEY;

let sent: Sent[] = [];
let fetchSpy: ReturnType<typeof spyOn>;

const CHAT_REPLY = {
  id: 'gen-1',
  model: 'openai/gpt-x',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};
const EMBEDDING_REPLY = {
  object: 'list',
  id: 'gen-2',
  model: 'openai/text-embedding-3-small',
  data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
  usage: { prompt_tokens: 1, total_tokens: 1 },
};

beforeEach(() => {
  sent = [];
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    sent.push({ url, init, body: typeof init?.body === 'string' ? JSON.parse(init.body) : {} });
    const reply = url.endsWith('/embeddings') ? EMBEDDING_REPLY : CHAT_REPLY;
    return new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
});

afterEach(() => {
  fetchSpy.mockRestore();
  sysEnvMut.AI_OPENROUTER_API_KEY = originalKey;
});

const only = (): Sent => {
  expect(sent).toHaveLength(1);
  return sent[0] as Sent;
};

describe('createOpenRouterClient', () => {
  for (const [name, useProxy] of [
    ['through the proxy fetch', true],
    ['with the bare fetch', false],
  ] as const) {
    describe(name, () => {
      it('writes deny when the caller writes allow in providerOptions, and keeps the routing order', async () => {
        const openrouter = await createOpenRouterClient({ apiKey: 'sk-test', useProxy });
        await generateText({
          model: openrouter('openai/gpt-x'),
          prompt: 'hi',
          providerOptions: { openrouter: { provider: { data_collection: 'allow', order: ['openai', 'azure'] } } },
        });
        const { url, body } = only();
        expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
        expect(body.provider).toEqual({ data_collection: 'deny', order: ['openai', 'azure'] });
      });

      it('writes deny when the caller writes allow in the model settings or extraBody', async () => {
        const openrouter = await createOpenRouterClient({ apiKey: 'sk-test', useProxy });
        await generateText({
          model: openrouter('openai/gpt-x', { provider: { data_collection: 'allow', order: ['openai'] } }),
          prompt: 'hi',
        });
        await generateText({
          model: openrouter('openai/gpt-x', { extraBody: { provider: { data_collection: 'allow', only: ['azure'] } } }),
          prompt: 'hi',
        });
        expect(sent).toHaveLength(2);
        expect(sent[0]?.body.provider).toEqual({ data_collection: 'deny', order: ['openai'] });
        expect(sent[1]?.body.provider).toEqual({ data_collection: 'deny', only: ['azure'] });
      });

      it('writes deny when the caller writes nothing, and on an embedding', async () => {
        const openrouter = await createOpenRouterClient({ apiKey: 'sk-test', useProxy });
        await generateText({ model: openrouter('openai/gpt-x'), prompt: 'hi' });
        await openrouter.textEmbeddingModel('openai/text-embedding-3-small').doEmbed({ values: ['hello'] });
        expect(sent).toHaveLength(2);
        expect(sent[0]?.body.provider).toEqual({ data_collection: 'deny' });
        expect(sent[1]?.url).toBe('https://openrouter.ai/api/v1/embeddings');
        expect(sent[1]?.body.provider).toEqual({ data_collection: 'deny' });
      });
    });
  }

  it('wraps a fetch the caller supplies', async () => {
    const seen: Record<string, any>[] = [];
    const customFetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push(JSON.parse(init?.body as string));
      return new Response(JSON.stringify(CHAT_REPLY), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const openrouter = await createOpenRouterClient({ apiKey: 'sk-test', customFetch });
    await generateText({
      model: openrouter('openai/gpt-x'),
      prompt: 'hi',
      providerOptions: { openrouter: { provider: { data_collection: 'allow' } } },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.provider).toEqual({ data_collection: 'deny' });
    expect(sent).toHaveLength(0);
  });
});

describe('getOpenRouter (the singleton, ApiFetcher.fetch)', () => {
  it('writes deny when the caller writes allow', async () => {
    sysEnvMut.AI_OPENROUTER_API_KEY = 'sk-test';
    await generateText({
      model: getOpenRouter()('openai/gpt-x'),
      prompt: 'hi',
      providerOptions: { openrouter: { provider: { data_collection: 'allow', order: ['openai'] } } },
    });
    expect(only().body.provider).toEqual({ data_collection: 'deny', order: ['openai'] });
  });
});

describe('openRouterFetch', () => {
  it('sends to the OpenRouter API with deny, and drops the content-length of the body the caller built', async () => {
    const payload = JSON.stringify({ model: 'openai/gpt-x', messages: [], provider: { data_collection: 'allow' } });
    await openRouterFetch('/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(payload.length),
        Authorization: 'Bearer k',
      },
      body: payload,
    });
    const { url, init, body } = only();
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(body.provider).toEqual({ data_collection: 'deny' });
    const headers = new Headers(init?.headers);
    expect(headers.get('content-length')).toBeNull();
    expect(headers.get('authorization')).toBe('Bearer k');
  });

  it('sends a stream body unchanged: the caller that streams applies applyOpenRouterDeny to its body object first', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"model":"openai/gpt-x"}'));
        controller.close();
      },
    });
    await openRouterFetch('/chat/completions', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    expect(only().init?.body).toBe(stream);
  });
});
