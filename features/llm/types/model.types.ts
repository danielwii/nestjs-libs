/**
 * LLM Model Registry 类型定义
 *
 * 设计意图：
 * - Provider 和 Model 直接绑定（一个 Model Key 对应一个 Provider）
 * - Key 格式：provider:model（如 openrouter:gemini-2.5-flash）
 * - 同一模型可通过不同 Provider 访问（如 openrouter:gemini vs google:gemini）
 * - Provider 类型从 Model Registry 自动推导，无需单独维护
 *
 * Fallback 机制：
 * - 开发环境：model 不存在时直接报错（fail fast）
 * - 生产环境：model 不存在时 warning + fallback 到 DEFAULT_LLM_MODEL
 *
 * 扩展方式：
 * ```typescript
 * declare module '@app/llm-core' {
 *   interface LLMModelRegistry {
 *     'moonshot:kimi-k2': ModelConfig<'moonshot'>;
 *   }
 * }
 * registerModel('moonshot:kimi-k2', { provider: 'moonshot', modelId: 'kimi-k2' });
 * ```
 */

import { Logger } from '@nestjs/common';

import { getLLMModelFields, SysEnv } from '@app/env';

/**
 * Model 配置接口
 */
export interface ModelConfig<P extends string = string> {
  /** Provider 标识 */
  provider: P;
  /** 实际 API Model ID（发送给 Provider 的值） */
  modelId: string;
  /** UI 显示名称（可选） */
  displayName?: string;
}

/**
 * Model Registry 接口（项目层可通过 Declaration Merging 扩展）
 *
 * Key 格式：provider:model
 */
/**
 * Model Registry 接口（项目层可通过 Declaration Merging 扩展）
 *
 * Key 格式：provider:model
 *
 * OpenRouter Key 支持两种格式（等价，并存）：
 * - 简称：openrouter:gemini-2.5-flash
 * - 全称：openrouter:google/gemini-2.5-flash（与 OpenRouter modelId 一致）
 *
 * OpenRouter Provider 定价差异：
 * 各 provider 定价不同，选型时可通过 providerSort（price/throughput/latency）控制路由偏好。
 *
 * @see https://openrouter.ai/models
 */
