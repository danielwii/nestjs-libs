/**
 * LLM Model Registry 类型定义
 *
 * 设计意图：
 * - Provider 和 Model 直接绑定（一个 Model Key 对应一个 Provider）
 * - Key 格式：provider:model（如 openrouter:gemini-2.5-flash）
 * - 同一模型可通过不同 Provider 访问（如 openrouter:gemini vs google:gemini）
 * - Provider 类型从 Model Registry 自动推导，无需单独维护
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
export interface LLMModelRegistry {
  // ==================== OpenRouter ====================
  'openrouter:gemini-2.5-flash': ModelConfig<'openrouter'>;
  'openrouter:gemini-2.5-pro': ModelConfig<'openrouter'>;
  'openrouter:gemini-2.5-flash-lite': ModelConfig<'openrouter'>;
  'openrouter:gemini-3-flash-preview': ModelConfig<'openrouter'>;
  'openrouter:claude-3.5-sonnet': ModelConfig<'openrouter'>;
  'openrouter:claude-3.5-haiku': ModelConfig<'openrouter'>;
  'openrouter:claude-4-sonnet': ModelConfig<'openrouter'>;
  'openrouter:claude-4.1-opus': ModelConfig<'openrouter'>;
  'openrouter:gpt-4o-mini': ModelConfig<'openrouter'>;
  'openrouter:grok-3-mini': ModelConfig<'openrouter'>;
  'openrouter:grok-4-fast': ModelConfig<'openrouter'>;

  // ==================== Google Direct ====================
  'google:gemini-2.5-flash': ModelConfig<'google'>;
  'google:gemini-2.5-pro': ModelConfig<'google'>;
  'google:gemini-2.5-flash-lite': ModelConfig<'google'>;
  'google:gemini-3-flash-preview': ModelConfig<'google'>;
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

  // Google Direct 模型
  ['google:gemini-2.5-flash', { provider: 'google', modelId: 'gemini-2.5-flash' }],
  ['google:gemini-2.5-pro', { provider: 'google', modelId: 'gemini-2.5-pro' }],
  ['google:gemini-2.5-flash-lite', { provider: 'google', modelId: 'gemini-2.5-flash-lite' }],
  ['google:gemini-3-flash-preview', { provider: 'google', modelId: 'gemini-3-flash-preview' }],
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

/**
 * 获取 Model 配置
 */
export function getModel(key: LLMModelKey): ModelConfig {
  const config = modelRegistry.get(key);
  if (!config) {
    throw new Error(`Unknown model: ${key}`);
  }
  return config;
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
