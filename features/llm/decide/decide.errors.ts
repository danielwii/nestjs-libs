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

const STRUCTURED_SAFETY_REASONS = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'RECITATION',
  'CONTENT_FILTER',
]);

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

/**
 * Classifies HTTP 400/422 as `AI03` (`SafetyBlocked`) exclusively from structured
 * protocol enum/code fields (never via regex/substring matching on free-text messages).
 */
function isSafetyBlockedPayload(body: unknown): boolean {
  if (!body || typeof body !== 'object') {
    return false;
  }
  const record = body as Record<string, unknown>;
  if (record.code === 'content_policy_violation' || record.type === 'content_policy_violation') {
    return true;
  }
  if (typeof record.block_reason === 'string' && record.block_reason.length > 0) {
    return true;
  }
  if (record.promptFeedback && typeof record.promptFeedback === 'object') {
    const pf = record.promptFeedback as Record<string, unknown>;
    if (typeof pf.blockReason === 'string' && pf.blockReason.length > 0) {
      return true;
    }
  }
  if (record.error && typeof record.error === 'object') {
    const nested = record.error as Record<string, unknown>;
    if (nested.code === 'content_policy_violation' || nested.type === 'content_policy_violation') {
      return true;
    }
    if (typeof nested.status === 'string' && STRUCTURED_SAFETY_REASONS.has(nested.status)) {
      return true;
    }
    if (Array.isArray(nested.details)) {
      for (const item of nested.details) {
        if (item && typeof item === 'object') {
          const detailObj = item as Record<string, unknown>;
          if (typeof detailObj.reason === 'string' && STRUCTURED_SAFETY_REASONS.has(detailObj.reason)) {
            return true;
          }
        }
      }
    }
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

    // 400 / 422 -> Distinguish structured safety/policy block from schema/validation error
    if (error.status === 400 || error.status === 422) {
      if (isSafetyBlockedPayload(error.body)) {
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
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return Oops.Panic.AIModelError(modelKey, `Timeout: ${error.message}`, { cause: error });
    }
    return Oops.Panic.ExternalService(provider, error.message, { cause: error });
  }

  return Oops.Panic.ExternalService(provider, `Non-Error thrown: ${String(error)}`, {
    cause: error,
  });
}
