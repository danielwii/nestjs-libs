/**
 * Live 3-Provider Integration Probe for `LLM.decide` & `LLM.safeDecide`
 *
 * Run with personal Doppler credentials:
 * `DOPPLER_CONFIG_DIR=~/.doppler-personal doppler run -- bun test features/llm/decide/decide.spec.live.ts`
 */

import { SysEnv } from '@app/env';

import { LLM } from '../clients/llm.class';
import { D } from './d';

import { beforeAll, describe, expect, it } from 'bun:test';

beforeAll(() => {
  if (!SysEnv.AI_OPENAI_API_KEY && process.env.OPENAI_API_KEY) {
    SysEnv.AI_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  }
});

const SAMPLE_INPUT =
  'Customer message: "Hi team, I was billed twice on invoice #INV-9021 ($49.00 each) and need an immediate refund for the duplicate charge."';

const SHARED_QUESTIONS = {
  isBillingIssue: D.noul('Is the customer reporting a billing or payment issue?', {
    yes: 'Duplicate charge, invoice error, or refund request',
    no: 'Technical bug, feature request, or general inquiry',
  }),
  department: D.choice('Which team should handle this ticket?', {
    billing: 'Refunds, duplicate charges, and invoices',
    engineering: 'Crashes, bugs, and outages',
    sales: 'Enterprise pricing and upgrades',
  }),
  urgency: D.score('How urgent is the customer request?', [
    'Low: general feedback',
    'Medium: standard billing/refund request',
    'High: production outage or legal threat',
  ]),
} as const;

describe('LLM.decide Live 3-Provider Probe (TypeSafe / Google / OpenAI)', () => {
  it('executes live decision against TypeSafe (typesafe:jev-1.14.0)', async () => {
    const res = await LLM.safeDecide({
      id: 'live-typesafe-jev-1.14.0',
      model: 'typesafe:jev-1.14.0',
      input: SAMPLE_INPUT,
      questions: SHARED_QUESTIONS,
    });

    expect(res.isOk()).toBe(true);
    const data = res._unsafeUnwrap();
    expect(data.answers.isBillingIssue.probability).toBeGreaterThan(0.7);
    expect(data.answers.department.choice).toBe('billing');
    expect(data.answers.department.topProbability).toBeGreaterThan(0.5);
    expect(data.answers.urgency.probabilities.length).toBe(3);
    expect(data.usage.inputTokens).toBeGreaterThan(0);
    expect(data.usage.cost).toBeGreaterThan(0);
  }, 30_000);

  it('executes live decision against Google (google:gemini-decision-1)', async () => {
    const res = await LLM.safeDecide({
      id: 'live-google-gemini-decision-1',
      model: 'google:gemini-decision-1',
      input: SAMPLE_INPUT,
      questions: SHARED_QUESTIONS,
    });

    expect(res.isOk()).toBe(true);
    const data = res._unsafeUnwrap();
    expect(data.answers.isBillingIssue.probability).toBeGreaterThan(0.7);
    expect('confidence' in data.answers.isBillingIssue).toBe(false);
    expect(data.answers.department.choice).toBe('billing');
    expect(data.answers.urgency.probabilities.length).toBe(3);
    expect(data.usage.inputTokens).toBeGreaterThan(0);
    expect(data.usage.cost).toBeGreaterThan(0);
  }, 30_000);

  it('executes live decision against OpenAI (openai:gpt-6-luna)', async () => {
    const res = await LLM.safeDecide({
      id: 'live-openai-gpt-6-luna',
      model: 'openai:gpt-6-luna',
      input: SAMPLE_INPUT,
      questions: SHARED_QUESTIONS,
    });

    expect(res.isOk()).toBe(true);
    const data = res._unsafeUnwrap();
    expect(data.answers.isBillingIssue.probability).toBeGreaterThan(0.7);
    expect(data.answers.department.choice).toBe('billing');
    expect(data.answers.urgency.probabilities.length).toBe(3);
    expect(data.usage.inputTokens).toBeGreaterThan(0);
    expect(data.usage.cost).toBeGreaterThan(0);
  }, 30_000);
});
