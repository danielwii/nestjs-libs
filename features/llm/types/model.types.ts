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
 * 定价参考（2026.01，可能变动）：
 * | 模型 | Input | Output | Context | 备注 |
 * |------|-------|--------|---------|------|
 * | Gemini 2.5 Flash | $0.10/M | $0.40/M | 1M | ⚠️ 结构化输出有 bug |
 * | GPT-4o-mini | $0.15/M | $0.60/M | 128K | |
 * | Grok 4.1 Fast | $0.20/M | $0.50/M | 2M | Tool calling 最佳 |
 * | Grok 3 Mini | $0.30/M | $0.50/M | 131K | thinking 模式 |
 * | Claude 3.5 Haiku | $0.80/M | $4.00/M | 200K | |
 *
 * 详见：~/.claude/recipes/llm-model-pricing-2026.md
 */
export interface LLMModelRegistry {
  // ==================== OpenRouter ====================
  'openrouter:gemini-2.5-flash': ModelConfig<'openrouter'>; // $0.10/$0.40, 1M ctx, ⚠️ structured output bug
  'openrouter:gemini-2.5-pro': ModelConfig<'openrouter'>;
  'openrouter:gemini-2.5-flash-lite': ModelConfig<'openrouter'>;
  'openrouter:gemini-3-flash-preview': ModelConfig<'openrouter'>;
  'openrouter:claude-3.5-sonnet': ModelConfig<'openrouter'>;
  'openrouter:claude-3.5-haiku': ModelConfig<'openrouter'>; // $0.80/$4.00, 200K ctx
  'openrouter:claude-4-sonnet': ModelConfig<'openrouter'>;
  'openrouter:claude-4.1-opus': ModelConfig<'openrouter'>;
  'openrouter:gpt-4o-mini': ModelConfig<'openrouter'>; // $0.15/$0.60, 128K ctx
  'openrouter:grok-3-mini': ModelConfig<'openrouter'>; // $0.30/$0.50, 131K ctx, thinking
  'openrouter:grok-4-fast': ModelConfig<'openrouter'>; // $0.20/$0.50, 2M ctx, multimodal
  'openrouter:grok-4.1-fast': ModelConfig<'openrouter'>; // $0.20/$0.50, 2M ctx, best tool calling

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
  // OpenRouter 模型
  ['openrouter:gemini-2.5-flash', { provider: 'openrouter', modelId: 'google/gemini-2.5-flash' }],
  ['openrouter:gemini-2.5-pro', { provider: 'openrouter', modelId: 'google/gemini-2.5-pro' }],
  ['openrouter:gemini-2.5-flash-lite', { provider: 'openrouter', modelId: 'google/gemini-2.5-flash-lite' }],
  ['openrouter:gemini-3-flash-preview', { provider: 'openrouter', modelId: 'google/gemini-3-flash-preview' }],
  ['openrouter:claude-3.5-sonnet', { provider: 'openrouter', modelId: 'anthropic/claude-3.5-sonnet' }],
  ['openrouter:claude-3.5-haiku', { provider: 'openrouter', modelId: 'anthropic/claude-3.5-haiku-20241022' }],
  ['openrouter:claude-4-sonnet', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4' }],
  ['openrouter:claude-4.1-opus', { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.1' }],
  ['openrouter:gpt-4o-mini', { provider: 'openrouter', modelId: 'openai/gpt-4o-mini' }],
  ['openrouter:grok-3-mini', { provider: 'openrouter', modelId: 'x-ai/grok-3-mini' }],
  ['openrouter:grok-4-fast', { provider: 'openrouter', modelId: 'x-ai/grok-4-fast' }],
  ['openrouter:grok-4.1-fast', { provider: 'openrouter', modelId: 'x-ai/grok-4.1-fast' }],

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
const providerApiKeyMap: Record<string, keyof typeof SysEnv> = {
  openrouter: 'OPENROUTER_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  vertex: 'GOOGLE_VERTEX_API_KEY',
  openai: 'OPENAI_API_KEY',
};

/**
 * 检查 Provider 是否已配置 API Key
 */
export function isProviderConfigured(provider: string): boolean {
  const keyName = providerApiKeyMap[provider];
  if (!keyName) {
    return false;
  }
  return !!SysEnv[keyName];
}

/**
 * 获取 Provider 配置状态
 */
export function getProviderStatus(): Record<string, { configured: boolean; envVar: string }> {
  return Object.entries(providerApiKeyMap).reduce<Record<string, { configured: boolean; envVar: string }>>(
    (acc, [provider, envVar]) => {
      acc[provider] = {
        configured: !!SysEnv[envVar],
        envVar: envVar as string,
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
      const envVar = providerApiKeyMap[provider];
      return {
        valid: false,
        error: `Provider "${provider}" for model "${modelKey}" is not configured. Set ${envVar}.`,
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
