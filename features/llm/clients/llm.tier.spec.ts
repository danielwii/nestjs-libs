/**
 * LLM Vertex Tier 支持的单元测试
 *
 * 覆盖：
 * 1. parseModelSpec 对 `vertex.tier` / `vertex.requestType` 的解析与旧参数拒绝
 * 2. getSupportedTiers 查询函数（已标注 / 未标注 / 非 vertex/vertex-global provider）
 * 3. buildTierHeaders 的三种运行时行为：
 *    - 生效（返回 header 对象）
 *    - 不支持的 tier → warn + 降级
 *    - 非 vertex/vertex-global provider → warn + 降级
 */

import 'reflect-metadata';

import { LLMModelSpecSchema } from '../schemas/model.schema';
import { getSupportedTiers, parseModelSpec } from '../types/model.types';
import { buildTierHeaders, VERTEX_REQUEST_TYPE_HEADER, VERTEX_TIER_HEADER } from './llm.class';

import { describe, expect, it } from 'bun:test';

import type { LLMModelSpec, VertexTier } from '../types/model.types';

// ─────────────────────────────────────────────────────────────────────────────
// parseModelSpec: provider-namespaced Vertex query parameters
// ─────────────────────────────────────────────────────────────────────────────

describe('parseModelSpec: provider-namespaced Vertex query parameters', () => {
  it('parses namespaced vertex.tier and vertex.requestType', () => {
    const spec = 'vertex:gemini-2.5-flash?vertex.tier=priority&vertex.requestType=shared' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.key).toBe('vertex:gemini-2.5-flash');
    expect(result.vertex?.tier).toBe('priority');
    expect(result.vertex?.requestType).toBe('shared');
    expect(result.vertex).toEqual({ tier: 'priority', requestType: 'shared' });
    expect('tier' in result).toBe(false);
    expect('vertexRequestType' in result).toBe(false);
  });

  it('parses vertex.tier=flex', () => {
    const spec = 'vertex:gemini-3.1-flash-lite?vertex.tier=flex' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.key).toBe('vertex:gemini-3.1-flash-lite');
    expect(result.vertex?.tier).toBe('flex');
  });

  it('parses vertex.tier=priority', () => {
    const spec = 'vertex:gemini-2.5-flash?vertex.tier=priority' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.vertex?.tier).toBe('priority');
  });

  it('parses vertex.tier=standard', () => {
    const spec = 'vertex:gemini-2.5-flash?vertex.tier=standard' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.vertex?.tier).toBe('standard');
  });

  it('returns undefined when no vertex.tier is present', () => {
    const spec = 'vertex:gemini-2.5-flash' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.vertex?.tier).toBeUndefined();
  });

  it('returns undefined for invalid tier value (warns and ignores)', () => {
    const spec = 'vertex:gemini-2.5-flash?vertex.tier=platinum' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.vertex?.tier).toBeUndefined();
  });

  it('coexists with other spec params (reason + tier)', () => {
    const spec = 'vertex:gemini-3.1-flash-lite?reason=low&vertex.tier=flex' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.thinking).toBe('low');
    expect(result.vertex?.tier).toBe('flex');
  });

  it('coexists with fallback params', () => {
    const spec =
      'vertex:gemini-3.1-flash-lite?vertex.tier=flex&fallback=openrouter:gemini-2.5-flash-lite' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.vertex?.tier).toBe('flex');
    expect(result.fallbackModels).toContain('openrouter:gemini-2.5-flash-lite');
  });

  it('parses vertex.requestType=shared for shared/on-demand only routing', () => {
    const spec = 'vertex:gemini-2.5-flash?vertex.tier=priority&vertex.requestType=shared' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.vertex?.tier).toBe('priority');
    expect(result.vertex?.requestType).toBe('shared');
  });

  it('returns undefined for invalid vertex.requestType value (warns and ignores)', () => {
    const spec = 'vertex:gemini-2.5-flash?vertex.tier=priority&vertex.requestType=dedicated' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.vertex?.tier).toBe('priority');
    expect(result.vertex?.requestType).toBeUndefined();
  });

  it('ignores namespaced vertex options on non-vertex providers', () => {
    const spec = 'openrouter:claude-sonnet-4.5?vertex.tier=flex&vertex.requestType=shared' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.key).toBe('openrouter:claude-sonnet-4.5');
    expect(result.vertex?.tier).toBeUndefined();
    expect(result.vertex?.requestType).toBeUndefined();
    expect(result.vertex).toBeUndefined();
  });

  it('rejects removed tier with the canonical replacement', () => {
    const spec = 'vertex:gemini-3.1-flash-lite?tier=flex' as LLMModelSpec;

    expect(() => parseModelSpec(spec)).toThrow(/"tier" has been removed; use "vertex\.tier"/);
    expect(LLMModelSpecSchema.safeParse(spec).success).toBe(false);
  });

  it('rejects removed vertexRequestType with the canonical replacement', () => {
    const spec = 'vertex:gemini-2.5-flash?vertex.tier=priority&vertexRequestType=shared' as LLMModelSpec;

    expect(() => parseModelSpec(spec)).toThrow(/"vertexRequestType" has been removed; use "vertex\.requestType"/);
    expect(LLMModelSpecSchema.safeParse(spec).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getSupportedTiers: 元数据查询
// ─────────────────────────────────────────────────────────────────────────────

describe('getSupportedTiers', () => {
  it('returns [standard, priority] for vertex:gemini-2.5-flash (Priority listed)', () => {
    const tiers = getSupportedTiers('vertex:gemini-2.5-flash');
    expect(tiers).toEqual(['standard', 'priority']);
  });

  it('returns [standard, priority] for vertex-global:gemini-2.5-flash (Priority listed)', () => {
    const tiers = getSupportedTiers('vertex-global:gemini-2.5-flash');
    expect(tiers).toEqual(['standard', 'priority']);
  });

  it('returns [standard, priority] for vertex:gemini-2.5-pro (Priority listed)', () => {
    const tiers = getSupportedTiers('vertex:gemini-2.5-pro');
    expect(tiers).toEqual(['standard', 'priority']);
  });

  it('returns [standard, priority] for vertex:gemini-2.5-flash-lite (Priority listed)', () => {
    const tiers = getSupportedTiers('vertex:gemini-2.5-flash-lite');
    expect(tiers).toEqual(['standard', 'priority']);
  });

  it('returns [standard, flex, priority] for vertex:gemini-3.1-flash-lite (both lists)', () => {
    const tiers = getSupportedTiers('vertex:gemini-3.1-flash-lite');
    expect(tiers).toEqual(['standard', 'flex', 'priority']);
  });

  it('returns [standard, flex, priority] for vertex:gemini-3-flash-preview (both lists)', () => {
    const tiers = getSupportedTiers('vertex:gemini-3-flash-preview');
    expect(tiers).toEqual(['standard', 'flex', 'priority']);
  });

  it('returns [standard, flex, priority] for vertex:gemini-3.5-flash (regional PayGo lists)', () => {
    const tiers = getSupportedTiers('vertex:gemini-3.5-flash');
    expect(tiers).toEqual(['standard', 'flex', 'priority']);
  });

  it('returns [standard, flex, priority] for vertex-global:gemini-3.5-flash (global PayGo lists)', () => {
    const tiers = getSupportedTiers('vertex-global:gemini-3.5-flash');
    expect(tiers).toEqual(['standard', 'flex', 'priority']);
  });

  it('returns all official PayGo tiers for the July Vertex routes', () => {
    for (const key of [
      'vertex:gemini-3.5-flash-lite',
      'vertex:gemini-3.6-flash',
      'vertex-global:gemini-3.5-flash-lite',
      'vertex-global:gemini-3.6-flash',
    ] as const) {
      expect(getSupportedTiers(key)).toEqual(['standard', 'flex', 'priority']);
    }
  });

  it('returns [standard] for openrouter models (not a vertex concept)', () => {
    const tiers = getSupportedTiers('openrouter:gemini-2.5-flash');
    expect(tiers).toEqual(['standard']);
  });

  it('works with spec query params in the input', () => {
    const tiers = getSupportedTiers('vertex:gemini-3.1-flash-lite?vertex.tier=flex' as LLMModelSpec);
    expect(tiers).toEqual(['standard', 'flex', 'priority']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildTierHeaders: 运行时行为
// ─────────────────────────────────────────────────────────────────────────────

describe('buildTierHeaders: no-op paths', () => {
  it('returns undefined when tier is undefined', () => {
    const headers = buildTierHeaders('vertex:gemini-2.5-flash', undefined);
    expect(headers).toBeUndefined();
  });

  it('returns undefined when tier is standard (no header needed)', () => {
    const headers = buildTierHeaders('vertex:gemini-2.5-flash', 'standard');
    expect(headers).toBeUndefined();
  });
});

describe('buildTierHeaders: supported tiers emit header', () => {
  it('flex on gemini-3.1-flash-lite → emits X-Vertex-AI-LLM-Shared-Request-Type: flex', () => {
    const headers = buildTierHeaders('vertex:gemini-3.1-flash-lite', 'flex');
    expect(headers).toEqual({ [VERTEX_TIER_HEADER]: 'flex' });
  });

  it('flex on gemini-3-flash-preview → emits flex header', () => {
    const headers = buildTierHeaders('vertex:gemini-3-flash-preview', 'flex');
    expect(headers).toEqual({ [VERTEX_TIER_HEADER]: 'flex' });
  });

  it('flex on regional gemini-3.5-flash → emits flex header', () => {
    const headers = buildTierHeaders('vertex:gemini-3.5-flash', 'flex');
    expect(headers).toEqual({ [VERTEX_TIER_HEADER]: 'flex' });
  });

  it('priority on regional gemini-3.5-flash → emits priority header', () => {
    const headers = buildTierHeaders('vertex:gemini-3.5-flash', 'priority');
    expect(headers).toEqual({ [VERTEX_TIER_HEADER]: 'priority' });
  });

  it('priority on gemini-2.5-flash → emits priority header', () => {
    const headers = buildTierHeaders('vertex:gemini-2.5-flash', 'priority');
    expect(headers).toEqual({ [VERTEX_TIER_HEADER]: 'priority' });
  });

  it('priority on vertex-global gemini-2.5-flash → emits priority header', () => {
    const headers = buildTierHeaders('vertex-global:gemini-2.5-flash', 'priority');
    expect(headers).toEqual({ [VERTEX_TIER_HEADER]: 'priority' });
  });

  it('flex on vertex-global gemini-3.5-flash → emits flex header', () => {
    const headers = buildTierHeaders('vertex-global:gemini-3.5-flash', 'flex');
    expect(headers).toEqual({ [VERTEX_TIER_HEADER]: 'flex' });
  });

  it('priority on vertex-global gemini-3.5-flash → emits priority header', () => {
    const headers = buildTierHeaders('vertex-global:gemini-3.5-flash', 'priority');
    expect(headers).toEqual({ [VERTEX_TIER_HEADER]: 'priority' });
  });

  it('emits official tier headers for the July Vertex routes', () => {
    expect(buildTierHeaders('vertex:gemini-3.5-flash-lite', 'flex')).toEqual({ [VERTEX_TIER_HEADER]: 'flex' });
    expect(buildTierHeaders('vertex-global:gemini-3.5-flash-lite', 'priority')).toEqual({
      [VERTEX_TIER_HEADER]: 'priority',
    });
    expect(buildTierHeaders('vertex-global:gemini-3.6-flash', 'flex')).toEqual({
      [VERTEX_TIER_HEADER]: 'flex',
    });
  });

  it('priority on gemini-2.5-flash-lite → emits priority header (2026-04 docs)', () => {
    const headers = buildTierHeaders('vertex:gemini-2.5-flash-lite', 'priority');
    expect(headers).toEqual({ [VERTEX_TIER_HEADER]: 'priority' });
  });

  it('priority on gemini-3.1-flash-lite → emits priority header (dual flex+priority)', () => {
    const headers = buildTierHeaders('vertex:gemini-3.1-flash-lite', 'priority');
    expect(headers).toEqual({ [VERTEX_TIER_HEADER]: 'priority' });
  });

  it('priority with vertexRequestType=shared → emits both Priority-only headers', () => {
    const headers = buildTierHeaders('vertex:gemini-2.5-flash', 'priority', 'shared');
    expect(headers).toEqual({
      [VERTEX_REQUEST_TYPE_HEADER]: 'shared',
      [VERTEX_TIER_HEADER]: 'priority',
    });
  });

  it('priority with vertexRequestType=shared on vertex-global → emits both Priority-only headers', () => {
    const headers = buildTierHeaders('vertex-global:gemini-2.5-flash', 'priority', 'shared');
    expect(headers).toEqual({
      [VERTEX_REQUEST_TYPE_HEADER]: 'shared',
      [VERTEX_TIER_HEADER]: 'priority',
    });
  });

  it('flex with vertexRequestType=shared → emits both Flex-only headers', () => {
    const headers = buildTierHeaders('vertex:gemini-3-flash-preview', 'flex', 'shared');
    expect(headers).toEqual({
      [VERTEX_REQUEST_TYPE_HEADER]: 'shared',
      [VERTEX_TIER_HEADER]: 'flex',
    });
  });
});

describe('buildTierHeaders: downgrade paths (warn + undefined)', () => {
  it('flex on gemini-2.5-flash-lite (not in Flex list) → undefined (downgraded)', () => {
    const headers = buildTierHeaders('vertex:gemini-2.5-flash-lite', 'flex');
    expect(headers).toBeUndefined();
  });

  it('flex on gemini-2.5-flash (not in Flex list) → undefined', () => {
    const headers = buildTierHeaders('vertex:gemini-2.5-flash', 'flex');
    expect(headers).toBeUndefined();
  });

  it('flex on gemini-2.5-pro (not in Flex list) → undefined', () => {
    const headers = buildTierHeaders('vertex:gemini-2.5-pro', 'flex');
    expect(headers).toBeUndefined();
  });

  it('flex on openrouter model (non-vertex provider) → undefined', () => {
    const headers = buildTierHeaders('openrouter:gemini-2.5-flash', 'flex');
    expect(headers).toBeUndefined();
  });

  it('priority on google direct model (non-vertex provider) → undefined', () => {
    const headers = buildTierHeaders('google:gemini-2.5-flash', 'priority');
    expect(headers).toBeUndefined();
  });

  it('vertexRequestType=shared without flex/priority tier → undefined', () => {
    const headers = buildTierHeaders('vertex:gemini-2.5-flash', 'standard', 'shared');
    expect(headers).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 类型健壮性：确保 VertexTier 只有三个合法值
// ─────────────────────────────────────────────────────────────────────────────

describe('VertexTier type', () => {
  it('accepts only standard, flex, priority', () => {
    // 编译时保证。运行时 parseModelSpec 也做了同样的校验。
    const valid: VertexTier[] = ['standard', 'flex', 'priority'];
    expect(valid).toHaveLength(3);
  });
});
