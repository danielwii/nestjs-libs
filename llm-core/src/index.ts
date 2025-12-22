/**
 * @app/llm-core - LLM 核心类型库
 *
 * 跨项目共享的 LLM 类型定义、Schema 验证、Provider 接口
 *
 * 扩展方式：
 * ```typescript
 * // 1. Declaration Merging 扩展类型
 * declare module '@app/llm-core' {
 *   interface LLMModelRegistry {
 *     'moonshot:kimi-k2': ModelConfig<'moonshot'>;
 *   }
 * }
 *
 * // 2. 运行时注册
 * import { registerModel } from '@app/llm-core';
 * registerModel('moonshot:kimi-k2', { provider: 'moonshot', modelId: 'kimi-k2-turbo' });
 * ```
 */

// Types
export * from './types';

// Schemas
export * from './schemas';

// Providers
export * from './providers';

// Clients (SDK helpers with proxy support)
export * from './clients';

// Re-export useful types from AI SDK
export type { ProviderOptions } from '@ai-sdk/provider-utils';
export type { CoreMessage, LanguageModel } from 'ai';
