/**
 * AWS Bedrock live smoke test（spec S1）
 *
 * ⚠️ 不在 CI 运行：仅当显式设置 LLM_LIVE_TEST=1 且本地存在 Bedrock 凭证时执行。
 * CI（bun test --coverage）不会设置 LLM_LIVE_TEST，整个 describe 被 skip。
 *
 * 运行方式（SigV4，使用 mission-ai-v2 profile）：
 * ```bash
 * eval "$(aws configure export-credentials --profile mission-ai-v2 --format env)"
 * AI_BEDROCK_REGION=us-east-2 LLM_LIVE_TEST=1 bun test features/llm/clients/bedrock.live.spec.ts
 * ```
 *
 * 或使用 Bedrock API key：
 * ```bash
 * AI_BEDROCK_API_KEY=xxx AI_BEDROCK_REGION=us-east-2 LLM_LIVE_TEST=1 bun test features/llm/clients/bedrock.live.spec.ts
 * ```
 */

import 'reflect-metadata';

import { LLM } from './llm.class';

import { describe, expect, it } from 'bun:test';

const LIVE = process.env.LLM_LIVE_TEST === '1';
const describeLive = LIVE ? describe : describe.skip;

describeLive('bedrock live smoke (LLM_LIVE_TEST=1)', () => {
  it('generateText on bedrock:claude-haiku-4.5 returns text and usage', async () => {
    const result = await LLM.generateText({
      id: 'bedrock-live-smoke',
      model: 'bedrock:claude-haiku-4.5',
      messages: [{ role: 'user', content: 'Reply with exactly: hello bedrock' }],
      maxRetries: 0,
      timeout: 30_000,
    });

    console.log('[live-smoke] text:', result.text);
    console.log('[live-smoke] usage:', JSON.stringify(result.usage));

    expect(result.text.length).toBeGreaterThan(0);
    const usage = result.usage as Record<string, unknown>;
    const inputTokens = (usage.inputTokens ?? usage.promptTokens ?? 0) as number;
    const outputTokens = (usage.outputTokens ?? usage.completionTokens ?? 0) as number;
    expect(inputTokens).toBeGreaterThan(0);
    expect(outputTokens).toBeGreaterThan(0);
  }, 45_000);
});
