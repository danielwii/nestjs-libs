import { SysEnv } from '@app/env';
import { Oops } from '@app/nest/exceptions/oops';

import { setDecisionsFetcherForTest } from '../decisions/decisions.client';
import { LLM } from './llm.class';

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import type { DecisionResult } from '../decisions/decisions.types';

describe('LLM.decisions', () => {
  const originalOpenAIKey = SysEnv.AI_OPENAI_API_KEY;

  beforeEach(() => {
    setDecisionsFetcherForTest(null);
  });

  afterEach(() => {
    SysEnv.AI_OPENAI_API_KEY = originalOpenAIKey;
    setDecisionsFetcherForTest(null);
  });

  it('executes native OpenAI decisions request and returns typed results', async () => {
    const mockResult: DecisionResult = {
      model: 'gpt-6-luna',
      answers: [{ type: 'predicate', name: 'damaged', probability: 0.96 }],
      usage: { input_tokens: 200, output_tokens: 0, total_tokens: 200 },
    };

    const fakeFetcher = mock(async () => {
      return new Response(JSON.stringify(mockResult), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    setDecisionsFetcherForTest(fakeFetcher as unknown as typeof fetch);

    const result = await LLM.decisions({
      id: 'test-decisions-1',
      apiKey: 'test-key',
      input: 'Broken package',
      questions: [{ type: 'predicate', name: 'damaged', instructions: 'Is damaged?' }],
    });

    expect(result.model).toBe('gpt-6-luna');
    const ans = result.answers[0];
    expect(ans?.type).toBe('predicate');
    if (ans && ans.type === 'predicate') {
      expect(ans.probability).toBe(0.96);
    }
    expect(result.usage.output_tokens).toBe(0);
  });

  it('accurately infers tuple answer types, literal choice unions, and answersByName', async () => {
    const mockResult: DecisionResult = {
      model: 'gpt-6-luna',
      answers: [
        { type: 'predicate', name: 'is_urgent', probability: 0.95 },
        {
          type: 'choice',
          name: 'dept',
          choice: 'billing',
          probabilities: [
            { value: 'billing', probability: 1.0 },
            { value: 'tech', probability: 0.0 },
          ],
          confidence: 1.0,
        },
      ],
      usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 },
    };

    const fakeFetcher = mock(async () => {
      return new Response(JSON.stringify(mockResult), { status: 200 });
    });

    setDecisionsFetcherForTest(fakeFetcher as unknown as typeof fetch);

    const result = await LLM.decisions({
      apiKey: 'test-key',
      input: 'charge twice',
      questions: [
        { type: 'predicate', name: 'is_urgent', instructions: 'urgent?' },
        {
          type: 'choice',
          name: 'dept',
          instructions: 'dept?',
          choices: [{ value: 'billing' as const }, { value: 'tech' as const }] as const,
        },
      ] as const,
    });

    // 驗證 answers[0] 精確推導為 PredicateAnswer
    const pAns = result.answers[0];
    if (pAns.type === 'predicate') {
      const prob: number = pAns.probability;
      expect(prob).toBe(0.95);
    }

    // 驗證 answers[1] 精確推導為 ChoiceAnswer<'dept', 'billing' | 'tech'>
    const cAns = result.answers[1];
    if (cAns.type === 'choice') {
      const chosen: 'billing' | 'tech' = cAns.choice;
      expect(chosen).toBe('billing');
    }

    // 驗證 answersByName 字典存取
    expect(result.answersByName).toBeDefined();
    expect(result.answersByName?.is_urgent.name).toBe('is_urgent');
  });

  it('classifies errors appropriately in LLM.decisions', async () => {
    const fakeFetcher = mock(async () => {
      return new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), {
        status: 429,
        statusText: 'Too Many Requests',
      });
    });

    setDecisionsFetcherForTest(fakeFetcher as unknown as typeof fetch);

    await expect(
      LLM.decisions({
        id: 'test-rate-limit',
        apiKey: 'test-key',
        input: 'test',
        questions: [{ type: 'predicate', name: 'q', instructions: 'q?' }],
      }),
    ).rejects.toThrow(Oops.Block);
  });
});
