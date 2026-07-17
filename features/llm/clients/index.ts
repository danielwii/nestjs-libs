/**
 * LLM SDK Client Helpers
 *
 * Canonical AI SDK v7 client and provider helpers
 *
 * @example
 * ```typescript
 * import { LLM } from '@app/llm-core';
 * import { z } from 'zod';
 *
 * // streamText
 * LLM.streamText({ id: 'example', model: 'openrouter:gemini-2.5-flash', instructions: 'You are helpful', messages });
 *
 * // generateObject
 * const Schema = z.object({ type: z.string(), color: z.string() });
 * const { object } = await LLM.generateObject({ id: 'example', model: 'google:gemini-2.5-flash', instructions: 'Analyze the image', messages, schema: Schema });
 * ```
 */

// 自动路由（需要更多控制时）
export { autoOpts, model, parseProvider } from './auto.client';
export { bedrockServiceTierOptions, bedrockThinkingOptions, inferBedrockReasoningFamily } from './bedrock.client';
export { createGoogleClient, googleOptions } from './google.client';
export { createVertex, vertexOptions } from './vertex.client';
// 预配置单例
export {
  bedrock,
  getBedrockProvider,
  getGoogleProvider,
  getLLMClientStatus,
  google,
  openrouter,
  resetLLMClients,
  vertex,
  vertexGlobal,
} from './llm.clients';
// 工厂函数与 OpenRouter 扩展点（需要自定义配置时使用）
export {
  createOpenRouterClient,
  getOpenRouterRoutingProfile,
  openrouterOptions,
  registerOpenRouterRoutingProfile,
  type OpenRouterRoutingProfile,
} from './openrouter.client';

// 场景化辅助
export * from './options.helpers';

// 预设 Options
export { opts } from './opts.presets';

// LLM 统一入口
export {
  LLM,
  type LLMGenerateTextAIOptions,
  type LLMPrepareStepFunction,
  type LLMPrepareStepOptions,
  type LLMPrepareStepResult,
  type LLMStreamTextAIOptions,
  type LLMStreamTextResult,
  type Message,
  type StreamTextParams,
  type ThinkingEffort,
  type TokenUsage,
  type WebSource,
} from './llm.class';
