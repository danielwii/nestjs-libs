/**
 * LLM Fallback 行为验证
 *
 * 目标：确认 mood-analyzer 的 fallback 为何没有触发。
 * Sentry 现象：tried=[vertex:gemini-2.5-flash-lite]（只有主模型，fallback 没尝试）
 *
 * 假设一：fallback 模型未注册 → parseModelSpec 跳过 → fallbackModels 为空
 * 假设二：vertex 抛出的错误不满足 isRetryableError → fallback 逻辑直接 throw
 */

import 'reflect-metadata';

import { Oops } from '@app/nest/exceptions/oops';

import { parseModelSpec } from '../types/model.types';
import { isRetryableError, LLM } from './llm.class';

import { APICallError, NoObjectGeneratedError } from 'ai';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { OopsError } from '@app/nest/exceptions/oops-error';

// ─────────────────────────────────────────────────────────────────────────────
// 假设一：parseModelSpec 能否正确解析 mood-analyzer 的 spec
// ─────────────────────────────────────────────────────────────────────────────

describe('parseModelSpec: mood-analyzer fallback spec', () => {
  const MOOD_SPEC = 'vertex:gemini-2.5-flash-lite?fallback=openrouter:gemini-2.5-flash-lite';

  it('should parse primary model key correctly', () => {
    const result = parseModelSpec(MOOD_SPEC as Parameters<typeof parseModelSpec>[0]);
    expect(result.key).toBe('vertex:gemini-2.5-flash-lite');
  });

  it('should NOT skip openrouter:gemini-2.5-flash-lite (it is registered)', () => {
    // 如果这个测试失败，说明 openrouter:gemini-2.5-flash-lite 未注册 → 假设一成立
    const result = parseModelSpec(MOOD_SPEC as Parameters<typeof parseModelSpec>[0]);
    expect(result.fallbackModels).toContain('openrouter:gemini-2.5-flash-lite');
  });

  it('should have exactly one fallback model', () => {
    const result = parseModelSpec(MOOD_SPEC as Parameters<typeof parseModelSpec>[0]);
    expect(result.fallbackModels).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 假设二：isRetryableError 对各种错误类型的判断
// ─────────────────────────────────────────────────────────────────────────────

describe('isRetryableError: APICallError (retryable)', () => {
  const makeApiError = (statusCode: number) =>
    new APICallError({
      message: `HTTP ${statusCode}`,
      url: 'https://example.com',
      requestBodyValues: {},
      statusCode,
      responseHeaders: {},
      responseBody: '',
      isRetryable: statusCode === 429 || statusCode >= 500,
    });

  it('should be retryable for 429', () => {
    expect(isRetryableError(makeApiError(429))).toBe(true);
  });

  it('should be retryable for 500', () => {
    expect(isRetryableError(makeApiError(500))).toBe(true);
  });

  it('should be retryable for 503', () => {
    expect(isRetryableError(makeApiError(503))).toBe(true);
  });

  it('should NOT be retryable for 400', () => {
    expect(isRetryableError(makeApiError(400))).toBe(false);
  });
});

describe('isRetryableError: NoObjectGeneratedError (BUG CONFIRMATION)', () => {
  // Type cast needed: LanguageModelUsage token-detail fields are all optional at runtime
  // but TypeScript requires them to be explicitly set. This is test-only boilerplate.
  const makeNoObjectError = () =>
    new NoObjectGeneratedError({
      text: '```json\n{"mood": "calm"}\n```',
      response: { id: '', timestamp: new Date(), modelId: '' },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      },
      finishReason: 'stop',
    });

  /**
   * 修复确认：NoObjectGeneratedError 现在被视为 retryable，fallback 会触发。
   * 修复前：isRetryableError(NoObjectGeneratedError) → false → tried=[vertex:...]
   * 修复后：isRetryableError(NoObjectGeneratedError) → true → fallback 模型会被尝试
   */
  it('FIX: NoObjectGeneratedError IS retryable → fallback will trigger', () => {
    const error = makeNoObjectError();
    // 确认它不是 APICallError（HTTP 层面是 200 OK）
    expect(APICallError.isInstance(error)).toBe(false);
    // 修复后：isRetryableError 返回 true → fallback 会触发
    expect(isRetryableError(error)).toBe(true);
  });

  it('NoObjectGeneratedError has no statusCode', () => {
    const error = makeNoObjectError();
    // @ts-expect-error — NoObjectGeneratedError 没有 statusCode
    expect(error.statusCode).toBeUndefined();
  });
});

describe('isRetryableError: timeout errors', () => {
  it('should be retryable for DOMException TimeoutError', () => {
    const err = new DOMException('timeout', 'TimeoutError');
    expect(isRetryableError(err)).toBe(true);
  });

  it('should be retryable for Error with "timed out" in message', () => {
    expect(isRetryableError(new Error('Request timed out after 30s'))).toBe(true);
  });

  it('should NOT be retryable for generic Error', () => {
    expect(isRetryableError(new Error('something went wrong'))).toBe(false);
  });
});

describe('LLM safe API architecture', () => {
  const originalGenerateTextCore = (LLM as any).generateTextCore;
  const originalGenerateObjectCore = (LLM as any).generateObjectCore;

  const baseTextParams = {
    id: 'llm-test',
    model: 'vertex:gemini-2.5-flash-lite' as const,
    messages: [{ role: 'user' as const, content: 'hello' }],
  };

  const baseObjectParams = {
    ...baseTextParams,
    schema: z.object({ ok: z.boolean() }),
  };

  afterEach(() => {
    (LLM as any).generateTextCore = originalGenerateTextCore;
    (LLM as any).generateObjectCore = originalGenerateObjectCore;
  });

  it('safeGenerateText returns Err(OopsError) instead of rejecting for expected failures', async () => {
    const expected = Oops.Panic.ExternalService('vertex:gemini-2.5-flash-lite', 'timeout', {
      cause: new Error('timeout'),
    });
    (LLM as any).generateTextCore = async () => {
      throw expected;
    };

    const result = await LLM.safeGenerateText(baseTextParams);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBe(expected);
  });

  it('generateText remains a boundary adapter that throws the same OopsError', async () => {
    const expected = Oops.Panic.ExternalService('vertex:gemini-2.5-flash-lite', 'timeout', {
      cause: new Error('timeout'),
    });
    (LLM as any).generateTextCore = async () => {
      throw expected;
    };

    await expect(LLM.generateText(baseTextParams)).rejects.toBe(expected);
  });

  it('safeGenerateObject keeps the actual failed fallback model instead of reclassifying by original spec', async () => {
    const raw = new Error('fallback provider down');
    const actualFailure = LLM.classifyError(raw, 'openrouter:gemini-2.5-flash-lite');
    (LLM as any).generateObjectCore = async () => {
      throw actualFailure;
    };

    const result = await LLM.safeGenerateObject({
      ...baseObjectParams,
      model: 'vertex:gemini-2.5-flash-lite?fallback=openrouter:gemini-2.5-flash-lite',
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr() as OopsError;
    expect(error).toBe(actualFailure);
    expect(error.provider).toBe('openrouter:gemini-2.5-flash-lite');
    expect(error.cause).toBe(raw);
  });
});
