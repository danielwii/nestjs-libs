/**
 * 自动路由 LLM 客户端
 *
 * 根据 Model Key 自动选择正确的 Provider 客户端
 *
 * @example
 * ```typescript
 * import { model, opts } from '@app/llm-core';
 * import { streamText } from 'ai';
 *
 * // 自动路由到 OpenRouter
 * await streamText({
 *   model: model('openrouter:gemini-2.5-flash'),
 *   messages: [...],
 *   providerOptions: opts.noThinking('openrouter:gemini-2.5-flash'),
 * });
 *
 * // 自动路由到 Google
 * await streamText({
 *   model: model('google:gemini-2.5-flash'),
 *   messages: [...],
 *   providerOptions: opts.noThinking('google:gemini-2.5-flash'),
 * });
 * ```
 */

import type { LanguageModel } from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import { getModel, getProvider, type LLMModelKey, type LLMProviderType } from '../types/model.types';
import { openrouter, google } from './llm.clients';

// ============================================================================
// 自动路由客户端
// ============================================================================

/**
 * 根据 Model Key 自动选择客户端
 *
 * @example
 * ```typescript
 * model('openrouter:gemini-2.5-flash')  // → 使用 openrouter 客户端
 * model('google:gemini-2.5-flash')      // → 使用 google 客户端
 * ```
 */
export function model(key: LLMModelKey): LanguageModel {
  const config = getModel(key);
  const provider = config.provider as LLMProviderType;

  switch (provider) {
    case 'openrouter':
      return openrouter(config.modelId);
    case 'google':
      return google(config.modelId);
    default:
      throw new Error(`Unknown provider: ${provider} for model: ${key}`);
  }
}

/**
 * 从 Model Key 解析 Provider（快速版，不查 Registry）
 */
export function parseProvider(key: string): LLMProviderType {
  const colonIndex = key.indexOf(':');
  if (colonIndex === -1) {
    throw new Error(`Invalid model key format: ${key}, expected "provider:model"`);
  }
  return key.slice(0, colonIndex) as LLMProviderType;
}

// ============================================================================
// 自动路由 Options
// ============================================================================

/**
 * 根据 Model Key 自动生成 providerOptions
 */
export const autoOpts = {
  /**
   * 禁用 Thinking（自动根据 provider 选择正确格式）
   */
  noThinking(key: LLMModelKey | string): ProviderOptions {
    const provider = parseProvider(key);
    switch (provider) {
      case 'openrouter':
        return { openrouter: { reasoning: { exclude: true } } } as unknown as ProviderOptions;
      case 'google':
        return { google: { thinkingConfig: { thinkingBudget: 0 } } } as unknown as ProviderOptions;
      default:
        return {} as ProviderOptions;
    }
  },

  /**
   * 设置推理强度（自动根据 provider 选择正确格式）
   */
  thinking(key: LLMModelKey | string, effort: 'low' | 'medium' | 'high'): ProviderOptions {
    const provider = parseProvider(key);
    const budgetMap = { low: 1024, medium: 4096, high: 8192 } as const;

    switch (provider) {
      case 'openrouter':
        return { openrouter: { reasoning: { effort } } } as unknown as ProviderOptions;
      case 'google':
        return { google: { thinkingConfig: { thinkingBudget: budgetMap[effort] } } } as unknown as ProviderOptions;
      default:
        return {} as ProviderOptions;
    }
  },
};

// ============================================================================
// Builder 模式 API
// ============================================================================

import {
  streamText as aiStreamText,
  generateText as aiGenerateText,
  generateObject as aiGenerateObject,
  streamObject as aiStreamObject,
  type CoreMessage,
} from 'ai';
import type { z } from 'zod';

/**
 * 通用配置选项（非核心参数）
 */
export interface LLMOpts {
  temperature?: number;
  maxTokens?: number;
  /** 额外的 providerOptions（会与 thinking 配置合并） */
  providerOptions?: Record<string, unknown>;
}

