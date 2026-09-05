/**
 * OpenRouter 2026-09 model catalog smoke/capability evidence.
 *
 * Not run in CI. Execute with a real OpenRouter credential:
 * ```bash
 * bun test ./features/llm/clients/openrouter.2026-09-models.spec.live.ts
 * ```
 */

import 'reflect-metadata';

import { LLM } from './llm.class';

import { describe, expect, it } from 'bun:test';

import type { LLMModelSpec } from '../types/model.types';

const OPENROUTER_API_KEY = process.env.AI_OPENROUTER_API_KEY;
const describeOpenRouterLive = OPENROUTER_API_KEY?.trim() ? describe : describe.skip;

interface CatalogModel {
  readonly key: LLMModelSpec;
  readonly modelId: string;
  readonly reasoningRequired: boolean;
}

const catalogModels: readonly CatalogModel[] = [
  { key: 'openrouter:gemini-3.8-flash', modelId: 'google/gemini-3.8-flash', reasoningRequired: true },
];

function getReasoningTokens(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0;
  const details = (usage as { outputTokenDetails?: unknown }).outputTokenDetails;
  if (!details || typeof details !== 'object') return 0;
  const value = (details as { reasoningTokens?: unknown }).reasoningTokens;
  return typeof value === 'number' ? value : 0;
}

describeOpenRouterLive('OpenRouter 2026-09 model catalog (live)', () => {
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
      const reportedCost = (result.usage as { cost?: number }).cost;

      console.log(
        `[openrouter-catalog-live] model=${key} textLength=${result.text.trim().length}` +
          ` reasoningTokens=${reasoningTokens} reportedCost=${reportedCost}`,
      );
      expect(result.text.trim().length).toBeGreaterThan(0);
      // 不断言 reasoningTokens > 0：reasoningRequired 的语义是「API 拒绝 disable reasoning」
      // （由下方 400 探测守护），不等于每次调用都产生 reasoning token —— low effort 下
      // 模型可以思考 0 token。实测 gemini-3.7/3.8 在 thinking:'none' 下该值在 0 与数十之间波动，
      // 断言它 > 0 会得到一个 flaky 测试（2026-08 那份 spec 就有这个问题）。
      // provider 报告的权威成本必须流到 usage —— 否则成本核算会静默退回标价估算
      expect(reportedCost).toBeGreaterThan(0);
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
