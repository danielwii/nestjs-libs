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
import { SysEnv } from '@app/env';
import { Oops } from '@app/nest/exceptions/oops';
import { mergeProvenanceLlmTags } from '@app/nest/trace/provenance-context';

import { getModel } from '../types/model.types';
import { google, openrouter, vertex, vertexGlobal } from './llm.clients';

import '@app/nest/exceptions/oops-factories';

import { generateText as aiGenerateText, streamText as aiStreamText, Output } from 'ai';

import type { LLMModelKey, LLMModelSpec, LLMProviderType } from '../types/model.types';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import type { GenerateTextResult, LanguageModel, ModelMessage, StreamTextResult, TelemetryOptions } from 'ai';
import type { z } from 'zod';

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
 * model('vertex-global:gemini-2.5-flash?tier=priority&vertexRequestType=shared')
 * // → 使用 Vertex project/global 客户端，走官方 Priority PayGo URL
 * ```
 */
export function model(key: LLMModelSpec, modelIdSuffix?: string): LanguageModel {
  const config = getModel(key);
  const modelId = modelIdSuffix ? `${config.modelId}${modelIdSuffix}` : config.modelId;
  const provider = config.provider as LLMProviderType;

  switch (provider) {
    case 'openrouter':
      return openrouter(modelId);
    case 'google':
      return google(modelId);
    case 'vertex':
      return vertex(modelId);
    case 'vertex-global':
      return vertexGlobal(modelId);
    default:
      throw Oops.Panic.Config(`Unknown provider: ${provider as string} for model: ${key}`);
  }
}

/**
 * 从 Model Key 解析 Provider
 *
 * 支持两种格式：
 * - Provider 名：`'openrouter'` | `'google'` | `'vertex'` | `'vertex-global'`
 * - Model Key：`'openrouter:x-ai/grok-4.1-fast'`
 *
 * @example
 * ```typescript
 * parseProvider('openrouter')                    // => 'openrouter'
 * parseProvider('openrouter:x-ai/grok-4.1-fast') // => 'openrouter'
 * parseProvider('google:gemini-2.5-flash')       // => 'google'
 * parseProvider('vertex-global:gemini-2.5-flash') // => 'vertex-global'
 * ```
 */
export function parseProvider(key: string): LLMProviderType {
  // 支持直接传 provider 名（如 'openrouter'）
  const validProviders: LLMProviderType[] = ['openrouter', 'google', 'vertex', 'vertex-global'];
  if (validProviders.includes(key as LLMProviderType)) {
    return key as LLMProviderType;
  }

  // 否则解析 provider:model 格式
  const colonIndex = key.indexOf(':');
  if (colonIndex === -1) {
    throw Oops.Validation(`Invalid model key format: ${key}, expected "provider:model" or provider name`);
  }
  return key.slice(0, colonIndex) as LLMProviderType;
}

// ============================================================================
// 自动路由 Options
// ============================================================================

/**
 * 根据 Provider/Model Key 自动生成 providerOptions
 *
 * 自动识别 provider 并返回对应格式的 options。
 */
export const autoOpts = {
  /**
   * 禁用 Thinking/Reasoning
   *
   * 根据 provider 自动选择正确格式：
   * - openrouter: `{ reasoning: { effort: 'none' } }`
   * - google/vertex/vertex-global: `{ thinkingConfig: { thinkingBudget: 0 } }`
   *
   * @param key Provider 名或 Model Key
   *
   * @example
   * ```typescript
   * // 推荐：直接传 provider 名
   * providerOptions: autoOpts.noThinking('openrouter'),
   *
   * // 也支持传完整 model key
   * providerOptions: autoOpts.noThinking('openrouter:x-ai/grok-4.1-fast'),
   * ```
   */
  noThinking(key: LLMModelKey | string): ProviderOptions {
    const provider = parseProvider(key);
    switch (provider) {
      case 'openrouter':
        // ⚠️ 注意：Grok 4.1 Fast 无法关闭 reasoning（effort/enabled 参数均无效）
        // 如需低 TTFT，请使用 Gemini 2.5 Flash
        // @see ~/.claude/gotchas/openrouter-grok-reasoning-cannot-disable.md
        return { openrouter: { reasoning: { effort: 'none' } } };
      case 'google':
      case 'vertex': // Vertex 使用与 Google 相同的 providerOptions 格式
      case 'vertex-global':
        return { google: { thinkingConfig: { thinkingBudget: 0 } } };
      default:
        return {};
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
        return { openrouter: { reasoning: { effort } } };
      case 'google':
      case 'vertex': // Vertex 使用与 Google 相同的 providerOptions 格式
      case 'vertex-global':
        return { google: { thinkingConfig: { thinkingBudget: budgetMap[effort] } } };
      default:
        return {};
    }
  },

  /**
   * OpenRouter Provider 排序策略（禁用负载均衡，按指定属性排序）
   *
   * @param sort 排序策略
   * - 'price': 优先最低价格
   * - 'throughput': 优先最高吞吐量（推荐用于生成速度优先）
   * - 'latency': 优先最低延迟（推荐用于 TTFT 优先）
   *
   * @example
   * ```typescript
   * // 优先选择吞吐量最高的 provider
   * providerOptions: autoOpts.providerSort('throughput'),
   * ```
   */
  providerSort(sort: 'price' | 'throughput' | 'latency'): ProviderOptions {
    return { openrouter: { provider: { sort } } };
  },

  /**
   * 合并多个 providerOptions
   *
   * @example
   * ```typescript
   * providerOptions: autoOpts.merge(
   *   autoOpts.noThinking('openrouter'),
   *   autoOpts.providerSort('throughput'),
   * ),
   * ```
   */
  merge(...options: ProviderOptions[]): ProviderOptions {
    return options.reduce<Record<string, Record<string, unknown>>>((acc, opt) => {
      for (const [provider, config] of Object.entries(opt)) {
        acc[provider] ??= {};
        // 深度合并
        acc[provider] = { ...acc[provider], ...config };
      }
      return acc;
    }, {}) as unknown as ProviderOptions;
  },
};

// ============================================================================
// Builder 模式 API
// ============================================================================

/**
 * Telemetry 元数据（传递给 Langfuse）
 */
export interface TelemetryMeta {
  /** 用户 ID */
  userId?: string;
  /** 会话 ID（对应 Langfuse sessionId） */
  sessionId?: string;
  /** 标签 */
  tags?: string[];
  /** 父观察 ID（用于嵌套 trace） */
  parentObservationId?: string;
}

type NoTools = Record<string, never>;
interface BuilderTelemetryContext extends TelemetryMeta, Record<string, unknown> {}
type TextOutput = ReturnType<typeof Output.text>;
type ObjectOutput<T> = ReturnType<typeof Output.object<T>>;

/**
 * 通用配置选项（非核心参数）
 */
export interface LLMOpts {
  temperature?: number;
  maxOutputTokens?: number;
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
 * const { output } = await llm('google:gemini-2.5-flash')
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
 * console.log(output.type, output.color, output.style);
 * ```
 *
 * @deprecated Use static `LLM` class instead for unified logging and tracing.
 * Example: `LLM.generateObject({ id: 'my-task', model: key, ... })`
 * @see LLM
 */
