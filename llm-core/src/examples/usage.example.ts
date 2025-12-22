/**
 * LLM Core 使用示例
 *
 * 激进设计：零配置 + 自动路由
 */

import { streamText, generateObject } from 'ai';
import { z } from 'zod';

// 方式 1：自动路由（最简）
import { model, autoOpts } from '../clients';

// 方式 2：直接使用特定 provider
import { openrouter, google, opts } from '../clients';

// 方式 3：使用 Registry 类型
import type { LLMModelKey } from '../types';

// ============================================================================
// 方式 1：自动路由（最简写法）
// ============================================================================

/**
 * 自动路由：传入 Model Key，自动选择 Provider
 *
 * 优势：
 * - 配置驱动，改 key 就换 provider
 * - autoOpts 自动生成正确格式的 options
 */
export async function autoRouteExample() {
  // 从配置读取，可以是 'openrouter:gemini-2.5-flash' 或 'google:gemini-2.5-flash'
  const modelKey: LLMModelKey = 'openrouter:gemini-2.5-flash';

  const result = await streamText({
    model: model(modelKey),
    messages: [{ role: 'user', content: 'Hello!' }],
    providerOptions: autoOpts.noThinking(modelKey),
  });

  for await (const chunk of result.textStream) {
    process.stdout.write(chunk);
  }

  return result;
}

/**
 * 自动路由 + generateObject
 */
export async function autoRouteGenerateObject() {
  const modelKey: LLMModelKey = 'google:gemini-2.5-flash';

  const result = await generateObject({
    model: model(modelKey),
    output: 'object',
    schema: z.object({ type: z.string(), color: z.string() }),
    messages: [{ role: 'user', content: '分析服装' }],
    providerOptions: autoOpts.thinking(modelKey, 'low'),
  });

  return result.object;
}

// ============================================================================
// 方式 2：直接使用 Provider（更显式）
// ============================================================================

/**
 * 直接使用 OpenRouter
 */
export async function streamExample() {
  const result = await streamText({
    model: openrouter('google/gemini-2.5-flash'),
    messages: [{ role: 'user', content: 'Hello!' }],
    providerOptions: opts.openrouter.noThinking,
  });

  for await (const chunk of result.textStream) {
    process.stdout.write(chunk);
  }

  return result;
}

/**
 * 场景 2: generateObject
 */
const GarmentSchema = z.object({
  type: z.string(),
  color: z.string(),
  style: z.string(),
});

export async function generateObjectExample(imageBase64: string) {
  const result = await generateObject({
    model: openrouter('google/gemini-2.5-flash'),
    output: 'object',
    schema: GarmentSchema,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', image: imageBase64 },
          { type: 'text', text: '分析服装' },
        ],
      },
    ],
    providerOptions: opts.openrouter.thinkingLow,
  });

  return result.object;
}

/**
 * 场景 3: Google Direct（更低延迟）
 */
export async function googleDirectExample() {
  const result = await streamText({
    model: google('gemini-2.5-flash'),
    messages: [{ role: 'user', content: 'Hello!' }],
    providerOptions: opts.google.noThinking,
  });

  return result;
}

// ============================================================================
// 对比
// ============================================================================

/**
 * 旧 Unee 写法：
 * ```typescript
 * @Injectable()
 * export class MyService {
 *   constructor(private llmService: LLMService) {}
 *
 *   async analyze() {
 *     return this.llmService.streamText({
 *       model: 'gemini-2.5-flash',
 *       messages: [...],
 *       reasoning: { exclude: true },
 *     });
 *   }
 * }
 * ```
 *
 * 问题：
 * - 需要注入 LLMService
 * - adapter 类型支持差
 * - 统一接口掩盖 provider 差异
 *
 * 新写法：
 * ```typescript
 * import { openrouter, opts } from '@app/llm-core';
 *
 * async analyze() {
 *   return streamText({
 *     model: openrouter('google/gemini-2.5-flash'),
 *     messages: [...],
 *     providerOptions: opts.openrouter.noThinking,
 *   });
 * }
 * ```
 *
 * 优势：
 * - 无需注入，直接 import
 * - 完整 AI SDK 类型支持
 * - 代理自动配置
 * - 保留 provider 完整能力
 */
