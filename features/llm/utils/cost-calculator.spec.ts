/**
 * Bedrock 成本计算测试（spec N3）
 *
 * bedrock key 通过 registry modelId 解析定价，不做字符串推导；
 * 未注册/未定价的模型返回 null。
 */

import { getCostFromUsage } from './cost-calculator';

import { describe, expect, it } from 'bun:test';

describe('getCostFromUsage bedrock', () => {
  it('resolves pricing for bedrock keys via the registry modelId', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    // us.anthropic.claude-sonnet-4-5-20250929-v1:0: $3/$15 per 1M
    expect(getCostFromUsage(usage, 'bedrock:claude-sonnet-4.5')).toBe(18);
  });

  it('resolves pricing for on-demand bedrock models', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    // moonshotai.kimi-k2.5: $0.6/$3 per 1M
    expect(getCostFromUsage(usage, 'bedrock:kimi-k2.5')).toBeCloseTo(3.6);
    // deepseek.v3.2: $0.62/$1.85 per 1M
    expect(getCostFromUsage(usage, 'bedrock:deepseek-v3.2')).toBeCloseTo(2.47);
  });

  it('returns null for unregistered bedrock keys instead of throwing', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(getCostFromUsage(usage, 'bedrock:no-such-model')).toBeNull();
  });

  it('prefers API-returned cost over manual calculation', () => {
    const usage = { cost: 0.123, inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(getCostFromUsage(usage, 'bedrock:claude-sonnet-4.5')).toBe(0.123);
  });

  it('applies flex tier multiplier (50% of on-demand)', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    // $3/$15 standard → flex: $1.5/$7.5
    expect(getCostFromUsage(usage, 'bedrock:claude-sonnet-4.5', { bedrockServiceTier: 'flex' })).toBe(9);
  });

  it('applies priority tier multiplier (1.75x of on-demand)', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    // $3/$15 standard → priority: $5.25/$26.25
    expect(getCostFromUsage(usage, 'bedrock:claude-sonnet-4.5', { bedrockServiceTier: 'priority' })).toBe(31.5);
  });

  it('returns null for reserved tier (commitment-based, not per-token)', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(getCostFromUsage(usage, 'bedrock:claude-sonnet-4.5', { bedrockServiceTier: 'reserved' })).toBeNull();
  });

  it('default tier keeps standard pricing and non-bedrock providers ignore tier context', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(getCostFromUsage(usage, 'bedrock:claude-sonnet-4.5', { bedrockServiceTier: 'default' })).toBe(18);
    // openrouter key 不受 bedrockServiceTier 影响（google/gemini-3.5-flash: $1.5/$9）
    expect(getCostFromUsage(usage, 'openrouter:gemini-3.5-flash', { bedrockServiceTier: 'flex' })).toBeCloseTo(10.5);
  });

  it('uses OpenRouter standard pricing for both Gemini 3.6 Flash aliases', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    // OpenRouter 2026-07-21 standard: $1.50/M input + $7.50/M output.
    expect(getCostFromUsage(usage, 'openrouter:gemini-3.6-flash')).toBeCloseTo(9);
    expect(getCostFromUsage(usage, 'openrouter:google/gemini-3.6-flash')).toBeCloseTo(9);
  });

  it('resolves direct Vertex pricing through the registered modelId', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(getCostFromUsage(usage, 'vertex:gemini-3.6-flash')).toBeCloseTo(9);
    expect(getCostFromUsage(usage, 'vertex-global:gemini-3.6-flash')).toBeCloseTo(9);
    expect(getCostFromUsage(usage, 'vertex:gemini-3.5-flash')).toBeCloseTo(10.5);
    expect(getCostFromUsage(usage, 'vertex-global:gemini-3.5-flash')).toBeCloseTo(10.5);
    expect(getCostFromUsage(usage, 'vertex:gemini-3.5-flash-lite')).toBeCloseTo(2.8);
    expect(getCostFromUsage(usage, 'vertex-global:gemini-3.5-flash-lite')).toBeCloseTo(2.8);
    expect(getCostFromUsage(usage, 'vertex:no-such-model')).toBeNull();
  });
});

