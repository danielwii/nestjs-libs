import { SysEnv } from '@app/env';
import { Oops } from '@app/nest/exceptions/oops';
import { ApiFetcher } from '@app/utils/fetch';

import { LLMBatch, OpenRouterBatchClient } from './llm-batch.class';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

describe('LLMBatch (Generic OpenRouter Batch SDK)', () => {
  const originalFetch = ApiFetcher.fetch;
  const originalKey = SysEnv.AI_OPENROUTER_API_KEY;

  beforeEach(() => {
    (SysEnv as { AI_OPENROUTER_API_KEY: string }).AI_OPENROUTER_API_KEY = 'test-openrouter-key';
  });

  afterEach(() => {
    (ApiFetcher as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    (SysEnv as { AI_OPENROUTER_API_KEY?: string }).AI_OPENROUTER_API_KEY = originalKey;
  });

  it('exports OpenRouterBatchClient as an equivalent alias', () => {
    expect(OpenRouterBatchClient).toBe(LLMBatch);
  });

  describe('create', () => {
    it('M1 & N1: successfully creates a batch job with normalized model prefix', async () => {
      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;

      (ApiFetcher as unknown as { fetch: typeof fetch }).fetch = (async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(
          JSON.stringify({
            id: 'batch_test_123',
            endpoint: '/v1/chat/completions',
            model: 'openai/gpt-6-sol',
            status: 'validating',
            created_at: 1790100000,
            request_counts: { total: 2, completed: 0, failed: 0 },
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch;

      const res = await LLMBatch.create({
        model: 'openrouter:gpt-6-sol',
        requests: [
          { custom_id: 'req-1', body: { messages: [{ role: 'user', content: 'hello' }] } },
          { custom_id: 'req-2', body: { messages: [{ role: 'user', content: 'world' }] } },
        ],
      });

      expect(capturedUrl).toBe('https://openrouter.ai/api/v1/batches');
      expect(capturedInit?.method).toBe('POST');
      const headers = capturedInit?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-openrouter-key');

      const body = JSON.parse(capturedInit?.body as string);
      expect(body.model).toBe('openai/gpt-6-sol');
      expect(body.endpoint).toBe('/v1/chat/completions');
      expect(body.requests[0]?.body.model).toBe('openai/gpt-6-sol');

      expect(res.id).toBe('batch_test_123');
      expect(res.status).toBe('validating');
    });

    it('M2: rejects duplicate custom_id in the same batch with Oops.Validation before HTTP call', async () => {
      let httpCalled = false;
      (ApiFetcher as unknown as { fetch: unknown }).fetch = (async () => {
        httpCalled = true;
        return new Response('{}');
      }) as unknown as typeof fetch;

      try {
        await LLMBatch.create({
          model: 'openai/gpt-6-sol',
          requests: [
            { custom_id: 'duplicate-id', body: { messages: [{ role: 'user', content: '1' }] } },
            { custom_id: 'duplicate-id', body: { messages: [{ role: 'user', content: '2' }] } },
          ],
        });
        expect.unreachable('Should have thrown Oops.Validation');
      } catch (err) {
        expect(httpCalled).toBe(false);
        expect(err).toBeInstanceOf(Oops.Block);
        const oops = err as Oops.Block;
        expect(oops.httpStatus).toBe(400);
        expect(oops.userMessage).toContain('Duplicate custom_id detected');
      }
    });

    it('M3: rejects empty requests list with Oops.Validation', async () => {
      try {
        await LLMBatch.create({
          model: 'openai/gpt-6-sol',
          requests: [],
        });
        expect.unreachable('Should have thrown Oops.Validation');
      } catch (err) {
        expect(err).toBeInstanceOf(Oops.Block);
      }
    });

    it('M4: throws Oops.Panic.Config if AI_OPENROUTER_API_KEY is not configured', async () => {
      (SysEnv as { AI_OPENROUTER_API_KEY: string }).AI_OPENROUTER_API_KEY = '';

      try {
        await LLMBatch.create({
          model: 'openai/gpt-6-sol',
          requests: [{ custom_id: '1', body: { messages: [{ role: 'user', content: 'test' }] } }],
        });
        expect.unreachable('Should have thrown Oops.Panic.Config');
      } catch (err) {
        expect(err).toBeInstanceOf(Oops.Panic);
        const oops = err as Oops;
        expect(oops.message).toContain('AI_OPENROUTER_API_KEY is not set');
      }
    });

    it('M7: maps remote 429 to Oops.Block.AIModelRateLimited and 500 to Oops.Panic.ExternalService', async () => {
      (ApiFetcher as unknown as { fetch: unknown }).fetch = (async () => {
        return new Response('Rate limit reached', { status: 429 });
      }) as unknown as typeof fetch;

      try {
        await LLMBatch.create({
          model: 'openai/gpt-6-sol',
          requests: [{ custom_id: '1', body: { messages: [{ role: 'user', content: 'test' }] } }],
        });
        expect.unreachable('Should have thrown rate limit exception');
      } catch (err) {
        expect(err).toBeInstanceOf(Oops.Block);
        const oops = err as Oops.Block;
        expect(oops.httpStatus).toBe(429);
      }

      (ApiFetcher as unknown as { fetch: unknown }).fetch = (async () => {
        return new Response('Internal Server Error', { status: 500 });
      }) as unknown as typeof fetch;

      try {
        await LLMBatch.create({
          model: 'openai/gpt-6-sol',
          requests: [{ custom_id: '1', body: { messages: [{ role: 'user', content: 'test' }] } }],
        });
        expect.unreachable('Should have thrown ExternalService exception');
      } catch (err) {
        expect(err).toBeInstanceOf(Oops.Panic);
        const oops = err as Oops;
        expect(oops.message).toContain('External service error: openrouter');
      }
    });
  });

  describe('get', () => {
    it('M5: queries batch status by id', async () => {
      let capturedUrl = '';

      (ApiFetcher as unknown as { fetch: typeof fetch }).fetch = (async (url) => {
        capturedUrl = String(url);
        return new Response(
          JSON.stringify({
            id: 'batch_xyz',
            status: 'completed',
            request_counts: { total: 1, completed: 1, failed: 0 },
            results: [{ custom_id: 'req-1', response: { text: 'ok' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch;

      const res = await LLMBatch.get('batch_xyz');
      expect(capturedUrl).toBe('https://openrouter.ai/api/v1/batches/batch_xyz');
      expect(res.id).toBe('batch_xyz');
      expect(res.status).toBe('completed');
      expect(res.results?.length).toBe(1);
    });

    it('rejects empty batchId with Oops.Validation', async () => {
      try {
        await LLMBatch.get('   ');
        expect.unreachable('Should have thrown Oops.Validation');
      } catch (err) {
        expect(err).toBeInstanceOf(Oops.Block);
      }
    });
  });

  describe('cancel', () => {
    it('M6: sends cancel request to cancel endpoint', async () => {
      let capturedUrl = '';
      let capturedMethod = '';

      (ApiFetcher as unknown as { fetch: typeof fetch }).fetch = (async (url, init) => {
        capturedUrl = String(url);
        capturedMethod = init?.method ?? 'GET';
        return new Response(
          JSON.stringify({
            id: 'batch_xyz',
            status: 'cancelled',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch;

      const res = await LLMBatch.cancel('batch_xyz');
      expect(capturedUrl).toBe('https://openrouter.ai/api/v1/batches/batch_xyz/cancel');
      expect(capturedMethod).toBe('POST');
      expect(res.status).toBe('cancelled');
    });
  });

  describe('getResults', () => {
    it('S1: maps inlined results by custom_id on completed batch', () => {
      const batch = {
        id: 'b1',
        status: 'completed' as const,
        results: [
          { custom_id: 'user-1', response: { reply: 'hello' } },
          { custom_id: 'user-2', response: { reply: 'world' } },
        ],
      };

      const resultsMap = LLMBatch.getResults(batch);
      expect(resultsMap.size).toBe(2);
      expect(resultsMap.get('user-1')?.response).toEqual({ reply: 'hello' });
      expect(resultsMap.get('user-2')?.response).toEqual({ reply: 'world' });
    });

    it('S1: throws Oops.Validation if batch is not completed', () => {
      const batch = {
        id: 'b1',
        status: 'in_progress' as const,
      };

      expect(() => LLMBatch.getResults(batch)).toThrow(Oops.Block);
    });
  });
});
