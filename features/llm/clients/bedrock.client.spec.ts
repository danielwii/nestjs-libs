/**
 * AWS Bedrock provider options helpers 测试
 *
 * 覆盖 spec 的 M7-M10：reasoningConfig 按模型家族映射
 * （anthropic → budgetTokens，nova 2 → maxReasoningEffort，其他 → warn + 空）。
 */

import { autoOpts } from './auto.client';
import { bedrockServiceTierOptions, bedrockThinkingOptions, inferBedrockReasoningFamily } from './bedrock.client';

import { describe, expect, it } from 'bun:test';

describe('inferBedrockReasoningFamily', () => {
  it('should detect anthropic family incl. cross-region/global profile prefixes', () => {
    expect(inferBedrockReasoningFamily('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('anthropic');
    expect(inferBedrockReasoningFamily('global.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('anthropic');
    expect(inferBedrockReasoningFamily('anthropic.claude-opus-4-6-v1')).toBe('anthropic');
  });

  it('should detect amazon nova 2 family', () => {
    expect(inferBedrockReasoningFamily('us.amazon.nova-2-lite-v1:0')).toBe('amazon-nova');
    expect(inferBedrockReasoningFamily('amazon.nova-2-lite-v1:0')).toBe('amazon-nova');
  });

  it('should treat nova 1 and other model families as other', () => {
    expect(inferBedrockReasoningFamily('us.amazon.nova-pro-v1:0')).toBe('other');
    expect(inferBedrockReasoningFamily('us.amazon.nova-lite-v1:0')).toBe('other');
    expect(inferBedrockReasoningFamily('moonshotai.kimi-k2.5')).toBe('other');
    expect(inferBedrockReasoningFamily('moonshot.kimi-k2-thinking')).toBe('other');
    expect(inferBedrockReasoningFamily('deepseek.v3.2')).toBe('other');
    expect(inferBedrockReasoningFamily('minimax.minimax-m2.5')).toBe('other');
  });
});

describe('bedrockThinkingOptions', () => {
  it('M7: none on reasoning-capable families disables reasoning', () => {
    expect(bedrockThinkingOptions('us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'none')).toEqual({
      bedrock: { reasoningConfig: { type: 'disabled' } },
    });
    expect(bedrockThinkingOptions('us.amazon.nova-2-lite-v1:0', 'none')).toEqual({
      bedrock: { reasoningConfig: { type: 'disabled' } },
    });
  });

  it('M8: effort maps to budgetTokens for anthropic models', () => {
    expect(bedrockThinkingOptions('us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'low')).toEqual({
      bedrock: { reasoningConfig: { type: 'enabled', budgetTokens: 1024 } },
    });
    expect(bedrockThinkingOptions('us.anthropic.claude-opus-4-6-v1', 'medium')).toEqual({
      bedrock: { reasoningConfig: { type: 'enabled', budgetTokens: 4096 } },
    });
    expect(bedrockThinkingOptions('us.anthropic.claude-haiku-4-5-20251001-v1:0', 'high')).toEqual({
      bedrock: { reasoningConfig: { type: 'enabled', budgetTokens: 8192 } },
    });
  });

  it('M9: effort maps to maxReasoningEffort for nova 2 models', () => {
    expect(bedrockThinkingOptions('us.amazon.nova-2-lite-v1:0', 'medium')).toEqual({
      bedrock: { reasoningConfig: { type: 'enabled', maxReasoningEffort: 'medium' } },
    });
  });

  it('M10: effort on unsupported family is dropped with warning', () => {
    expect(bedrockThinkingOptions('moonshotai.kimi-k2.5', 'low')).toEqual({});
    expect(bedrockThinkingOptions('deepseek.v3.2', 'high')).toEqual({});
  });

  it('none on unsupported family is a silent no-op (nothing to disable)', () => {
    expect(bedrockThinkingOptions('moonshotai.kimi-k2.5', 'none')).toEqual({});
  });
});

describe('bedrockServiceTierOptions', () => {
  it('should emit serviceTier under the bedrock namespace', () => {
    expect(bedrockServiceTierOptions('flex')).toEqual({ bedrock: { serviceTier: 'flex' } });
  });
});

describe('autoOpts bedrock branch', () => {
  it('M7: noThinking maps to reasoningConfig disabled', () => {
    expect(autoOpts.noThinking('bedrock:claude-haiku-4.5')).toEqual({
      bedrock: { reasoningConfig: { type: 'disabled' } },
    });
  });

  it('M8: thinking maps to budgetTokens for claude keys', () => {
    expect(autoOpts.thinking('bedrock:claude-sonnet-4.5', 'low')).toEqual({
      bedrock: { reasoningConfig: { type: 'enabled', budgetTokens: 1024 } },
    });
  });

  it('M9: thinking maps to maxReasoningEffort for nova 2 keys', () => {
    expect(autoOpts.thinking('bedrock:nova-2-lite', 'medium')).toEqual({
      bedrock: { reasoningConfig: { type: 'enabled', maxReasoningEffort: 'medium' } },
    });
  });

  it('M10: thinking on unsupported family returns empty options', () => {
    expect(autoOpts.thinking('bedrock:kimi-k2.5', 'low')).toEqual({});
  });

  it('bare provider name cannot infer family and returns empty options with warning', () => {
    expect(autoOpts.noThinking('bedrock')).toEqual({});
    expect(autoOpts.thinking('bedrock', 'low')).toEqual({});
  });
});