describe('getCostFromUsage OpenRouter 2026-07 catalog additions', () => {
  const pricingCases = [
    {
      keys: ['openrouter:gemini-3.5-flash-lite', 'openrouter:google/gemini-3.5-flash-lite'],
      expected: 0.28,
    },
    { keys: ['openrouter:claude-sonnet-5', 'openrouter:anthropic/claude-sonnet-5'], expected: 1.2 },
    { keys: ['openrouter:gpt-5.6-luna', 'openrouter:openai/gpt-5.6-luna'], expected: 0.7 },
    { keys: ['openrouter:gpt-5.6-terra', 'openrouter:openai/gpt-5.6-terra'], expected: 1.75 },
    { keys: ['openrouter:gpt-5.6-sol', 'openrouter:openai/gpt-5.6-sol'], expected: 3.5 },
    { keys: ['openrouter:grok-4.5', 'openrouter:x-ai/grok-4.5'], expected: 0.8 },
    { keys: ['openrouter:kimi-k3', 'openrouter:moonshotai/kimi-k3'], expected: 1.8 },
  ] as const;

  it('uses standard per-token fallback pricing for shorthand and canonical aliases', () => {
    // 100K input stays below the GPT-5.6/Grok long-context thresholds.
    const usage = { inputTokens: 100_000, outputTokens: 100_000 };
    for (const { keys, expected } of pricingCases) {
      for (const key of keys) {
        expect(getCostFromUsage(usage, key)).toBeCloseTo(expected);
      }
    }
  });

  it('applies GPT-5.6 long-context rates to both aliases above 272K input tokens', () => {
    const usage = { inputTokens: 300_000, outputTokens: 100_000 };
    const cases = [
      { keys: ['openrouter:gpt-5.6-luna', 'openrouter:openai/gpt-5.6-luna'], expected: 1.5 },
      { keys: ['openrouter:gpt-5.6-terra', 'openrouter:openai/gpt-5.6-terra'], expected: 3.75 },
      { keys: ['openrouter:gpt-5.6-sol', 'openrouter:openai/gpt-5.6-sol'], expected: 7.5 },
    ] as const;

    for (const { keys, expected } of cases) {
      for (const key of keys) {
        expect(getCostFromUsage(usage, key)).toBeCloseTo(expected);
      }
    }
  });

  it('keeps GPT-5.6 standard rates at 272K and switches only above the threshold', () => {
    expect(getCostFromUsage({ inputTokens: 272_000, outputTokens: 100_000 }, 'openrouter:gpt-5.6-luna')).toBeCloseTo(
      0.872,
    );
    expect(getCostFromUsage({ inputTokens: 272_001, outputTokens: 100_000 }, 'openrouter:gpt-5.6-luna')).toBeCloseTo(
      1.444002,
    );
  });

  it('keeps Grok 4.5 standard rates at 200K and applies long-context rates above it', () => {
    for (const key of ['openrouter:grok-4.5', 'openrouter:x-ai/grok-4.5']) {
      expect(getCostFromUsage({ inputTokens: 200_000, outputTokens: 100_000 }, key)).toBeCloseTo(1);
      expect(getCostFromUsage({ inputTokens: 200_001, outputTokens: 100_000 }, key)).toBeCloseTo(2.000004);
    }
  });

  it('applies the existing Gemini 2.5 Pro long-context rates above 200K input tokens', () => {
    expect(getCostFromUsage({ inputTokens: 200_000, outputTokens: 100_000 }, 'openrouter:gemini-2.5-pro')).toBeCloseTo(
      1.25,
    );
    expect(getCostFromUsage({ inputTokens: 200_001, outputTokens: 100_000 }, 'openrouter:gemini-2.5-pro')).toBeCloseTo(
      2.0000025,
    );
  });
});

describe('getCostFromUsage OpenRouter 2026-08 catalog additions', () => {
  const pricingCases = [
    { keys: ['openrouter:claude-opus-4.8', 'openrouter:anthropic/claude-opus-4.8'], expected: 3 },
    { keys: ['openrouter:claude-opus-5', 'openrouter:anthropic/claude-opus-5'], expected: 3 },
    { keys: ['openrouter:grok-4.6', 'openrouter:x-ai/grok-4.6'], expected: 0.8 },
    { keys: ['openrouter:qwen3.7-flash', 'openrouter:qwen/qwen3.7-flash'], expected: 0.016 },
    { keys: ['openrouter:qwen3.8-max', 'openrouter:qwen/qwen3.8-max'], expected: 0.8 },
    { keys: ['openrouter:minimax-m3', 'openrouter:minimax/minimax-m3'], expected: 0.15 },
    { keys: ['openrouter:kimi-k2.7-code', 'openrouter:moonshotai/kimi-k2.7-code'], expected: 0.407 },
  ] as const;

  it('uses standard per-token fallback pricing for shorthand and canonical aliases', () => {
    const usage = { inputTokens: 100_000, outputTokens: 100_000 };
    for (const { keys, expected } of pricingCases) {
      for (const key of keys) {
        expect(getCostFromUsage(usage, key)).toBeCloseTo(expected);
      }
    }
  });

  it('keeps Grok 4.6 standard rates at 200K and applies long-context rates above it', () => {
    for (const key of ['openrouter:grok-4.6', 'openrouter:x-ai/grok-4.6']) {
      expect(getCostFromUsage({ inputTokens: 200_000, outputTokens: 100_000 }, key)).toBeCloseTo(1);
      expect(getCostFromUsage({ inputTokens: 200_001, outputTokens: 100_000 }, key)).toBeCloseTo(2.000004);
    }
  });
});
