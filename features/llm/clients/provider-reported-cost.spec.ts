import 'reflect-metadata';

import { sumProviderReportedCost } from './llm.class';

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

  it('sums only the steps that reported a cost', () => {
    expect(sumProviderReportedCost([step(0.001), { providerMetadata: undefined } as never, step(0.002)])).toBeCloseTo(
      0.003,
      10,
    );
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
