import { setDecisionsFetcherForTest } from '@app/features/llm/decisions/decisions.client';

import { systemOneViaOpenAI, transformSystemOneToOpenAIDecisionRequest } from './openai-adapter';

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import type { DecisionResult } from '@app/features/llm/decisions/decisions.types';
import type { Questions, SystemOneRequest } from '@typesafe-ai/sdk';

describe('OpenAISystemOneAdapter', () => {
  beforeEach(() => {
    setDecisionsFetcherForTest(null);
  });

  afterEach(() => {
    setDecisionsFetcherForTest(null);
  });

  it('correctly transforms SystemOne questions into OpenAI Decisions questions', () => {
    const request: SystemOneRequest<Questions> = {
      state: { text: 'order double charged' },
      questions: {
        is_billing: {
          type: 'noul',
          instructions: 'Is this billing?',
          criteria: { true: 'Payment/refund', false: 'Other' },
        },
        category: {
          type: 'choice',
          instructions: 'Select category',
          criteria: {
            billing: 'Payment issue',
            shipping: 'Delivery issue',
          },
        },
        urgency: {
          type: 'score',
          instructions: 'Rate urgency',
          criteria: ['Low', 'Medium', 'High'],
        },
      },
    };

    const transformed = transformSystemOneToOpenAIDecisionRequest(request);

    expect(transformed.input).toBe(JSON.stringify({ text: 'order double charged' }));
    expect(transformed.model).toBe('gpt-6-luna');
    expect(transformed.questions.length).toBe(3);

    const qMap = new Map(transformed.questions.map((q) => [q.name, q]));

    const billingQ = qMap.get('is_billing')!;
    expect(billingQ.type).toBe('predicate');
    expect(billingQ.instructions).toContain('Is this billing?');
    expect(billingQ.instructions).toContain('[True: Payment/refund]');

    const catQ = qMap.get('category')!;
    expect(catQ.type).toBe('choice');
    if (catQ.type === 'choice') {
      expect(catQ.choices).toEqual([
        { value: 'billing', description: 'Payment issue' },
        { value: 'shipping', description: 'Delivery issue' },
      ]);
    }

    const urgencyQ = qMap.get('urgency')!;
    expect(urgencyQ.type).toBe('score');
    if (urgencyQ.type === 'score') {
      expect(urgencyQ.levels).toEqual([
        { label: 'Low', description: 'Low' },
        { label: 'Medium', description: 'Medium' },
        { label: 'High', description: 'High' },
      ]);
    }
  });

  it('executes decisions via OpenAI and maps answers back to SystemOne format', async () => {
    const mockDecisionResult: DecisionResult = {
      model: 'gpt-6-luna',
      answers: [
        { type: 'predicate', name: 'is_billing', probability: 0.98 },
        {
          type: 'choice',
          name: 'category',
          choice: 'billing',
          probabilities: [
            { value: 'billing', probability: 0.98 },
            { value: 'shipping', probability: 0.02 },
          ],
          confidence: 0.95,
        },
        {
          type: 'score',
          name: 'urgency',
          score: 1.9,
          probabilities: [
            { value: 0, label: 'Low', probability: 0.05 },
            { value: 1, label: 'Medium', probability: 0.1 },
            { value: 2, label: 'High', probability: 0.85 },
          ],
          confidence: 0.92,
        },
      ],
      usage: {
        input_tokens: 150,
        output_tokens: 0,
        total_tokens: 150,
      },
    };

    const fakeFetcher = mock(async () => {
      return new Response(JSON.stringify(mockDecisionResult), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    setDecisionsFetcherForTest(fakeFetcher as unknown as typeof fetch);

    const request = {
      state: 'I want a refund',
      questions: {
        is_billing: { type: 'noul' as const, instructions: 'Is this billing?' },
        category: { type: 'choice' as const, criteria: { billing: 'Billing', shipping: 'Shipping' } },
        urgency: { type: 'score' as const, criteria: ['Low', 'Medium', 'High'] as const },
      },
    };

    const result = await systemOneViaOpenAI(request, { apiKey: 'test-key' });

    expect(result.model).toBe('gpt-6-luna');
    expect(result.usage.input_tokens).toBe(150);
    expect(result.usage.output_tokens).toBe(0);

    // 驗證 answers 映射
    const billingAns = result.answers.is_billing;
    expect(billingAns.type).toBe('noul');
    expect(billingAns.noul).toBe(0.98);

    const catAns = result.answers.category;
    expect(catAns.type).toBe('choice');
    expect(catAns.choice).toBe('billing');
    expect(catAns.confidence).toBe(0.95);
    expect(catAns.probabilities['billing']).toBe(0.98);

    const urgAns = result.answers.urgency;
    expect(urgAns.type).toBe('score');
    expect(urgAns.score).toBe(1.9);
    expect(urgAns.confidence).toBe(0.92);
    expect(urgAns.probabilities['2']).toBe(0.85);
  });
});
