/**
 * LLM SDK Client Helpers
 *
 * 激进设计：零配置 + Builder 链式调用
 *
 * @example
 * ```typescript
 * import { llm } from '@app/llm-core';
 * import { z } from 'zod';
 *
 * // streamText
 * await llm('openrouter:gemini-2.5-flash')
 *   .system('You are helpful')
 *   .noThinking()
 *   .messages([{ role: 'user', content: 'Hello' }])
 *   .streamText();
 *
 * // generateObject
 * const Schema = z.object({ type: z.string(), color: z.string() });
 * const { object } = await llm('google:gemini-2.5-flash')
 *   .system('Analyze the image')
 *   .thinking('low')
 *   .messages([{ role: 'user', content: [...] }])
 *   .generateObject(Schema);
 * ```
 */

// Builder 模式（推荐）
export { llm, type LLMOpts, type TelemetryMeta } from './auto.client';

// 自动路由（需要更多控制时）
export { model, autoOpts, parseProvider } from './auto.client';

// 预配置单例
export { openrouter, google, getLLMClientStatus, resetLLMClients } from './llm.clients';

// Embedding
export { embedding, type EmbeddingModel } from './llm.clients';

// 工厂函数（需要自定义配置时使用）
export { createOpenRouterClient, openrouterOptions } from './openrouter.client';
export { createGoogleClient, googleOptions } from './google.client';

// 场景化辅助
export * from './options.helpers';

// 预设 Options
export { opts } from './opts.presets';
