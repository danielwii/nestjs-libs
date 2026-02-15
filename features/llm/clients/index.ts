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

// Builder 模式（已废弃，使用 LLM 静态类代替）
// 自动路由（需要更多控制时）
// eslint-disable-next-line @typescript-eslint/no-deprecated -- re-export for backward compatibility
export { autoOpts, type LLMOpts, llm, model, parseProvider, type TelemetryMeta } from './auto.client';
export { createGoogleClient, googleOptions } from './google.client';
export { createVertex, vertexOptions } from './vertex.client';
// 预配置单例
export { getGoogleProvider, getLLMClientStatus, google, openrouter, resetLLMClients, vertex } from './llm.clients';
// 工厂函数（需要自定义配置时使用）
export { createOpenRouterClient, openrouterOptions } from './openrouter.client';

// 场景化辅助
export * from './options.helpers';

// 预设 Options
export { opts } from './opts.presets';

// LLM 统一入口
export { LLM, type Message, type ThinkingEffort, type TokenUsage, type WebSource } from './llm.class';