export function llm(key: LLMModelKey) {
  return new LLMBuilder(key);
}

class LLMBuilder {
  private readonly _model: LanguageModel;
  private readonly _key: LLMModelKey;
  private readonly _provider: LLMProviderType;
  private _messages: ModelMessage[] = [];
  private _system?: string;
  private _opts: LLMOpts = {};
  private _thinkingOptions: Record<string, unknown> = {};
  private _signal?: AbortSignal;
  private _telemetry?: TelemetryMeta;

  constructor(key: LLMModelKey) {
    this._key = key;
    this._model = model(key);
    this._provider = parseProvider(key);
    // 默认关闭 thinking，避免推理内容渗入结构化输出
    this._thinkingOptions = autoOpts.noThinking(this._key);
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

  /** 设置推理 token 数量（更精细控制） */
  thinkingTokens(tokens: number): this {
    switch (this._provider) {
      case 'openrouter':
        this._thinkingOptions = { openrouter: { reasoning: { max_tokens: tokens } } };
        break;
      case 'google':
      case 'vertex': // Vertex 使用与 Google 相同的 providerOptions 格式
      case 'vertex-global':
        this._thinkingOptions = { google: { thinkingConfig: { thinkingBudget: tokens } } };
        break;
    }
    return this;
  }

  /** 设置中断信号（undefined 时忽略） */
  signal(signal: AbortSignal | undefined): this {
    if (signal) this._signal = signal;
    return this;
  }

  /**
   * 设置 Telemetry 元数据（传递给 Langfuse）
   *
   * @example
   * ```typescript
   * llm('openrouter:gemini-2.5-flash')
   *   .telemetry({ userId: 'user123', sessionId: 'thread456' })
   *   .messages([...])
   *   .streamText();
   * ```
   */
  telemetry(meta: TelemetryMeta): this {
    this._telemetry = meta;
    return this;
  }

  /** 设置消息 */
  messages(msgs: ModelMessage[]): this {
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
    const options = {
      ...this._thinkingOptions,
      ...this._opts.providerOptions,
    } as unknown as ProviderOptions;

    return options;
  }

  private _buildTelemetry(): TelemetryOptions<BuilderTelemetryContext, NoTools> {
    // AI SDK v7 exposes per-call metadata through explicit runtime context
    // inclusion instead of the removed v6 `metadata` field.
    return {
      isEnabled: true,
      includeRuntimeContext: {
        userId: true,
        sessionId: true,
        tags: true,
        parentObservationId: true,
      },
    };
  }

  private _buildTelemetryRuntimeContext(): BuilderTelemetryContext | undefined {
    const context: BuilderTelemetryContext = {};
    if (this._telemetry?.userId) context.userId = this._telemetry.userId;
    if (this._telemetry?.sessionId) context.sessionId = this._telemetry.sessionId;
    const tags = mergeProvenanceLlmTags(this._telemetry?.tags);
    if (tags.length) context.tags = tags;
    if (this._telemetry?.parentObservationId) context.parentObservationId = this._telemetry.parentObservationId;

    return Object.keys(context).length > 0 ? context : undefined;
  }

  /** 流式文本生成 */
  streamText(): StreamTextResult<NoTools, BuilderTelemetryContext, TextOutput> {
    const telemetry = this._buildTelemetry();
    return aiStreamText<NoTools, BuilderTelemetryContext>({
      model: this._model,
      messages: this._messages,
      system: this._system,
      providerOptions: this._buildProviderOptions(),
      temperature: this._opts.temperature,
      maxOutputTokens: this._opts.maxOutputTokens,
      abortSignal: this._signal,
      timeout: SysEnv.AI_LLM_TIMEOUT_MS,
      telemetry,
      runtimeContext: this._buildTelemetryRuntimeContext(),
    });
  }

  /** 文本生成 */
  generateText(): Promise<GenerateTextResult<NoTools, BuilderTelemetryContext, TextOutput>> {
    return aiGenerateText<NoTools, BuilderTelemetryContext, TextOutput>({
      model: this._model,
      messages: this._messages,
      system: this._system,
      providerOptions: this._buildProviderOptions(),
      temperature: this._opts.temperature,
      maxOutputTokens: this._opts.maxOutputTokens,
      abortSignal: this._signal,
      timeout: SysEnv.AI_LLM_TIMEOUT_MS,
      telemetry: this._buildTelemetry(),
      runtimeContext: this._buildTelemetryRuntimeContext(),
    });
  }

  /** 结构化对象生成 */
  generateObject<T>(
    schema: z.ZodType<T>,
  ): Promise<GenerateTextResult<NoTools, BuilderTelemetryContext, ObjectOutput<T>>> {
    return aiGenerateText<NoTools, BuilderTelemetryContext, ObjectOutput<T>>({
      model: this._model,
      output: Output.object({ schema }),
      messages: this._messages,
      system: this._system,
      providerOptions: this._buildProviderOptions(),
      temperature: this._opts.temperature,
      maxOutputTokens: this._opts.maxOutputTokens,
      abortSignal: this._signal,
      timeout: SysEnv.AI_LLM_TIMEOUT_MS,
      telemetry: this._buildTelemetry(),
      runtimeContext: this._buildTelemetryRuntimeContext(),
    });
  }

  /** 流式结构化对象生成 */
  streamObject<T>(schema: z.ZodType<T>): StreamTextResult<NoTools, BuilderTelemetryContext, ObjectOutput<T>> {
    return aiStreamText<NoTools, BuilderTelemetryContext, ObjectOutput<T>>({
      model: this._model,
      output: Output.object({ schema }),
      messages: this._messages,
      system: this._system,
      providerOptions: this._buildProviderOptions(),
      temperature: this._opts.temperature,
      maxOutputTokens: this._opts.maxOutputTokens,
      abortSignal: this._signal,
      timeout: SysEnv.AI_LLM_TIMEOUT_MS,
      telemetry: this._buildTelemetry(),
      runtimeContext: this._buildTelemetryRuntimeContext(),
    });
  }

  // ========== 调试 ==========

  /** 获取当前 provider 类型 */
  get provider(): LLMProviderType {
    return this._provider;
  }
}
