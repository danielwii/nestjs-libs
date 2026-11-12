/**
 * Unified Error Classification for `LLM.decide` / `LLM.safeDecide`
 *
 * Maps HTTP statuses, provider error payloads, safety blocks, and refusals from
 * TypeSafe (`/v1/systemone`), Google (`/v1beta/decisions`), and OpenAI (`/v1/decisions`)
 * into canonical `OopsError` instances (`[ARC-02]`, `Dual-Boundary Defense`).
 */

import { ErrorCodes } from '@app/nest/exceptions/error-codes';
import { Oops } from '@app/nest/exceptions/oops';
import { OopsError } from '@app/nest/exceptions/oops-error';

import type { DecisionModelKey, DecisionProvider } from './decide.types';

export class DecideHttpError extends Error {
  constructor(
    public readonly provider: DecisionProvider,
    public readonly modelKey: DecisionModelKey,
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'DecideHttpError';
  }
}

const SAFETY_BLOCK_PATTERN =
  /\b(safety|prohibited_content|blocklist|recitation|content_filter|moderation|policy_violation|blocked|harm_category)\b/i;

function extractErrorDetail(body: unknown, fallback: string): string {
  if (!body) return fallback;
  if (typeof body === 'string') return body;
  if (typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
    if (typeof record.detail === 'string') return record.detail;
    if (record.error && typeof record.error === 'object') {
      const nested = record.error as Record<string, unknown>;
      if (typeof nested.message === 'string') return nested.message;
      if (typeof nested.status === 'string') return nested.status;
    }
    try {
      return JSON.stringify(body);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function isSafetyBlockedPayload(body: unknown, detail: string): boolean {
  if (SAFETY_BLOCK_PATTERN.test(detail)) {
    return true;
  }
  if (body && typeof body === 'object') {
    const serialized = JSON.stringify(body);
    return SAFETY_BLOCK_PATTERN.test(serialized);
  }
  return false;
}

export function createDecisionSafetyBlockError(
  modelKey: DecisionModelKey,
  detail: string,
  cause?: unknown,
): Oops.Block {
  return new Oops.Block({
    httpStatus: 400,
    errorCode: ErrorCodes.CLIENT_INPUT_ERROR,
    oopsCode: 'AI03',
    userMessage: '内容被安全过滤器拦截，请调整表达后重试',
    internalDetails: `Decision model safety/policy block (${modelKey}): ${detail}`,
    provider: modelKey,
    cause,
  });
}

export function resolveDecisionProvider(modelKey: DecisionModelKey): DecisionProvider {
  if (modelKey.startsWith('typesafe:')) return 'typesafe';
  if (modelKey.startsWith('google:')) return 'google';
  if (modelKey.startsWith('openai:')) return 'openai';
  throw Oops.Validation(`Unsupported decision model key: "${modelKey}"`);
}

/**
 * Classifies any error thrown during `LLM.decide` into a structured `OopsError`.
 */
export function classifyDecideError(error: unknown, modelKey: DecisionModelKey): OopsError {
  if (error instanceof OopsError) {
    return error;
  }

  const provider = resolveDecisionProvider(modelKey);

  if (error instanceof DecideHttpError) {
    const detail = extractErrorDetail(error.body, error.message);

    // 401 / 403 -> Static/Auth configuration failure
    if (error.status === 401 || error.status === 403) {
      return Oops.Panic.Config(`${provider} Decision API authentication failed (HTTP ${error.status}): ${detail}`, {
        cause: error,
      });
    }

    // 402 (TypeSafe quota exhausted) / 429 (Rate limit across all providers) -> Rate-limited block
    if (error.status === 402 || error.status === 429) {
      return Oops.Block.AIModelRateLimited(modelKey, { cause: error });
    }

    // 400 / 422 -> Distinguish safety/policy block (e.g. Google HTTP 400 SAFETY) from schema/validation error
    if (error.status === 400 || error.status === 422) {
      if (isSafetyBlockedPayload(error.body, detail)) {
        return createDecisionSafetyBlockError(modelKey, detail, error);
      }
      return Oops.Validation(`${provider} Decision API rejected request (HTTP ${error.status}): ${detail}`, detail);
    }

    // 408 / 504 -> Timeout error
    if (error.status === 408 || error.status === 504) {
      return Oops.Panic.AIModelError(modelKey, `Timeout (HTTP ${error.status}): ${detail}`, {
        cause: error,
      });
    }

    return Oops.Panic.AIModelError(modelKey, `HTTP ${error.status}: ${detail}`, {
      cause: error,
    });
  }

  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError' || /timed?\s*out|abort/i.test(error.message)) {
      return Oops.Panic.AIModelError(modelKey, `Timeout: ${error.message}`, { cause: error });
    }
    return Oops.Panic.ExternalService(provider, error.message, { cause: error });
  }

  return Oops.Panic.ExternalService(provider, `Non-Error thrown: ${String(error)}`, {
    cause: error,
  });
}