export interface LLMModelRegistry {
  // ==================== OpenRouter ====================
  /**
   * Gemini 2.5 Flash
   *
   * 定价参考（2026.02）：Input $0.30/M, Output $2.50/M, Context 1M
   *
   * @see https://openrouter.ai/google/gemini-2.5-flash
   */
  'openrouter:gemini-2.5-flash': ModelConfig<'openrouter'>;
  'openrouter:google/gemini-2.5-flash': ModelConfig<'openrouter'>;
  /**
   * Gemini 2.5 Pro
   *
   * 定价参考（2026.02）：Input $1.25/M, Output $10/M（≤200K），Context 1M
   *
   * @see https://openrouter.ai/google/gemini-2.5-pro
   */
  'openrouter:gemini-2.5-pro': ModelConfig<'openrouter'>;
  'openrouter:google/gemini-2.5-pro': ModelConfig<'openrouter'>;
  /**
   * Gemini 2.5 Flash Lite
   *
   * 定价参考（2026.02）：Input $0.10/M, Output $0.40/M, Context 1M
   *
   * @see https://openrouter.ai/google/gemini-2.5-flash-lite
   */
  'openrouter:gemini-2.5-flash-lite': ModelConfig<'openrouter'>;
  'openrouter:google/gemini-2.5-flash-lite': ModelConfig<'openrouter'>;
  /**
   * Gemini 3 Flash Preview - Tool Calling #1
   *
   * 定价参考（2026.02）：Input $0.50/M, Output $3/M, Context 1M
   *
   * @see https://openrouter.ai/google/gemini-3-flash-preview
   */
  'openrouter:gemini-3-flash-preview': ModelConfig<'openrouter'>;
  'openrouter:google/gemini-3-flash-preview': ModelConfig<'openrouter'>;
  /**
   * Claude 3.5 Sonnet
   *
   * 定价参考（2026.02）：Input $6/M, Output $30/M, Context 200K
   *
   * @see https://openrouter.ai/anthropic/claude-3.5-sonnet
   */
  'openrouter:claude-3.5-sonnet': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-3.5-sonnet': ModelConfig<'openrouter'>;
  /**
   * Claude 3.5 Haiku
   *
   * 定价参考（2026.02）：Input $0.80/M, Output $4/M, Context 200K
   *
   * @see https://openrouter.ai/anthropic/claude-3.5-haiku
   */
  'openrouter:claude-3.5-haiku': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-3.5-haiku': ModelConfig<'openrouter'>;
  /**
   * Claude 4 Sonnet
   *
   * 定价参考（2026.02）：Input $3/M, Output $15/M（≤200K），Context 1M
   *
   * @see https://openrouter.ai/anthropic/claude-sonnet-4
   */
  'openrouter:claude-4-sonnet': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-sonnet-4': ModelConfig<'openrouter'>;
  /**
   * Claude Sonnet 4.5
   *
   * 定价参考（2026.02）：Input $3/M, Output $15/M, Context 1M
   *
   * @see https://openrouter.ai/anthropic/claude-sonnet-4.5
   */
  'openrouter:claude-sonnet-4.5': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-sonnet-4.5': ModelConfig<'openrouter'>;
  /**
   * Claude Opus 4.1
   *
   * 定价参考（2026.02）：Input $15/M, Output $75/M, Context 200K
   *
   * @see https://openrouter.ai/anthropic/claude-opus-4.1
   */
  'openrouter:claude-4.1-opus': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-opus-4.1': ModelConfig<'openrouter'>;
  /**
   * Claude Opus 4.5 - 最强 coding
   *
   * 定价参考（2026.02）：Input $5/M, Output $25/M, Context 200K
   *
   * @see https://openrouter.ai/anthropic/claude-opus-4.5
   */
  'openrouter:claude-opus-4.5': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-opus-4.5': ModelConfig<'openrouter'>;
  /**
   * GPT-4o Mini
   *
   * 定价参考（2026.02）：Input $0.15/M, Output $0.60/M, Context 128K
   *
   * @see https://openrouter.ai/openai/gpt-4o-mini
   */
  'openrouter:gpt-4o-mini': ModelConfig<'openrouter'>;
  'openrouter:openai/gpt-4o-mini': ModelConfig<'openrouter'>;
  /**
   * Grok 3 Mini - thinking
   *
   * 定价参考（2026.02）：Input $0.30/M, Output $0.50/M, Context 131K
   *
   * @see https://openrouter.ai/x-ai/grok-3-mini
   */
  'openrouter:grok-3-mini': ModelConfig<'openrouter'>;
  'openrouter:x-ai/grok-3-mini': ModelConfig<'openrouter'>;
  /**
   * Grok 4.1 Fast - best tool calling
   *
   * 定价参考（2026.02）：Input $0.20/M, Output $0.50/M, Context 2M
   *
   * ⚠️ 注意：reasoning 无法关闭！
   * - noThinking 参数对此模型无效
   * - TTFT 固定 12-17 秒（模型内部始终进行 reasoning）
   * - 不适合需要低延迟的场景（如实时对话）
   *
   * @see https://openrouter.ai/x-ai/grok-4.1-fast
   * @see ~/.claude/gotchas/openrouter-grok-reasoning-cannot-disable.md
   */
  'openrouter:grok-4.1-fast': ModelConfig<'openrouter'>;
  'openrouter:x-ai/grok-4.1-fast': ModelConfig<'openrouter'>;
  /**
   * DeepSeek V3.2 - Roleplay #1
   *
   * 定价参考（2026.02）：Input $0.26/M, Output $0.38/M, Context 164K
   *
   * 特点：
   * - Roleplay 排名 #1
   * - 支持 reasoning 模式（可通过 reasoning_enabled 控制）
   * - DSA 稀疏注意力，长上下文高效
   * - GPT-5 级别推理能力
   *
   * Provider 定价（选型时注意）：
   * | Provider | Input | Output |
   * |----------|-------|--------|
   * | DeepInfra / AtlasCloud | $0.26 | $0.38 |
   * | NovitaAI | $0.269 | $0.40 |
   * | SiliconFlow | $0.27 | $0.42 |
   * | Parasail | $0.28 | $0.45 |
   * | Google Vertex | $0.56 | $1.68 | ← 贵 2-4x，慎用
   *
   * 建议：providerSort: 'price' 优先低价 provider
   */
  'openrouter:deepseek-v3.2': ModelConfig<'openrouter'>;
  'openrouter:deepseek/deepseek-v3.2': ModelConfig<'openrouter'>;
  /**
   * Kimi K2.5 - MoonshotAI 多模态模型
   *
   * 定价参考（2026.02）：Input $0.23/M, Output $3/M, Context 262K
   *
   * 视觉编码、Agent 工具调用能力强
   *
   * Provider 定价（选型时注意）：
   * | Provider | Input | Output |
   * |----------|-------|--------|
   * | SiliconFlow | $0.23 | $3 | ← 最低价
   * | DeepInfra | $0.45 | $2.25 |
   * | Inceptron / AtlasCloud / Together | $0.50 | $2.40-2.80 |
   * | NovitaAI / Moonshot / Fireworks / Baseten | $0.60 | $2.85-3 |
   * | Venice | $0.75 | $3.75 | ← 贵 2-3x
   *
   * 建议：providerSort: 'price' 优先 SiliconFlow
   *
   * @see https://openrouter.ai/moonshotai/kimi-k2.5
   */
  'openrouter:kimi-k2.5': ModelConfig<'openrouter'>;
  'openrouter:moonshotai/kimi-k2.5': ModelConfig<'openrouter'>;
  /**
   * GLM 5 - Z.ai 开源旗舰模型
   *
   * 定价参考（2026.02）：Input $0.30/M, Output $2.55/M, Context 205K
   *
   * 复杂系统设计、长时程 Agent 工作流，Programming #3、Science #6、Roleplay #7
   *
   * Provider 定价（选型时注意）：
   * | Provider | Input | Output |
   * |----------|-------|--------|
   * | SiliconFlow | $0.30 | $2.55 | ← 最低价
   * | AtlasCloud | $0.95 | $3.15 |
   * | Friendli / GMICloud / Parasail / Venice | $1 | $3.20 | ← 贵 3x
   *
   * 建议：providerSort: 'price' 优先 SiliconFlow
   *
   * @see https://openrouter.ai/z-ai/glm-5
   */
  'openrouter:glm-5': ModelConfig<'openrouter'>;
  'openrouter:z-ai/glm-5': ModelConfig<'openrouter'>;

