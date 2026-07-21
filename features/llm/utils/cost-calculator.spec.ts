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
});
