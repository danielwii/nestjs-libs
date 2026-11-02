/**
 * Goal: `LLM.systemOne` returns the answer when the TypeSafe API replies with a small JSON body.
 * Design: the real `TypeSafeClient` runs over a fake `fetch` (no network), so the SDK's own response handling is under test; the sibling spec
 *   replaces the whole client and cannot see it. `@typesafe-ai/sdk` 0.7.0 buffered each reply by locking the original body and releasing it,
 *   and on Bun a small body that was not yet read then counts as used, so every call failed with `TypeError: Body already used`
 *   (Bun 1.4.0, 1.4.3 and 1.4.4; 0.6.0 does not touch the original body). Nothing here asserts the SDK version: the replies below are the shapes
 *   that failed, so an upgrade that brings the failure back turns this red.
 * Not covered: large or streamed replies, retries, and the live API (`system-one.spec.live.ts`).
 */
import 'reflect-metadata';

import { SysEnv } from '@app/env';

import { resetTypeSafeClient, setTypeSafeClientForTest } from '../../typesafe/client';
import { LLM } from './llm.class';

import { TypeSafeClient } from '@typesafe-ai/sdk';
import { afterEach, describe, expect, it, mock } from 'bun:test';

const sysEnvMut = SysEnv as unknown as Record<string, string | undefined>;
const originalKey = sysEnvMut.AI_TYPESAFE_API_KEY;

afterEach(() => {
  sysEnvMut.AI_TYPESAFE_API_KEY = originalKey;
  setTypeSafeClientForTest(null);
  resetTypeSafeClient();
});

const reply = {
  model: 'jev-latest',
  answers: { billing: { type: 'noul', noul: 0.91 } },
  usage: { input_tokens: 12, output_tokens: 3 },
};

const replies: ReadonlyArray<readonly [string, () => Response]> = [
  ['Response.json', () => Response.json(reply)],
  [
    'a JSON string body',
    () => new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } }),
  ],
];

describe('LLM.systemOne over the real SDK client', () => {
  for (const [shape, makeReply] of replies)
    it(`returns the answer when the API replies with ${shape}`, async () => {
      sysEnvMut.AI_TYPESAFE_API_KEY = 'ts_test_key';
      const fakeFetch = mock(async () => makeReply());
      setTypeSafeClientForTest(
        new TypeSafeClient({
          apiKey: 'synthetic-test-key',
          baseURL: 'http://typesafe.invalid',
          retry: { maxRetries: 0 },
          logLevel: 'off',
          fetch: fakeFetch as unknown as typeof fetch,
        }),
      );

      const result = await LLM.systemOne({
        id: 'ts-small-reply',
        state: 'charged twice',
        questions: { billing: { type: 'noul', instructions: 'Is this about billing?' } },
        model: 'jev-latest',
      });

      expect(fakeFetch).toHaveBeenCalledTimes(1);
      expect(result.answers.billing.noul).toBe(0.91);
      expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
    });
});
