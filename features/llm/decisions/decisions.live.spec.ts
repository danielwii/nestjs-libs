/**
 * OpenAI Decisions live probe through LLM.decisions and LLM.systemOne.
 *
 * Run with Doppler or env key:
 * ```bash
 * OPENAI_API_KEY=$(doppler --config-dir ~/.doppler-personal secrets get OPENAI_API_KEY --project personal-dev --config dev --plain) bun test features/llm/decisions/decisions.spec.live.ts
 * ```
 */

import 'reflect-metadata';

import { choice, noul, score } from '../../typesafe/questions';
import { LLM } from '../clients/llm.class';

import { describe, expect, it } from 'bun:test';

const HAS_OPENAI_KEY = !!(process.env.AI_OPENAI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim());
const describeLive = HAS_OPENAI_KEY ? describe : describe.skip;

describeLive('OpenAI Decisions Live Probe', () => {
  it('executes native LLM.decisions with choice and predicate', async () => {
    const result = await LLM.decisions({
      id: 'live-decisions-test',
      input: 'I was charged twice for my subscription order.',
      questions: [
        {
          type: 'choice',
          name: 'dept',
          instructions: 'Which department should handle this complaint?',
          choices: [
            { value: 'billing', description: 'Payments and invoices' },
            { value: 'tech', description: 'Technical bugs' },
          ],
        },
        {
          type: 'predicate',
          name: 'is_urgent',
          instructions: 'Does this describe a critical service outage?',
        },
      ],
      timeout: 15_000,
    });

    console.log(
      `[openai-decisions-live] model=${result.model}` +
        ` answers=${JSON.stringify(result.answers)}` +
        ` tokens=${result.usage.input_tokens}+${result.usage.output_tokens}`,
    );

    expect(result.model).toBe('gpt-6-luna');
    expect(result.answers.length).toBe(2);
    expect(result.usage.output_tokens).toBe(0);
  }, 30_000);

  it('executes LLM.systemOne via OpenAI bridge adapter', async () => {
    const result = await LLM.systemOne({
      id: 'live-system-one-openai',
      provider: 'openai',
      state: 'Export fails in Safari but works in Chrome.',
      questions: {
        is_bug: noul('Is this a software defect?'),
        browser: choice('Which browser has problem?', { safari: 'Safari', chrome: 'Chrome' }),
        severity: score('Severity?', ['Cosmetic', 'Workaround available', 'Blocked']),
      },
      timeout: 15_000,
    });

    console.log(
      `[openai-system-one-live] model=${result.model}` +
        ` is_bug=${result.answers.is_bug.noul.toFixed(3)}` +
        ` browser=${result.answers.browser.choice}` +
        ` severity=${result.answers.severity.score.toFixed(3)}` +
        ` tokens=${result.usage.input_tokens}+${result.usage.output_tokens}`,
    );

    expect(result.model).toBe('gpt-6-luna');
    expect(result.answers.is_bug.noul).toBeGreaterThan(0.5);
    expect(result.answers.browser.choice).toBe('safari');
    expect(result.answers.severity.score).toBeGreaterThanOrEqual(0);
    expect(result.usage.output_tokens).toBe(0);
  }, 30_000);
});
