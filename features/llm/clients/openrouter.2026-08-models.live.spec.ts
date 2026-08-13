/**
 * OpenRouter 2026-08 model catalog smoke/capability evidence.
 *
 * Not run in CI. Execute with a real OpenRouter credential:
 * ```bash
 * LLM_LIVE_TEST=1 bun test features/llm/clients/openrouter.2026-08-models.live.spec.ts
 * ```
 */

import 'reflect-metadata';

import { LLM } from './llm.class';

import { describe, expect, it } from 'bun:test';

const LIVE = process.env.LLM_LIVE_TEST === '1';
const OPENROUTER_API_KEY = process.env.AI_OPENROUTER_API_KEY;
const describeOpenRouterLive = LIVE && !!OPENROUTER_API_KEY?.trim() ? describe : describe.skip;

const catalogModels = [
  { key: 'openrouter:claude-opus-4.8', modelId: 'anthropic/claude-opus-4.8', reasoningRequired: false },
  { key: 'openrouter:claude-opus-5', modelId: 'anthropic/claude-opus-5', reasoningRequired: false },
  { key: 'openrouter:grok-4.6', modelId: 'x-ai/grok-4.6', reasoningRequired: true },
  { key: 'openrouter:qwen3.7-flash', modelId: 'qwen/qwen3.7-flash', reasoningRequired: false },
  { key: 'openrouter:qwen3.8-max', modelId: 'qwen/qwen3.8-max', reasoningRequired: true },
  { key: 'openrouter:minimax-m3', modelId: 'minimax/minimax-m3', reasoningRequired: false },
  { key: 'openrouter:kimi-k2.7-code', modelId: 'moonshotai/kimi-k2.7-code', reasoningRequired: true },
] as const;

function getReasoningTokens(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0;
  const details = (usage as { outputTokenDetails?: unknown }).outputTokenDetails;
  if (!details || typeof details !== 'object') return 0;
  const value = (details as { reasoningTokens?: unknown }).reasoningTokens;
  return typeof value === 'number' ? value : 0;
}

describeOpenRouterLive('OpenRouter 2026-08 model catalog (live)', () => {
  for (const { key, reasoningRequired } of catalogModels) {
    it(`invokes ${key} with the registry no-thinking policy`, async () => {
      const result = await LLM.generateText({
        id: `openrouter-catalog-live-${key.slice('openrouter:'.length).replaceAll('/', '-')}`,
        model: key,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        thinking: 'none',
        maxOutputTokens: reasoningRequired ? 512 : 256,
        maxRetries: 0,
        timeout: 45_000,
      });
      const reasoningTokens = getReasoningTokens(result.usage);

      console.log(
        `[openrouter-catalog-live] model=${key} textLength=${result.text.trim().length} reasoningTokens=${reasoningTokens}`,
      );
      expect(result.text.trim().length).toBeGreaterThan(0);
      if (reasoningRequired) expect(reasoningTokens).toBeGreaterThan(0);
    }, 60_000);
  }

  for (const { modelId } of catalogModels.filter((entry) => entry.reasoningRequired)) {
    it(`confirms ${modelId} rejects raw reasoning disable`, async () => {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'X-Title': 'nestjs-libs live capability probe',
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
          max_tokens: 64,
          reasoning: { enabled: false, effort: 'none' },
        }),
        signal: AbortSignal.timeout(45_000),
      });
      const body = await response.text();

      console.log(`[openrouter-catalog-live] model=${modelId} disableStatus=${response.status}`);
      expect(response.status).toBe(400);
      expect(body).toMatch(/reasoning is mandatory|cannot be disabled/i);
    }, 60_000);
  }
});