  // ==================== Google Direct ====================
  'google:gemini-2.5-flash': ModelConfig<'google'>;
  'google:gemini-2.5-pro': ModelConfig<'google'>;
  'google:gemini-2.5-flash-lite': ModelConfig<'google'>;
  'google:gemini-3-flash-preview': ModelConfig<'google'>;

  // ==================== Vertex AI (Express Mode) ====================
  'vertex:gemini-2.5-flash': ModelConfig<'vertex'>;
  'vertex:gemini-2.5-pro': ModelConfig<'vertex'>;
  'vertex:gemini-2.5-flash-lite': ModelConfig<'vertex'>;
  'vertex:gemini-3-flash-preview': ModelConfig<'vertex'>;
}

/**
 * 从 Registry 推导的 Model Key 联合类型
 */
export type LLMModelKey = keyof LLMModelRegistry;

/**
 * 从 Registry 推导的 Provider 联合类型
 * 会自动包含所有注册的 Provider
 */
export type LLMProviderType = LLMModelRegistry[LLMModelKey]['provider'];

// ==================== 运行时 Registry ====================

const modelRegistry = new Map<string, ModelConfig>([
  // OpenRouter 模型（简称 + 全称成对，按模型分组）
  // Gemini 2.5 Flash
  ['openrouter:gemini-2.5-flash', { provider: 'openrouter', modelId: 'google/gemini-2.5-flash' }],
  ['openrouter:google/gemini-2.5-flash', { provider: 'openrouter', modelId: 'google/gemini-2.5-flash' }],
  // Gemini 2.5 Pro
  ['openrouter:gemini-2.5-pro', { provider: 'openrouter', modelId: 'google/gemini-2.5-pro' }],
  ['openrouter:google/gemini-2.5-pro', { provider: 'openrouter', modelId: 'google/gemini-2.5-pro' }],
  // Gemini 2.5 Flash Lite
  ['openrouter:gemini-2.5-flash-lite', { provider: 'openrouter', modelId: 'google/gemini-2.5-flash-lite' }],
  ['openrouter:google/gemini-2.5-flash-lite', { provider: 'openrouter', modelId: 'google/gemini-2.5-flash-lite' }],
  // Gemini 3 Flash Preview
  ['openrouter:gemini-3-flash-preview', { provider: 'openrouter', modelId: 'google/gemini-3-flash-preview' }],
  ['openrouter:google/gemini-3-flash-preview', { provider: 'openrouter', modelId: 'google/gemini-3-flash-preview' }],
  // Claude 3.5 Sonnet
  ['openrouter:claude-3.5-sonnet', { provider: 'openrouter', modelId: 'anthropic/claude-3.5-sonnet' }],
  ['openrouter:anthropic/claude-3.5-sonnet', { provider: 'openrouter', modelId: 'anthropic/claude-3.5-sonnet' }],
  // Claude 3.5 Haiku
  ['openrouter:claude-3.5-haiku', { provider: 'openrouter', modelId: 'anthropic/claude-3.5-haiku' }],
  ['openrouter:anthropic/claude-3.5-haiku', { provider: 'openrouter', modelId: 'anthropic/claude-3.5-haiku' }],
  // Claude 4 Sonnet
  ['openrouter:claude-4-sonnet', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4' }],
  ['openrouter:anthropic/claude-sonnet-4', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4' }],
  // Claude Sonnet 4.5
  ['openrouter:claude-sonnet-4.5', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4.5' }],
  ['openrouter:anthropic/claude-sonnet-4.5', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4.5' }],
  // Claude Opus 4.1
  ['openrouter:claude-4.1-opus', { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.1' }],
  ['openrouter:anthropic/claude-opus-4.1', { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.1' }],
  // Claude Opus 4.5
  ['openrouter:claude-opus-4.5', { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.5' }],
  ['openrouter:anthropic/claude-opus-4.5', { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.5' }],
  // GPT-4o Mini
  ['openrouter:gpt-4o-mini', { provider: 'openrouter', modelId: 'openai/gpt-4o-mini' }],
  ['openrouter:openai/gpt-4o-mini', { provider: 'openrouter', modelId: 'openai/gpt-4o-mini' }],
  // Grok 3 Mini
  ['openrouter:grok-3-mini', { provider: 'openrouter', modelId: 'x-ai/grok-3-mini' }],
  ['openrouter:x-ai/grok-3-mini', { provider: 'openrouter', modelId: 'x-ai/grok-3-mini' }],
  // Grok 4.1 Fast
  ['openrouter:grok-4.1-fast', { provider: 'openrouter', modelId: 'x-ai/grok-4.1-fast' }],
  ['openrouter:x-ai/grok-4.1-fast', { provider: 'openrouter', modelId: 'x-ai/grok-4.1-fast' }],
  // DeepSeek V3.2
  ['openrouter:deepseek-v3.2', { provider: 'openrouter', modelId: 'deepseek/deepseek-v3.2' }],
  ['openrouter:deepseek/deepseek-v3.2', { provider: 'openrouter', modelId: 'deepseek/deepseek-v3.2' }],
  // Kimi K2.5
  ['openrouter:kimi-k2.5', { provider: 'openrouter', modelId: 'moonshotai/kimi-k2.5' }],
  ['openrouter:moonshotai/kimi-k2.5', { provider: 'openrouter', modelId: 'moonshotai/kimi-k2.5' }],
  // GLM 5
  ['openrouter:glm-5', { provider: 'openrouter', modelId: 'z-ai/glm-5' }],
  ['openrouter:z-ai/glm-5', { provider: 'openrouter', modelId: 'z-ai/glm-5' }],

  // Google Direct 模型
  ['google:gemini-2.5-flash', { provider: 'google', modelId: 'gemini-2.5-flash' }],
  ['google:gemini-2.5-pro', { provider: 'google', modelId: 'gemini-2.5-pro' }],
  ['google:gemini-2.5-flash-lite', { provider: 'google', modelId: 'gemini-2.5-flash-lite' }],
  ['google:gemini-3-flash-preview', { provider: 'google', modelId: 'gemini-3-flash-preview' }],

  // Vertex AI 模型 (Express Mode)
  ['vertex:gemini-2.5-flash', { provider: 'vertex', modelId: 'gemini-2.5-flash' }],
  ['vertex:gemini-2.5-pro', { provider: 'vertex', modelId: 'gemini-2.5-pro' }],
  ['vertex:gemini-2.5-flash-lite', { provider: 'vertex', modelId: 'gemini-2.5-flash-lite' }],
  ['vertex:gemini-3-flash-preview', { provider: 'vertex', modelId: 'gemini-3-flash-preview' }],
]);

// ==================== 注册函数 ====================

/**
 * 注册新的 Model（项目层扩展时调用）
 *
 * @example
 * registerModel('moonshot:kimi-k2', { provider: 'moonshot', modelId: 'kimi-k2-turbo-preview' });
 */
export function registerModel<K extends string, P extends string>(key: K, config: ModelConfig<P>): void {
  modelRegistry.set(key, config);
}

// ==================== 查询函数 ====================

const logger = new Logger('LLMModel');

/**
 * 获取 Model 配置
 *
 * Fallback 机制：
 * - 开发环境：model 不存在时直接报错（fail fast）
 * - 生产环境：model 不存在时 warning + fallback 到 DEFAULT_LLM_MODEL
 */
export function getModel(key: LLMModelKey): ModelConfig {
  const config = modelRegistry.get(key);
  if (config) {
    return config;
  }

  // Model 不存在，检查环境决定处理方式
  const fallbackKey = SysEnv.DEFAULT_LLM_MODEL;
  const isProd = SysEnv.environment.isProd;

  if (!isProd) {
    // 开发环境：直接报错，快速发现问题
    throw new Error(`Unknown model: "${key}". Registered models: ${getRegisteredModels().join(', ')}`);
  }

  // 生产环境：warning + fallback
  const fallbackConfig = modelRegistry.get(fallbackKey as string);
  if (!fallbackConfig) {
    // fallback 模型也不存在，必须报错
    throw new Error(
      `Unknown model: "${key}" and fallback model "${fallbackKey}" is also not registered. ` +
        `Check DEFAULT_LLM_MODEL configuration.`,
    );
  }

  logger.warn(
    `#getModel Unknown model "${key}", falling back to "${fallbackKey}". ` +
      `This indicates a configuration issue that should be fixed.`,
  );

  return fallbackConfig;
}

/**
 * 获取实际 API Model ID
 *
 * @example
 * getModelId('openrouter:claude-3.5-sonnet') // → 'anthropic/claude-3.5-sonnet'
 */
export function getModelId(key: LLMModelKey): string {
  return getModel(key).modelId;
}

/**
 * 获取 Provider
 *
 * @example
 * getProvider('openrouter:gemini-2.5-flash') // → 'openrouter'
 */
export function getProvider(key: LLMModelKey): LLMProviderType {
  return getModel(key).provider as LLMProviderType;
}

/**
 * 检查 Model 是否已注册
 */
export function isModelRegistered(key: string): key is LLMModelKey {
  return modelRegistry.has(key);
}

/**
 * 获取所有已注册的 Model Keys
 */
export function getRegisteredModels(): string[] {
  return Array.from(modelRegistry.keys());
}

/**
 * 获取指定 Provider 的所有 Model Keys
 */
export function getModelsByProvider(provider: LLMProviderType): string[] {
  return Array.from(modelRegistry.entries())
    .filter(([, config]) => config.provider === provider)
    .map(([key]) => key);
}

// ==================== Provider 配置验证 ====================

/**
 * Provider 到环境变量的映射
 */
/** Provider → [新名字, 旧名字] 映射（兼容未迁移的项目） */
const providerApiKeyMap: Partial<Record<string, [keyof typeof SysEnv, keyof typeof SysEnv]>> = {
  openrouter: ['AI_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'],
  google: ['AI_GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  vertex: ['AI_GOOGLE_VERTEX_API_KEY', 'GOOGLE_VERTEX_API_KEY'],
  openai: ['AI_OPENAI_API_KEY', 'OPENAI_API_KEY'],
};

/**
 * 检查 Provider 是否已配置 API Key（新旧名字都检查）
 */
export function isProviderConfigured(provider: string): boolean {
  const keys = providerApiKeyMap[provider];
  if (!keys) return false;
  return !!SysEnv[keys[0]] || !!SysEnv[keys[1]];
}

/**
 * 获取 Provider 配置状态
 */
export function getProviderStatus(): Record<string, { configured: boolean; envVar: string }> {
  return Object.entries(providerApiKeyMap).reduce<Record<string, { configured: boolean; envVar: string }>>(
    (acc, [provider, keys]) => {
      if (!keys) return acc;
      const [newKey, oldKey] = keys;
      acc[provider] = {
        configured: !!SysEnv[newKey] || !!SysEnv[oldKey],
        envVar: newKey,
      };
      return acc;
    },
    {},
  );
}

export interface LLMConfigurationValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * 验证单个 Model Key
 */
export function validateModelKey(modelKey: string): { valid: boolean; error?: string } {
  // 检查 Model 是否已注册
  if (!isModelRegistered(modelKey)) {
    return {
      valid: false,
      error: `Model "${modelKey}" is not registered. Available: ${getRegisteredModels().join(', ')}`,
    };
  }

  // 检查 Provider 是否配置了 API Key
  const config = modelRegistry.get(modelKey);
  if (config) {
    const provider = config.provider;
    if (!isProviderConfigured(provider)) {
      const keys = providerApiKeyMap[provider];
      return {
        valid: false,
        error: `Provider "${provider}" for model "${modelKey}" is not configured. Set ${keys?.[0] ?? provider}.`,
      };
    }
  }

  return { valid: true };
}

/**
 * 验证 LLM 配置
 *
 * 自动验证所有标记了 @LLMModelField() 装饰器的配置字段：
 * 1. Model 是否已注册
 * 2. 对应 Provider 的 API Key 是否已配置
 *
 * @example
 * // 在 bootstrap 中调用
 * const result = validateLLMConfiguration();
 * if (!result.valid) {
 *   throw new Error(`LLM configuration invalid: ${result.errors.join(', ')}`);
 * }
 * result.warnings.forEach(w => logger.warn(w));
 */
export function validateLLMConfiguration(): LLMConfigurationValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 获取所有标记了 @LLMModelField() 的字段
  const llmModelFields = getLLMModelFields();

  // 如果没有任何 LLM model 字段，跳过验证
  if (llmModelFields.length === 0) {
    return { valid: true, errors, warnings };
  }

  // 验证每个配置的 model
  for (const fieldName of llmModelFields) {
    const modelKey = SysEnv[fieldName as keyof typeof SysEnv] as string | undefined;

    // 跳过未配置的字段
    if (!modelKey) {
      continue;
    }

    const result = validateModelKey(modelKey);
    if (!result.valid && result.error) {
      errors.push(`[${fieldName}] ${result.error}`);
    }
  }

  // 可选：检查其他已注册模型的 Provider 状态（作为警告）
  const providerStatus = getProviderStatus();
  const unconfiguredProviders = Object.entries(providerStatus)
    .filter(([, status]) => !status.configured)
    .map(([provider, status]) => `${provider} (${status.envVar})`);

  if (unconfiguredProviders.length > 0) {
    warnings.push(`Unconfigured providers: ${unconfiguredProviders.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
