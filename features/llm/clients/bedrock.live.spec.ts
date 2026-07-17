/**
 * AWS Bedrock live smoke test（spec S1）
 *
 * ⚠️ 不在 CI 运行：仅当显式设置 LLM_LIVE_TEST=1 且本地存在 Bedrock 凭证时执行。
 * CI（bun test --coverage）不会设置 LLM_LIVE_TEST，整个 describe 被 skip。
 *
 * 运行方式（凭证已在 .env 中配置时）：
 * ```bash
 * LLM_LIVE_TEST=1 bun test features/llm/clients/bedrock.live.spec.ts
 * ```
 *
 * 或使用其他 profile 的 SigV4 凭证：
 * ```bash
 * eval "$(aws configure export-credentials --profile <name> --format env)"
 * AI_BEDROCK_REGION=us-east-2 LLM_LIVE_TEST=1 bun test features/llm/clients/bedrock.live.spec.ts
 * ```
 */

import 'reflect-metadata';

import { getRegisteredModels } from '../types/model.types';
import { LLM } from './llm.class';

import { describe, expect, it } from 'bun:test';

import type { LLMModelSpec } from '../types/model.types';

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

  it('every registered bedrock:* key is actually invocable on this account', async () => {
    // get-foundation-model-availability 可能误报（opus-4.7 曾 AUTHORIZED 但不可调用），
    // 只有真实调用能证明 key 可用；发现不可用的 key 应从 registry 移除。
    const keys = getRegisteredModels().filter((k) => k.startsWith('bedrock:')) as LLMModelSpec[];
    expect(keys.length).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const key of keys) {
      try {
        const r = await LLM.generateText({
          id: 'live-invocability',
          model: key,
          messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
          maxRetries: 0,
          timeout: 60_000,
        });
        console.log(`[live-smoke] ${key}: OK ${JSON.stringify(r.text.slice(0, 20))}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`[live-smoke] ${key}: FAIL ${msg.slice(0, 160)}`);
        failures.push(key);
      }
    }

    expect(failures).toEqual([]);
  }, 600_000);
});
