import 'reflect-metadata';

import { extractProviderUsageMetadata, sumProviderReportedCost } from './llm.class';

import { describe, expect, it } from 'bun:test';

/** 构造一个只携带 openrouter usage.cost 的 step。 */
const step = (cost: unknown) => ({ providerMetadata: { openrouter: { usage: { cost } } } }) as never;

describe('sumProviderReportedCost', () => {
  it('returns the reported cost of a single step', () => {
    expect(sumProviderReportedCost([step(0.00000155)])).toBe(0.00000155);
  });

  it('accumulates across every step rather than only the final one', () => {
    // finalStep 只是 steps.at(-1)；只取它会漏掉前面所有步骤的花费
    const total = sumProviderReportedCost([step(0.001), step(0.002), step(0.004)]);
    expect(total).toBeCloseTo(0.007, 10);
  });

  it('returns undefined when any step is missing a reported cost', () => {
    // prepareStep 的 llm.model 可逐 step 切 provider；混合调用里只有 OpenRouter 步骤带 cost。
    // 返回部分和会被当成权威值并跳过兜底估算，导致非 OpenRouter 步骤被静默漏掉（低估）。
    expect(
      sumProviderReportedCost([step(0.001), { providerMetadata: undefined } as never, step(0.002)]),
    ).toBeUndefined();
  });

  it('returns undefined for an empty step list', () => {
    expect(sumProviderReportedCost([])).toBeUndefined();
  });

  it('returns undefined when no step reported a cost so callers fall back to the pricing table', () => {
    expect(sumProviderReportedCost([{ providerMetadata: undefined } as never, {} as never])).toBeUndefined();
  });

  it('ignores non-numeric cost values instead of coercing them', () => {
    expect(sumProviderReportedCost([step(null), step('0.5'), step(undefined)])).toBeUndefined();
  });

  it('treats a zero reported cost as reported, not as missing', () => {
    expect(sumProviderReportedCost([step(0)])).toBe(0);
  });

  it('returns undefined for providers that expose no openrouter metadata', () => {
    expect(sumProviderReportedCost([{ providerMetadata: { google: { usage: {} } } } as never])).toBeUndefined();
  });
});

/** 构造一个携带 provider usageMetadata 的 step。 */
const metaStep = (provider: 'vertex' | 'google', usageMetadata: unknown) =>
  ({ providerMetadata: { [provider]: { usageMetadata } } }) as never;

describe('extractProviderUsageMetadata', () => {
  it('surfaces the vertex usageMetadata that carries trafficType', () => {
    const meta = { trafficType: 'ON_DEMAND_PRIORITY', totalTokenCount: 6 };
    expect(extractProviderUsageMetadata([metaStep('vertex', meta)])).toEqual(meta);
  });

  it('falls back to the google provider key', () => {
    const meta = { trafficType: 'ON_DEMAND' };
    expect(extractProviderUsageMetadata([metaStep('google', meta)])).toEqual(meta);
  });

  it('takes the last step that has metadata, not the first', () => {
    // trafficType 是枚举不是数值，累加无意义；最后一步反映最终路由
    const first = { trafficType: 'ON_DEMAND' };
    const last = { trafficType: 'ON_DEMAND_PRIORITY' };
    expect(extractProviderUsageMetadata([metaStep('vertex', first), metaStep('vertex', last)])).toEqual(last);
  });

  it('skips steps without provider metadata while searching backwards', () => {
    const meta = { trafficType: 'ON_DEMAND' };
    expect(extractProviderUsageMetadata([metaStep('vertex', meta), { providerMetadata: undefined } as never])).toEqual(
      meta,
    );
  });

  it('returns undefined when no provider reported usage metadata', () => {
    expect(extractProviderUsageMetadata([{ providerMetadata: { openrouter: {} } } as never])).toBeUndefined();
    expect(extractProviderUsageMetadata([])).toBeUndefined();
  });

  it('treats an explicit null metadata as absent', () => {
    expect(extractProviderUsageMetadata([metaStep('vertex', null)])).toBeUndefined();
  });
});
