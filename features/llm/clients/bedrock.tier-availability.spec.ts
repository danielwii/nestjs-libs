/**
 * LLM.checkBedrockServiceTierSupport 测试
 *
 * 通过注入 probe 模拟三种结果:接受(true)、明确不支持(false)、其他错误(unknown)。
 * 设计意图:tier 支持度随账号/区域动态变化,库不写死矩阵,只保证探测与判定逻辑正确。
 */

import { LLM } from './llm.class';

import { describe, expect, it } from 'bun:test';

describe('LLM.checkBedrockServiceTierSupport', () => {
  it('maps probe outcomes to true / false / unknown', async () => {
    const matrix = await LLM.checkBedrockServiceTierSupport({
      keys: ['bedrock:kimi-k2.5', 'bedrock:claude-sonnet-4.6', 'bedrock:nova-lite'] as any,
      tiers: ['flex'],
      probe: async (spec) => {
        if (spec.includes('claude')) {
          throw new Error('AI model error: The provided service tier is not supported for this model.');
        }
        if (spec.includes('nova-lite')) {
          throw new Error(' networking issue: ConnectionRefused');
        }
        // kimi 成功
      },
    });

    expect(matrix.length).toBe(3);
    const kimi = matrix.find((r) => r.key === 'bedrock:kimi-k2.5')!;
    const claude = matrix.find((r) => r.key === 'bedrock:claude-sonnet-4.6')!;
    const novaLite = matrix.find((r) => r.key === 'bedrock:nova-lite')!;

    expect(kimi.flex).toBe(true);
    expect(kimi.modelId).toBe('moonshotai.kimi-k2.5');
    expect(claude.flex).toBe(false);
    expect(novaLite.flex).toBe('unknown');
    expect(novaLite.errors?.flex).toContain('ConnectionRefused');
  });

  it('probes both flex and priority by default with per-tier results', async () => {
    const matrix = await LLM.checkBedrockServiceTierSupport({
      keys: ['bedrock:deepseek-v3.2'] as any,
      probe: async (spec) => {
        if (spec.includes('priority')) {
          throw new Error('The provided service tier is not supported for this model.');
        }
      },
    });

    expect(matrix[0]!.flex).toBe(true);
    expect(matrix[0]!.priority).toBe(false);
  });

  it('defaults to all registered bedrock keys', async () => {
    const matrix = await LLM.checkBedrockServiceTierSupport({ probe: async () => {} });
    expect(matrix.length).toBeGreaterThanOrEqual(12);
    expect(matrix.every((r) => r.key.startsWith('bedrock:'))).toBe(true);
    expect(matrix.every((r) => r.flex === true && r.priority === true)).toBe(true);
  });
});
