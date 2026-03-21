import 'reflect-metadata';

import {
  getModel,
  getModelId,
  getProvider,
  isModelRegistered,
  isModelSpecValid,
  parseModelSpec,
  validateModelKey,
} from './model.types';

import { describe, expect, it } from 'bun:test';

import type { LLMModelKey, LLMModelSpec } from './model.types';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** 从 registry 取一个已知存在的 key */
const KNOWN_KEY: LLMModelKey = 'openrouter:gemini-2.5-flash';
const KNOWN_KEY_2: LLMModelKey = 'google:gemini-2.5-flash';

// ─────────────────────────────────────────────────────────────────────────────
// parseModelSpec
// ─────────────────────────────────────────────────────────────────────────────

describe('parseModelSpec', () => {
  it('should parse plain key (no params)', () => {
    const result = parseModelSpec(KNOWN_KEY);
    expect(result.key).toBe(KNOWN_KEY);
    expect(result.thinking).toBeUndefined();
    expect(result.maxRetries).toBeUndefined();
    expect(result.timeout).toBeUndefined();
    expect(result.fallbackModels).toEqual([]);
  });

  it('should parse reason param', () => {
    const spec = `${KNOWN_KEY}?reason=high` as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.key).toBe(KNOWN_KEY);
    expect(result.thinking).toBe('high');
  });

  it('should parse all valid reason values', () => {
    for (const level of ['none', 'low', 'medium', 'high'] as const) {
      const result = parseModelSpec(`${KNOWN_KEY}?reason=${level}` as LLMModelSpec);
      expect(result.thinking).toBe(level);
    }
  });

  it('should ignore invalid reason with warning (not throw)', () => {
    const spec = `${KNOWN_KEY}?reason=ultra` as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.key).toBe(KNOWN_KEY);
    expect(result.thinking).toBeUndefined();
  });

  it('should parse retry param', () => {
    const spec = `${KNOWN_KEY}?retry=5` as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.maxRetries).toBe(5);
  });

  it('should accept retry=0', () => {
    const spec = `${KNOWN_KEY}?retry=0` as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.maxRetries).toBe(0);
  });

  it('should ignore invalid retry (negative)', () => {
    const spec = `${KNOWN_KEY}?retry=-1` as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.maxRetries).toBeUndefined();
  });

  it('should ignore invalid retry (non-integer)', () => {
    const spec = `${KNOWN_KEY}?retry=abc` as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.maxRetries).toBeUndefined();
  });

  it('should parse timeout param', () => {
    const spec = `${KNOWN_KEY}?timeout=30000` as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.timeout).toBe(30000);
  });

  it('should ignore timeout < 1000ms', () => {
    const spec = `${KNOWN_KEY}?timeout=500` as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.timeout).toBeUndefined();
  });

  it('should ignore non-numeric timeout', () => {
    const spec = `${KNOWN_KEY}?timeout=fast` as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.timeout).toBeUndefined();
  });

  it('should parse fallback param with single model', () => {
    const spec = `${KNOWN_KEY}?fallback=${KNOWN_KEY_2}` as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.fallbackModels).toEqual([KNOWN_KEY_2]);
  });

  it('should parse fallback param with multiple models', () => {
    const spec = `${KNOWN_KEY}?fallback=${KNOWN_KEY_2},openrouter:gemini-2.5-pro` as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.fallbackModels).toHaveLength(2);
    expect(result.fallbackModels[0]).toBe(KNOWN_KEY_2);
    expect(result.fallbackModels[1]).toBe('openrouter:gemini-2.5-pro');
  });

  it('should skip unregistered fallback model with warning', () => {
    const spec = `${KNOWN_KEY}?fallback=nonexistent:model,${KNOWN_KEY_2}` as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.fallbackModels).toEqual([KNOWN_KEY_2]);
  });

  it('should parse all params together', () => {
    const spec = `${KNOWN_KEY}?reason=low&retry=3&timeout=45000&fallback=${KNOWN_KEY_2}` as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.key).toBe(KNOWN_KEY);
    expect(result.thinking).toBe('low');
    expect(result.maxRetries).toBe(3);
    expect(result.timeout).toBe(45000);
    expect(result.fallbackModels).toEqual([KNOWN_KEY_2]);
  });

  it('should handle empty query string gracefully', () => {
    const spec = `${KNOWN_KEY}?` as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.key).toBe(KNOWN_KEY);
    expect(result.thinking).toBeUndefined();
    expect(result.maxRetries).toBeUndefined();
    expect(result.timeout).toBeUndefined();
    expect(result.fallbackModels).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isModelRegistered / isModelSpecValid
// ─────────────────────────────────────────────────────────────────────────────

describe('isModelRegistered', () => {
  it('should return true for registered key', () => {
    expect(isModelRegistered(KNOWN_KEY)).toBe(true);
  });

  it('should return false for unregistered key', () => {
    expect(isModelRegistered('nonexistent:model')).toBe(false);
  });

  it('should return false for key with query string (strict)', () => {
    expect(isModelRegistered(`${KNOWN_KEY}?reason=low`)).toBe(false);
  });
});

describe('isModelSpecValid', () => {
  it('should return true for plain key', () => {
    expect(isModelSpecValid(KNOWN_KEY)).toBe(true);
  });

  it('should return true for key with query string', () => {
    expect(isModelSpecValid(`${KNOWN_KEY}?reason=low`)).toBe(true);
  });

  it('should return false for unregistered base key', () => {
    expect(isModelSpecValid('nonexistent:model?reason=low')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getModel / getModelId / getProvider
// ─────────────────────────────────────────────────────────────────────────────

describe('getModel', () => {
  it('should return config for plain key', () => {
    const config = getModel(KNOWN_KEY);
    expect(config.provider).toBe('openrouter');
    expect(config.modelId).toBeDefined();
  });

  it('should return config for spec with params', () => {
    const config = getModel(`${KNOWN_KEY}?reason=high&retry=3` as LLMModelSpec);
    expect(config.provider).toBe('openrouter');
  });
});

describe('getModelId', () => {
  it('should return modelId from spec', () => {
    const id = getModelId(KNOWN_KEY);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });
});

describe('getProvider', () => {
  it('should return provider from spec', () => {
    expect(getProvider(KNOWN_KEY)).toBe('openrouter');
    expect(getProvider(KNOWN_KEY_2)).toBe('google');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateModelKey
// ─────────────────────────────────────────────────────────────────────────────

describe('validateModelKey', () => {
  it('should not reject registered key as unregistered', () => {
    const result = validateModelKey(KNOWN_KEY);
    // CI 上可能没有 API key，provider 检查会失败，但 key 本身是注册的
    if (!result.valid) {
      expect(result.error).not.toContain('not registered');
    }
  });

  it('should not reject spec with query string as unregistered', () => {
    const result = validateModelKey(`${KNOWN_KEY}?reason=low`);
    if (!result.valid) {
      expect(result.error).not.toContain('not registered');
    }
  });

  it('should reject unregistered key', () => {
    const result = validateModelKey('nonexistent:model');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not registered');
  });
});
