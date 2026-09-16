import 'reflect-metadata';

import { SysEnv } from '@app/env';
import { ErrorCodes } from '@app/nest/exceptions/error-codes';
import { Oops } from '@app/nest/exceptions/oops';

import { resetTypeSafeClient, setTypeSafeClientForTest } from '../../typesafe/client';
import { LLM } from './llm.class';

import { RateLimitError } from '@typesafe-ai/sdk';
import { afterEach, describe, expect, it, mock } from 'bun:test';

import type { TypeSafeClient } from '@typesafe-ai/sdk';

const sysEnvMut = SysEnv as unknown as Record<string, string | undefined>;
const originalKey = sysEnvMut.AI_TYPESAFE_API_KEY;

afterEach(() => {
  sysEnvMut.AI_TYPESAFE_API_KEY = originalKey;
  setTypeSafeClientForTest(null);
  resetTypeSafeClient();
});

describe('LLM.systemOne', () => {
  it('throws Oops.Panic.Config when the TypeSafe key is missing', async () => {
    sysEnvMut.AI_TYPESAFE_API_KEY = undefined;
    try {
      await LLM.systemOne({
        id: 'ts-missing-key',
        state: 'hello',
        questions: { billing: { type: 'noul', instructions: 'billing?' } },
      });
      expect.unreachable('expected Config panic');
    } catch (error) {
      expect(error).toBeInstanceOf(Oops.Panic);
      expect(error).toMatchObject({
        errorCode: ErrorCodes.SYSTEM_CONFIG_ERROR,
        internalDetails: 'Configuration error: AI_TYPESAFE_API_KEY is not configured',
      });
    }
  });

  it('forwards SDK SystemOneRequest fields and types answers from questions', async () => {
    sysEnvMut.AI_TYPESAFE_API_KEY = 'ts_test_key';
    const systemOne = mock(async () => ({
      model: 'jev-latest',
      answers: {
        billing: { type: 'noul', noul: 0.91 },
        kind: { type: 'choice', choice: 'billing', confidence: 0.8, probabilities: { billing: 0.8, other: 0.2 } },
      },
      usage: { input_tokens: 12, output_tokens: 3 },
    }));
    setTypeSafeClientForTest({ systemOne } as unknown as TypeSafeClient);

    const questions = {
      billing: { type: 'noul' as const, instructions: 'Is this about billing?' },
      kind: {
        type: 'choice' as const,
        instructions: 'Ticket type?',
        criteria: { billing: null, other: null },
      },
    };
    const result = await LLM.systemOne({
      id: 'ts-happy',
      state: 'charged twice',
      questions,
      model: 'jev-latest',
    });

    const noul: number = result.answers.billing.noul;
    const kind: 'billing' | 'other' = result.answers.kind.choice;
    expect(noul).toBe(0.91);
    expect(kind).toBe('billing');
    expect(systemOne).toHaveBeenCalledTimes(1);
    const [request] = systemOne.mock.calls[0] as unknown as [{ state: unknown; questions: unknown; model?: string }];
    expect(request).toEqual({
      state: 'charged twice',
      questions,
      model: 'jev-latest',
    });
  });

  it('maps TypeSafe rate limits to Oops.Block.AIModelRateLimited', async () => {
    sysEnvMut.AI_TYPESAFE_API_KEY = 'ts_test_key';
    setTypeSafeClientForTest({
      systemOne: async () => {
        throw new RateLimitError(429, { error: 'rate limited' }, new Headers());
      },
    } as unknown as TypeSafeClient);

    try {
      await LLM.systemOne({
        id: 'ts-429',
        state: 'hello',
        questions: { billing: { type: 'noul', instructions: 'billing?' } },
      });
      expect.unreachable('expected rate limit block');
    } catch (error) {
      expect(error).toBeInstanceOf(Oops.Block);
      expect(error).toMatchObject({
        httpStatus: 429,
        errorCode: ErrorCodes.EXTERNAL_API_QUOTA,
        oopsCode: 'AI02',
      });
    }
  });
});
