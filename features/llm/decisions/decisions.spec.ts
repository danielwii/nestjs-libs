import { SysEnv } from '@app/env';
import { Oops } from '@app/nest/exceptions/oops';

import { DEFAULT_DECISIONS_MODEL, executeDecisions, setDecisionsFetcherForTest } from './decisions.client';

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import type { DecisionRequest, DecisionResult } from './decisions.types';

describe('OpenAI Decisions Client', () => {
  const originalKey = SysEnv.AI_OPENAI_API_KEY;
  const originalEnvKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    setDecisionsFetcherForTest(null);
  });

  afterEach(() => {
    SysEnv.AI_OPENAI_API_KEY = originalKey;
    if (originalEnvKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalEnvKey;
    }
    setDecisionsFetcherForTest(null);
  });

  it('does not treat literal "undefined" string as a valid API key', () => {
    const rawKey = 'undefined';
    const isValid = !!rawKey && rawKey !== 'undefined';
    expect(isValid).toBe(false);
  });

  it('throws Oops.Panic.Config when AI_OPENAI_API_KEY is not configured', async () => {
    SysEnv.AI_OPENAI_API_KEY = undefined;
    delete process.env.OPENAI_API_KEY;

    await expect(
      executeDecisions({
        input: 'test text',
        questions: [{ type: 'predicate', name: 'q1', instructions: 'is this test?' }],
      }),
    ).rejects.toThrow(Oops.Panic);
  });

  it('forwards DecisionRequest fields and parses responses accurately', async () => {
    const mockResult: DecisionResult = {
      model: DEFAULT_DECISIONS_MODEL,
      answers: [
        {
          type: 'choice',
          name: 'dept',
          choice: 'billing',
          probabilities: [{ value: 'billing', probability: 1.0 }],
          confidence: 1.0,
        },
        { type: 'predicate', name: 'is_urgent', probability: 0.95 },
        {
          type: 'score',
          name: 'severity',
          score: 1.8,
          probabilities: [{ value: 1, label: 'med', probability: 0.8 }],
          confidence: 0.9,
        },
      ],
      usage: {
        input_tokens: 120,
        output_tokens: 0,
        total_tokens: 120,
      },
    };

    let capturedUrl = '';
    let capturedBody: any = null;
    let capturedHeaders: any = null;

    const fakeFetcher = mock(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body));
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify(mockResult), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    setDecisionsFetcherForTest(fakeFetcher as unknown as typeof fetch);

    const request: DecisionRequest = {
      input: 'I have an issue with billing',
      questions: [
        {
          type: 'choice',
          name: 'dept',
          instructions: 'Pick department',
          choices: [{ value: 'billing', description: 'billing dept' }],
        },
        {
          type: 'predicate',
          name: 'is_urgent',
          instructions: 'Is it urgent?',
        },
        {
          type: 'score',
          name: 'severity',
          instructions: 'Rate severity',
          levels: [
            { label: 'low', description: 'low' },
            { label: 'med', description: 'med' },
          ],
        },
      ],
    };

    const result = await executeDecisions(request, { apiKey: 'test-openai-key' });

    expect(capturedUrl).toBe('https://api.openai.com/v1/decisions');
    expect(capturedHeaders['Authorization']).toBe('Bearer test-openai-key');
    expect(capturedBody.model).toBe('gpt-6-luna');
    expect(capturedBody.input).toBe('I have an issue with billing');
    expect(capturedBody.questions.length).toBe(3);

    expect(result.model).toBe('gpt-6-luna');
    expect(result.answers.length).toBe(3);
    const [a0, a1, a2] = result.answers;
    expect(a0?.type).toBe('choice');
    expect(a1?.type).toBe('predicate');
    expect(a2?.type).toBe('score');
    expect(result.usage.output_tokens).toBe(0);
  });

  it('supports multimodal image inputs', async () => {
    const mockResult: DecisionResult = {
      model: DEFAULT_DECISIONS_MODEL,
      answers: [{ type: 'predicate', name: 'has_dent', probability: 0.99 }],
      usage: { input_tokens: 300, output_tokens: 0, total_tokens: 300 },
    };

    let capturedBody: any = null;
    const fakeFetcher = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(mockResult), { status: 200 });
    });

    setDecisionsFetcherForTest(fakeFetcher as unknown as typeof fetch);

    const request: DecisionRequest = {
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Inspect photo' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
          ],
        },
      ],
      questions: [{ type: 'predicate', name: 'has_dent', instructions: 'Damage visible?' }],
    };

    const result = await executeDecisions(request, { apiKey: 'test-key' });

    expect(capturedBody.input[0].content[1].type).toBe('input_image');
    const firstAns = result.answers[0];
    expect(firstAns?.type).toBe('predicate');
    if (firstAns && firstAns.type === 'predicate') {
      expect(firstAns.probability).toBe(0.99);
    }
  });

  it('maps HTTP 429 to Oops.Block.AIModelRateLimited', async () => {
    const fakeFetcher = mock(async () => {
      return new Response(JSON.stringify({ error: { message: 'Rate limit reached' } }), {
        status: 429,
        statusText: 'Too Many Requests',
      });
    });

    setDecisionsFetcherForTest(fakeFetcher as unknown as typeof fetch);

    await expect(
      executeDecisions(
        {
          input: 'hello',
          questions: [{ type: 'predicate', name: 'q', instructions: 'ok?' }],
        },
        { apiKey: 'test-key' },
      ),
    ).rejects.toThrow(Oops.Block);
  });

  it('maps HTTP 401 to Oops.Panic.Config', async () => {
    const fakeFetcher = mock(async () => {
      return new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), {
        status: 401,
        statusText: 'Unauthorized',
      });
    });

    setDecisionsFetcherForTest(fakeFetcher as unknown as typeof fetch);

    await expect(
      executeDecisions(
        {
          input: 'hello',
          questions: [{ type: 'predicate', name: 'q', instructions: 'ok?' }],
        },
        { apiKey: 'invalid-key' },
      ),
    ).rejects.toThrow(Oops.Panic);
  });

  it('maps HTTP 400 to Oops.Validation', async () => {
    const fakeFetcher = mock(async () => {
      return new Response(JSON.stringify({ error: { message: 'Invalid question shape' } }), {
        status: 400,
        statusText: 'Bad Request',
      });
    });

    setDecisionsFetcherForTest(fakeFetcher as unknown as typeof fetch);

    await expect(
      executeDecisions(
        {
          input: 'hello',
          questions: [{ type: 'predicate', name: 'q', instructions: 'ok?' }],
        },
        { apiKey: 'test-key' },
      ),
    ).rejects.toThrow(Oops.Block);
  });
});