/**
 * LLM Builder - 链式调用
 *
 * 设计原则：
 * - 核心参数链式：model, system, thinking, messages
 * - 其他参数通过 opts() 一次传入
 *
 * @example
 * ```typescript
 * import { llm } from '@app/llm-core';
 * import { z } from 'zod';
 *
 * // streamText - 最简
 * await llm('openrouter:gemini-2.5-flash')
 *   .noThinking()
 *   .messages([{ role: 'user', content: 'Hello' }])
 *   .streamText();
 *
 * // streamText - 带 system
 * await llm('openrouter:gemini-2.5-flash')
 *   .system('You are a fashion expert')
 *   .noThinking()
 *   .messages([{ role: 'user', content: 'Analyze this outfit' }])
 *   .streamText();
 *
 * // generateObject - 带 schema
 * const GarmentSchema = z.object({
 *   type: z.string().describe('服装类型'),
 *   color: z.string().describe('主要颜色'),
 *   style: z.enum(['casual', 'formal', 'sport']),
 * });
 *
 * const { object } = await llm('google:gemini-2.5-flash')
 *   .system('Analyze the garment in the image')
 *   .thinking('low')
 *   .messages([
 *     { role: 'user', content: [
 *       { type: 'image', image: imageBase64 },
 *       { type: 'text', text: '分析这件服装' },
 *     ]},
 *   ])
 *   .generateObject(GarmentSchema);
 *
 * console.log(object.type, object.color, object.style);
 * ```
 */
export function llm(key: LLMModelKey) {
  return new LLMBuilder(key);
}

class LLMBuilder {
  private readonly _model: LanguageModel;
  private readonly _key: LLMModelKey;
  private readonly _provider: LLMProviderType;
  private _messages: CoreMessage[] = [];
  private _system?: string;
  private _opts: LLMOpts = {};
  private _thinkingOptions: Record<string, unknown> = {};

  constructor(key: LLMModelKey) {
    this._key = key;
    this._model = model(key);
    this._provider = parseProvider(key);
  }

  // ========== 核心链式方法 ==========

  /** 设置 system prompt */
  system(prompt: string): this {
    this._system = prompt;
    return this;
  }

  /** 禁用 thinking（自动适配 provider） */
  noThinking(): this {
    this._thinkingOptions = autoOpts.noThinking(this._key);
    return this;
  }

  /** 设置推理强度（自动适配 provider） */
  thinking(effort: 'low' | 'medium' | 'high'): this {
    this._thinkingOptions = autoOpts.thinking(this._key, effort);
    return this;
  }

  /** 设置消息 */
  messages(msgs: CoreMessage[]): this {
    this._messages = msgs;
    return this;
  }

  /** 其他配置一次传入 */
  opts(options: LLMOpts): this {
    this._opts = { ...this._opts, ...options };
    return this;
  }

  // ========== 执行方法 ==========

  private _buildProviderOptions(): ProviderOptions {
    return {
      ...this._thinkingOptions,
      ...this._opts.providerOptions,
    } as unknown as ProviderOptions;
  }

  /** 流式文本生成 */
  streamText() {
    return aiStreamText({
      model: this._model,
      messages: this._messages,
      system: this._system,
      providerOptions: this._buildProviderOptions(),
      temperature: this._opts.temperature,
      maxOutputTokens: this._opts.maxTokens,
    });
  }

  /** 文本生成 */
  generateText() {
    return aiGenerateText({
      model: this._model,
      messages: this._messages,
      system: this._system,
      providerOptions: this._buildProviderOptions(),
      temperature: this._opts.temperature,
      maxOutputTokens: this._opts.maxTokens,
    });
  }

  /** 结构化对象生成 */
  generateObject<T>(schema: z.ZodType<T>) {
    return aiGenerateObject({
      model: this._model,
      output: 'object',
      schema,
      messages: this._messages,
      system: this._system,
      providerOptions: this._buildProviderOptions(),
      temperature: this._opts.temperature,
      maxOutputTokens: this._opts.maxTokens,
    });
  }

  /** 流式结构化对象生成 */
  streamObject<T>(schema: z.ZodType<T>) {
    return aiStreamObject({
      model: this._model,
      output: 'object',
      schema,
      messages: this._messages,
      system: this._system,
      providerOptions: this._buildProviderOptions(),
      temperature: this._opts.temperature,
      maxOutputTokens: this._opts.maxTokens,
    });
  }

  // ========== 调试 ==========

  /** 获取当前 provider 类型 */
  get provider(): LLMProviderType {
    return this._provider;
  }
}
