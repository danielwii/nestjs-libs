import 'reflect-metadata';

import { SysEnv } from '@app/env';

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

  it('should parse openrouter.routing as provider-namespaced options', () => {
    const spec = 'openrouter:claude-sonnet-4.5?openrouter.routing=bedrock' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.provider).toBe('openrouter');
    expect(result.openrouter).toEqual({ routing: 'bedrock' });
    expect(result.vertex).toBeUndefined();
  });

  it('should ignore openrouter.routing on non-openrouter providers', () => {
    const spec = 'google:gemini-2.5-flash?openrouter.routing=bedrock' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.provider).toBe('google');
    expect(result.openrouter).toBeUndefined();
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

  it('should return Vertex direct Gemini 3.5 Flash variants', () => {
    const regional = getModel('vertex:gemini-3.5-flash');
    const global = getModel('vertex-global:gemini-3.5-flash');

    expect(regional.provider).toBe('vertex');
    expect(regional.modelId).toBe('gemini-3.5-flash');
    expect(global.provider).toBe('vertex-global');
    expect(global.modelId).toBe('gemini-3.5-flash');
  });
});

describe('getModelId', () => {
  it('should return modelId from spec', () => {
    const id = getModelId(KNOWN_KEY);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('should return modelId for Vertex direct Gemini 3.5 Flash variants', () => {
    expect(getModelId('vertex:gemini-3.5-flash')).toBe('gemini-3.5-flash');
    expect(getModelId('vertex-global:gemini-3.5-flash')).toBe('gemini-3.5-flash');
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

// ─────────────────────────────────────────────────────────────────────────────
// AWS Bedrock provider
// ─────────────────────────────────────────────────────────────────────────────

describe('bedrock model keys', () => {
  it('M1: should parse and resolve a bedrock key to its registry modelId', () => {
    const result = parseModelSpec('bedrock:claude-sonnet-4.5');
    expect(result.provider).toBe('bedrock');
    expect(result.bedrock).toBeUndefined();

    const config = getModel('bedrock:claude-sonnet-4.5');
    expect(config.provider).toBe('bedrock');
    expect(config.modelId).toBe('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
  });

  it('M1: should register the full initial bedrock model set', () => {
    const expected: Partial<Record<LLMModelKey, string>> = {
      'bedrock:claude-haiku-4.5': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      'bedrock:claude-sonnet-4.5': 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'bedrock:claude-sonnet-4.6': 'us.anthropic.claude-sonnet-4-6',
      'bedrock:claude-opus-4.5': 'us.anthropic.claude-opus-4-5-20251101-v1:0',
      'bedrock:claude-opus-4.6': 'us.anthropic.claude-opus-4-6-v1',
      'bedrock:claude-opus-4.7': 'us.anthropic.claude-opus-4-7',
      'bedrock:kimi-k2.5': 'moonshotai.kimi-k2.5',
      'bedrock:kimi-k2-thinking': 'moonshot.kimi-k2-thinking',
      'bedrock:deepseek-v3.2': 'deepseek.v3.2',
      'bedrock:minimax-m2.5': 'minimax.minimax-m2.5',
      'bedrock:nova-pro': 'us.amazon.nova-pro-v1:0',
      'bedrock:nova-lite': 'us.amazon.nova-lite-v1:0',
      'bedrock:nova-2-lite': 'us.amazon.nova-2-lite-v1:0',
    };
    for (const [key, modelId] of Object.entries(expected)) {
      expect(isModelRegistered(key)).toBe(true);
      expect(getModelId(key as LLMModelKey)).toBe(modelId);
    }
  });

  it('M1: should mark kimi-k2-thinking and minimax-m2.5 as reasoningRequired', () => {
    expect(getModel('bedrock:kimi-k2-thinking').reasoningRequired).toBe(true);
    expect(getModel('bedrock:minimax-m2.5').reasoningRequired).toBe(true);
  });

  it('M2: should parse bedrock.serviceTier as provider-namespaced options', () => {
    const spec = 'bedrock:claude-haiku-4.5?bedrock.serviceTier=flex' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.provider).toBe('bedrock');
    expect(result.bedrock).toEqual({ serviceTier: 'flex' });
    expect(result.vertex).toBeUndefined();
    expect(result.openrouter).toBeUndefined();
  });

  it('M2: should parse all valid bedrock.serviceTier values', () => {
    for (const tier of ['default', 'reserved', 'priority', 'flex'] as const) {
      const result = parseModelSpec(`bedrock:claude-haiku-4.5?bedrock.serviceTier=${tier}` as LLMModelSpec);
      expect(result.bedrock).toEqual({ serviceTier: tier });
    }
  });

  it('M3: should ignore bedrock.serviceTier on non-bedrock providers with warning', () => {
    const spec = 'openrouter:claude-sonnet-4.5?bedrock.serviceTier=flex' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.provider).toBe('openrouter');
    expect(result.bedrock).toBeUndefined();
  });

  it('M4: should ignore invalid bedrock.serviceTier value with warning', () => {
    const spec = 'bedrock:claude-haiku-4.5?bedrock.serviceTier=turbo' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.provider).toBe('bedrock');
    expect(result.bedrock).toBeUndefined();
  });

  it('N2: should keep a bedrock fallback model in the chain', () => {
    const spec = 'openrouter:gemini-3.5-flash?fallback=bedrock:claude-haiku-4.5' as LLMModelSpec;
    const result = parseModelSpec(spec);
    expect(result.fallbackModels).toEqual(['bedrock:claude-haiku-4.5']);
  });

  it('M13: validateModelKey should fail a bedrock key when no credentials are configured', () => {
    const sysEnvMut = SysEnv as unknown as Record<string, string | undefined>;
    const savedSysKey = sysEnvMut.AI_BEDROCK_API_KEY;
    const savedBearer = process.env.AWS_BEARER_TOKEN_BEDROCK;
    const savedAkid = process.env.AWS_ACCESS_KEY_ID;
    const savedSecret = process.env.AWS_SECRET_ACCESS_KEY;
    delete sysEnvMut.AI_BEDROCK_API_KEY;
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    try {
      const result = validateModelKey('bedrock:claude-haiku-4.5');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('bedrock');
      expect(result.error).toContain('AI_BEDROCK_API_KEY');
    } finally {
      if (savedSysKey !== undefined) sysEnvMut.AI_BEDROCK_API_KEY = savedSysKey;
      if (savedBearer !== undefined) process.env.AWS_BEARER_TOKEN_BEDROCK = savedBearer;
      if (savedAkid !== undefined) process.env.AWS_ACCESS_KEY_ID = savedAkid;
      if (savedSecret !== undefined) process.env.AWS_SECRET_ACCESS_KEY = savedSecret;
    }
  });

  it('M13: validateModelKey should pass a bedrock key when AI_BEDROCK_API_KEY is set', () => {
    const sysEnvMut = SysEnv as unknown as Record<string, string | undefined>;
    const savedSysKey = sysEnvMut.AI_BEDROCK_API_KEY;
    sysEnvMut.AI_BEDROCK_API_KEY = 'test-bedrock-key';
    try {
      const result = validateModelKey('bedrock:claude-haiku-4.5');
      expect(result.valid).toBe(true);
    } finally {
      if (savedSysKey === undefined) delete sysEnvMut.AI_BEDROCK_API_KEY;
      else sysEnvMut.AI_BEDROCK_API_KEY = savedSysKey;
    }
  });

  it('M13: validateModelKey should pass a bedrock key when SigV4 env credentials are set', () => {
    const sysEnvMut = SysEnv as unknown as Record<string, string | undefined>;
    const savedSysKey = sysEnvMut.AI_BEDROCK_API_KEY;
    const savedAkid = process.env.AWS_ACCESS_KEY_ID;
    const savedSecret = process.env.AWS_SECRET_ACCESS_KEY;
    delete sysEnvMut.AI_BEDROCK_API_KEY;
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    process.env.AWS_ACCESS_KEY_ID = 'test-akid';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
    try {
      const result = validateModelKey('bedrock:claude-haiku-4.5');
      expect(result.valid).toBe(true);
    } finally {
      if (savedSysKey !== undefined) sysEnvMut.AI_BEDROCK_API_KEY = savedSysKey;
      if (savedAkid === undefined) delete process.env.AWS_ACCESS_KEY_ID;
      else process.env.AWS_ACCESS_KEY_ID = savedAkid;
      if (savedSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = savedSecret;
    }
  });
});
