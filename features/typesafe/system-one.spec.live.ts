/**
 * TypeSafe System One live probe through LLM.systemOne.
 *
 * Not run in CI. Needs AI_TYPESAFE_API_KEY:
 * ```bash
 * bun --env-file=.env test ./features/typesafe/system-one.spec.live.ts
 * ```
 */

import 'reflect-metadata';

import { LLM } from '../llm/clients/llm.class';
import { choice, noul, score } from './questions';

import { describe, expect, it } from 'bun:test';

const HAS_TYPESAFE_KEY = !!process.env.AI_TYPESAFE_API_KEY?.trim();
const describeLive = HAS_TYPESAFE_KEY ? describe : describe.skip;

describeLive('LLM.systemOne TypeSafe live', () => {
  it('answers mixed noul/choice/score questions about a billing complaint', async () => {
    const result = await LLM.systemOne({
      id: 'typesafe-system-one-live',
      state: '扣了两次钱，今天必须处理',
      questions: {
        billing: noul('这是账单问题吗？'),
        kind: choice('类型？', { billing: null, other: null }),
        urgency: score('紧急程度？', ['能等', '这周', '今天']),
      },
      timeout: 30_000,
    });

    console.log(
      `[typesafe-live] model=${result.model}` +
        ` billing=${result.answers.billing.noul.toFixed(3)}` +
        ` kind=${result.answers.kind.choice}` +
        ` urgency=${result.answers.urgency.score.toFixed(3)}` +
        ` tokens=${result.usage.input_tokens}+${result.usage.output_tokens}`,
    );

    expect(result.model.length).toBeGreaterThan(0);
    expect(result.answers.billing.noul).toBeGreaterThanOrEqual(0);
    expect(result.answers.billing.noul).toBeLessThanOrEqual(1);
    expect(['billing', 'other']).toContain(result.answers.kind.choice);
    expect(result.answers.urgency.score).toBeGreaterThanOrEqual(0);
    expect(result.answers.urgency.score).toBeLessThanOrEqual(2);
    expect(result.usage.input_tokens).toBeGreaterThan(0);
  }, 45_000);
});
