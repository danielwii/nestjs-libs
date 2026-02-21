/**
 * LLM 统一入口
 *
 * 封装 Vercel AI SDK，提供简洁的静态方法调用：
 * - 使用 LLMModelKey 自动路由到正确的 Provider
 * - thinking 参数控制推理强度（默认关闭）
 * - 统一的错误处理和日志
 *
 * @example
 * ```typescript
 * import { LLM } from '@app/features/llm';
 *
 * const { object } = await LLM.generateObject({
 *   model: 'openrouter:grok-4.1-fast',
 *   schema: MySchema,
 *   system: 'You are...',
 *   messages: [{ role: 'user', content: 'Hello' }],
 * });
 *
 * // 开启 thinking
 * const { object } = await LLM.generateObject({
 *   model: 'openrouter:grok-4.1-fast',
 *   schema: MySchema,
 *   messages,
 *   thinking: 'high',
 * });
 * ```
 */

import { Logger } from '@nestjs/common';

import { SysEnv } from '@app/env';
import { f } from '@app/utils/logging';

import { getCostFromUsage } from '../utils/cost-calculator';
import { model as createModel, parseProvider } from './auto.client';
import { getOpenAI } from './llm.clients';
import { disableThinkingOptions, reasoningEffortOptions } from './options.helpers';

import * as Sentry from '@sentry/nestjs';
import {
  APICallError,
  embed,
  extractJsonMiddleware,
  generateText,
  Output,
  streamText,
  tool,
  wrapLanguageModel,
} from 'ai';

import type { EmbeddingModelKey, EmbeddingProvider } from '../types/embedding.types';
import type { LLMModelKey } from '../types/model.types';
/**
 * 仅对已知会包裹 markdown 代码块的模型启用 extractJsonMiddleware。
 *
 * 背景：
 * Kimi K2.5 在 response_format: json 场景下，偶发返回 ```json ... ```，
 * parseCompleteOutput 期望纯 JSON（以 `{` 开头），会导致 JSON.parse 失败。
 *
 * @see https://ai-sdk.dev/docs/reference/ai-sdk-core/extract-json-middleware
 */
import type { ProviderType } from './options.helpers';
import type { LanguageModel, ModelMessage, StopCondition, TelemetrySettings, ToolSet } from 'ai';
import type { z } from 'zod';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** 默认开启 telemetry，OTel exporter 未配置时无副作用 */
const DEFAULT_TELEMETRY: TelemetrySettings = { isEnabled: true };

/** 仅这些模型启用 JSON 代码块剥离中间件 */
const MODELS_NEEDING_EXTRACT_JSON = new Set<LLMModelKey>(['openrouter:kimi-k2.5', 'openrouter:moonshotai/kimi-k2.5']);

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Thinking 强度
 *
 * - none: 关闭推理（默认，适合结构化输出）
 * - low: 轻度推理
 * - medium: 中度推理
 * - high: 深度推理
 */
export type ThinkingEffort = 'none' | 'low' | 'medium' | 'high';

/** 消息格式：支持纯文本和多模态内容（音频、图片等） */
export type Message = ModelMessage;

/** Token 使用量 */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** OpenRouter Provider 排序策略 */
export type ProviderSort = 'price' | 'throughput' | 'latency';

/**
 * Web 搜索来源引用
 *
 * 统一了 AI SDK `Source` 类型中 URL 和文档两种变体。
 * 由 provider-defined tools（如 googleSearch、OpenRouter :online）自动返回。
 */
export type WebSource = {
  id: string;
  url: string;
  title?: string;
};

/** 基础参数 */
interface BaseParams {
  /** 业务标识，用于日志中区分调用方（如 'subconscious', 'signal-extractor'） */
  id: string;
  /** LLM Model Key，如 'openrouter:grok-4.1-fast' */
  model: LLMModelKey;
  /** System prompt */
  system?: string;
  /** 消息列表 */
  messages: Message[];
  /** Thinking 强度，默认 'none' */
  thinking?: ThinkingEffort;
  /**
   * OpenRouter Provider 排序策略（仅 openrouter 有效）
   * - 'price': 优先最低价格
   * - 'throughput': 优先最高吞吐量
   * - 'latency': 优先最低延迟
   */
  providerSort?: ProviderSort;
  /** 温度 */
  temperature?: number;
  /** 最大输出 token */
  maxOutputTokens?: number;
  /** 中断信号（与 timeout 二选一，abortSignal 优先） */
  abortSignal?: AbortSignal;
  /** 超时时间（毫秒），未传 abortSignal 时生效，默认 60000 */
  timeout?: number;
  /** Telemetry 配置 */
  telemetry?: TelemetrySettings;
}

/** generateObject 参数 */
interface GenerateObjectParams<T> extends BaseParams {
  /** Zod Schema */
  schema: z.ZodType<T>;
}

/** generateText 参数 */
interface GenerateTextParams extends BaseParams {
  /**
   * 可选工具集（如 provider-defined tools）
   *
   * 用于 Web Search 等场景，模型可在生成文本的同时调用 provider 工具。
   * 工具返回的引用会通过 `sources` 字段传递。
   *
   * @example
   * ```typescript
   * import { getGoogleProvider } from '@app/features/llm/clients';
   * const google = getGoogleProvider();
   *
   * const { text, sources } = await LLM.generateText({
   *   id: 'web-search',
   *   model: 'google:gemini-2.5-flash',
   *   messages,
   *   tools: { googleSearch: google.tools.googleSearch({}) },
   * });
   * ```
   */
  tools?: ToolSet;

  /**
   * Model ID 后缀
   *
   * 拼接到 LLMModelRegistry 中的 modelId 后面，用于 provider 特定功能。
   * 例如 OpenRouter 的 `:online` 搜索插件：
   *
   * model='openrouter:grok-4.1-fast' + modelIdSuffix=':online'
   * → provider 收到 'x-ai/grok-4.1-fast:online'
   */
  modelIdSuffix?: string;
}

/** generateObject 返回值 */
interface GenerateObjectResult<T> {
  object: T;
  usage: TokenUsage;
}

/** generateText 返回值 */
interface GenerateTextResult {
  text: string;
  usage: TokenUsage;
  /**
   * Web 搜索来源引用
   *
   * 当使用 provider-defined web search tools 时（如 OpenRouter :online、@ai-sdk/google googleSearch），
   * AI SDK 自动从 provider 响应中提取 URL 引用。
   *
   * 无 web search 时为空数组。
   */
  sources: WebSource[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Provider Options
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 根据 Provider 和 thinking 强度生成 providerOptions
 */
function buildProviderOptions(provider: ProviderType, thinking: ThinkingEffort, providerSort?: ProviderSort) {
  const thinkingOptions =
    thinking === 'none' ? disableThinkingOptions(provider) : reasoningEffortOptions(provider, thinking);

  // 只有 openrouter 支持 providerSort
  if (provider === 'openrouter' && providerSort) {
    const openrouterOptions = (thinkingOptions as { openrouter?: Record<string, unknown> }).openrouter ?? {};
    return {
      openrouter: {
        ...openrouterOptions,
        provider: { sort: providerSort },
      },
    };
  }

  return thinkingOptions;
}

// ═══════════════════════════════════════════════════════════════════════════
// LLM Class
// ═══════════════════════════════════════════════════════════════════════════

export class LLM {
  private static readonly logger = new Logger('LLM');

  // ─────────────────────────────────────────────────────────────────────────
  // Logging Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private static logStart(id: string, method: string, modelKey: string, thinking?: ThinkingEffort): void {
    const thinkingPart = thinking && thinking !== 'none' ? `, thinking=${thinking}` : '';
    LLM.logger.log(`[LLM:start] id=${id}, method=${method}, model=${modelKey}${thinkingPart}`);
  }

  private static logEnd(id: string, method: string, modelKey: string, startTime: number, usage: TokenUsage): void {
    const duration = Date.now() - startTime;
    const inputTokens = usage.inputTokens ?? usage.promptTokens ?? 0;
    const outputTokens = usage.outputTokens ?? usage.completionTokens ?? 0;
    const totalTokens = inputTokens + outputTokens;
    const cost = getCostFromUsage(usage, modelKey);
    const costStr = cost !== null ? `, cost=$${cost.toFixed(6)}` : '';
    LLM.logger.log(
      `[LLM:end] id=${id}, method=${method}, duration=${duration}ms, tokens=${totalTokens || '-'} (in=${inputTokens}, out=${outputTokens})${costStr}`,
    );
  }

  private static logTTFT(id: string, startTime: number): void {
    const ttft = Date.now() - startTime;
    LLM.logger.debug(`[LLM:ttft] id=${id}, ttft=${ttft}ms`);
  }

  /**
   * 统一错误处理：NestJS logger + Sentry
   *
   * AI SDK 默认 onError 会裸 console.error(error)，被 Sentry console integration
   * 拦截后变成 [object Object]。这里统一收归，确保：
   * 1. NestJS logger → Loki 可查
   * 2. Sentry.captureException → 结构化上报，附带 id/method/model 上下文
   */
  private static logError(id: string, method: string, modelKey: string, error: unknown): void {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    const providerData =
      APICallError.isInstance(error) && error.data != null
        ? (error.data as { code?: number; metadata?: unknown })
        : undefined;
    const extra = providerData ? f` providerData=${providerData}` : '';
    LLM.logger.error(f`[LLM:error] id=${id}, method=${method}, model=${modelKey}: ${message}${extra} ${error}`);

    Sentry.withScope((scope) => {
      scope.setTag('llm.id', id);
      scope.setTag('llm.method', method);
      scope.setTag('llm.model', modelKey);
      scope.setContext('llm', {
        id,
        method,
        model: modelKey,
        ...(providerData && { providerError: providerData }),
      });
      Sentry.captureException(error instanceof Error ? error : new Error(message));
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Generation Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 结构化对象生成
   *
   * @example
   * ```typescript
   * const { object } = await LLM.generateObject({
   *   model: 'openrouter:grok-4.1-fast',
   *   schema: z.object({ name: z.string() }),
   *   messages: [{ role: 'user', content: 'Extract name from: John Doe' }],
   * });
   * ```
   */
  static async generateObject<T>(params: GenerateObjectParams<T>): Promise<GenerateObjectResult<T>> {
    const startTime = Date.now();
    const {
      model: modelKey,
      id,
      schema,
      system,
      messages,
      thinking = 'none',
      providerSort,
      temperature,
      maxOutputTokens,
      abortSignal,
      timeout,
      telemetry = DEFAULT_TELEMETRY,
    } = params;

    LLM.logStart(id, 'generateObject', modelKey, thinking);

    const languageModel = createModel(modelKey);
    const provider = parseProvider(modelKey);
    const providerOptions = buildProviderOptions(provider, thinking, providerSort);

    try {
      const result = await generateText({
        model: languageModel,
        output: Output.object({ schema }),
        system,
        messages,
        providerOptions,
        temperature,
        maxOutputTokens,
        abortSignal,
        timeout: timeout ?? SysEnv.AI_LLM_TIMEOUT_MS,
        experimental_telemetry: telemetry,
      });

      LLM.logEnd(id, 'generateObject', modelKey, startTime, result.usage);

      return {
        object: result.output,
        usage: result.usage,
      };
    } catch (error) {
      LLM.logError(id, 'generateObject', modelKey, error);
      throw error;
    }
  }

  /**
   * 文本生成
   *
   * @example
   * ```typescript
   * const { text } = await LLM.generateText({
   *   model: 'openrouter:grok-4.1-fast',
   *   messages: [{ role: 'user', content: 'Hello' }],
   * });
   * ```
   */
  static async generateText(params: GenerateTextParams): Promise<GenerateTextResult> {
    const startTime = Date.now();
    const {
      model: modelKey,
      id,
      system,
      messages,
      thinking = 'none',
      providerSort,
      temperature,
      maxOutputTokens,
      abortSignal,
      timeout,
      telemetry = DEFAULT_TELEMETRY,
      tools,
      modelIdSuffix,
    } = params;

    LLM.logStart(id, 'generateText', modelKey, thinking);

    const languageModel = createModel(modelKey, modelIdSuffix);
    const provider = parseProvider(modelKey);
    const providerOptions = buildProviderOptions(provider, thinking, providerSort);

    try {
      const result = await generateText({
        model: languageModel,
        system,
        messages,
        tools,
        providerOptions,
        temperature,
        maxOutputTokens,
        abortSignal,
        timeout: timeout ?? SysEnv.AI_LLM_TIMEOUT_MS,
        experimental_telemetry: telemetry,
      });

      const sourcesCount = result.sources.length;
      if (sourcesCount > 0) {
        LLM.logger.debug(`[LLM:sources] id=${id}, sources=${sourcesCount}`);
      }

      LLM.logEnd(id, 'generateText', modelKey, startTime, result.usage);

      return {
        text: result.text,
        usage: result.usage,
        sources: extractWebSources(result.sources),
      };
    } catch (error) {
      LLM.logError(id, 'generateText', modelKey, error);
      throw error;
    }
  }

  /**
   * 流式结构化对象生成
   *
   * 对白名单模型（当前仅 Kimi）应用 extractJsonMiddleware，其他模型保持原始逻辑。
   * 见 MODELS_NEEDING_EXTRACT_JSON。
   *
   * @example
   * ```typescript
   * const stream = LLM.streamObject({
   *   model: 'openrouter:grok-4.1-fast',
   *   schema: MySchema,
   *   messages,
   * });
   *
   * for await (const chunk of stream.partialObjectStream) {
   *   console.log(chunk);
   * }
   * ```
   */
  static streamObject<T>(
    params: GenerateObjectParams<T> & {
      /** 可选的工具集，模型可在生成结构化输出的同时调用这些工具 */
      tools?: ToolSet;
      /**
       * 多步工具调用的停止条件
       *
       * 当传入 tools 时，模型可能先调用工具再生成最终输出，需要多步。
       * 默认 stepCountIs(1)（只运行 1 步，工具结果不会回传给模型）。
       *
       * 推荐：有 tools 时设为 stepCountIs(3) 或更高。
       *
       * @default stepCountIs(1)
       */
      stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;
    },
  ) {
    const startTime = Date.now();
    const {
      model: modelKey,
      id,
      schema,
      system,
      messages,
      thinking = 'none',
      providerSort,
      temperature,
      maxOutputTokens,
      abortSignal,
      timeout,
      telemetry = DEFAULT_TELEMETRY,
      tools,
      stopWhen,
    } = params;

    LLM.logStart(id, 'streamObject', modelKey, thinking);

    const languageModel = createModel(modelKey);
    const model: LanguageModel = MODELS_NEEDING_EXTRACT_JSON.has(modelKey)
      ? wrapLanguageModel({
          model: languageModel as Parameters<typeof wrapLanguageModel>[0]['model'],
          middleware: extractJsonMiddleware({
            transform: (text) => {
              const trimmed = text.trim();
              // 剥离 ```json 或 ``` 包裹；无闭合时仅剥离开头
              const jsonMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
              if (jsonMatch?.[1]) return jsonMatch[1].trim();
              if (trimmed.startsWith('```')) return trimmed.replace(/^```(?:json)?\s*\n?/, '').trim();
              return trimmed;
            },
          }),
        })
      : languageModel;

    const provider = parseProvider(modelKey);
    const providerOptions = buildProviderOptions(provider, thinking, providerSort);

    let ttftLogged = false;

    const result = streamText({
      model,
      output: Output.object({ schema }),
      system,
      messages,
      tools,
      stopWhen,
      providerOptions,
      temperature,
      maxOutputTokens,
      abortSignal,
      timeout: timeout ?? SysEnv.AI_LLM_TIMEOUT_MS,
      experimental_telemetry: telemetry,
      onError: ({ error }) => {
        LLM.logError(id, 'streamObject', modelKey, error);
      },
      onChunk() {
        if (!ttftLogged) {
          LLM.logTTFT(id, startTime);
          ttftLogged = true;
        }
      },
      onFinish(event) {
        LLM.logEnd(id, 'streamObject', modelKey, startTime, event.usage);
      },
    });

    return result;
  }

  /**
   * 流式文本生成
   *
   * @example
   * ```typescript
   * const stream = LLM.streamText({
   *   model: 'openrouter:grok-4.1-fast',
   *   messages,
   * });
   *
   * for await (const chunk of stream.textStream) {
   *   process.stdout.write(chunk);
   * }
   * ```
   */
  static streamText(params: BaseParams) {
    const startTime = Date.now();
    const {
      model: modelKey,
      id,
      system,
      messages,
      thinking = 'none',
      providerSort,
      temperature,
      maxOutputTokens,
      abortSignal,
      timeout,
      telemetry = DEFAULT_TELEMETRY,
    } = params;

    LLM.logStart(id, 'streamText', modelKey, thinking);

    const languageModel = createModel(modelKey);
    const provider = parseProvider(modelKey);
    const providerOptions = buildProviderOptions(provider, thinking, providerSort);

    let ttftLogged = false;

    const result = streamText({
      model: languageModel,
      system,
      messages,
      providerOptions,
      temperature,
      maxOutputTokens,
      abortSignal,
      timeout: timeout ?? SysEnv.AI_LLM_TIMEOUT_MS,
      experimental_telemetry: telemetry,
      onError: ({ error }) => {
        LLM.logError(id, 'streamText', modelKey, error);
      },
      onChunk() {
        if (!ttftLogged) {
          LLM.logTTFT(id, startTime);
          ttftLogged = true;
        }
      },
      onFinish(event) {
        LLM.logEnd(id, 'streamText', modelKey, startTime, event.usage);
      },
    });

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tool Calling 模式
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 通过 Tool Calling 生成结构化对象（非流式）
   *
   * 与 generateObject 的区别：
   * - generateObject: 使用 Structured Output 模式（Output.object）
   * - generateObjectViaTool: 使用 Tool Calling 模式
   *
   * Tool Calling 模式优势：
   * - 某些模型（如 Gemini 3 Flash）在 Tool Calling 上表现更好
   * - Schema 复杂时结构更稳定
   *
   * @example
   * ```typescript
   * const { object, usage } = await LLM.generateObjectViaTool({
   *   model: 'openrouter:gemini-3-flash-preview',
   *   schema: MySchema,
   *   toolName: 'analyze',
   *   toolDescription: '分析用户输入',
   *   messages,
   * });
   * ```
   */
  static async generateObjectViaTool<T>(
    params: GenerateObjectParams<T> & {
      /** Tool 名称 */
      toolName?: string;
      /** Tool 描述（帮助 LLM 理解何时使用） */
      toolDescription?: string;
      /**
       * 是否允许模型并行生成多个 tool call（默认 false）
       *
       * generateObjectViaTool 只定义 1 个 tool、只取第一个结果，
       * 但 Gemini 等模型在 tool calling 模式下会生成数百个重复 tool call。
       * 设为 false 可防止 token 浪费。仅 OpenRouter provider 支持此参数。
       */
      parallelToolCalls?: boolean;
    },
  ): Promise<GenerateObjectResult<T>> {
    const startTime = Date.now();
    const {
      model: modelKey,
      id,
      schema,
      system,
      messages,
      thinking = 'none',
      providerSort,
      temperature,
      maxOutputTokens,
      abortSignal,
      timeout,
      telemetry = DEFAULT_TELEMETRY,
      toolName = 'extract',
      toolDescription = 'Extract structured data from the input',
      parallelToolCalls = true,
    } = params;

    LLM.logStart(id, 'generateObjectViaTool', modelKey, thinking);

    const languageModel = createModel(modelKey);
    const provider = parseProvider(modelKey);
    const baseProviderOptions = buildProviderOptions(provider, thinking, providerSort);

    // OpenRouter 支持 parallelToolCalls 参数控制并行 tool call
    const providerOptions =
      provider === 'openrouter'
        ? {
            ...baseProviderOptions,
            openrouter: {
              ...((baseProviderOptions as Record<string, unknown>).openrouter as Record<string, unknown> | undefined),
              parallelToolCalls,
            },
          }
        : baseProviderOptions;

    // 创建 Tool，将 Schema 作为 inputSchema
    const tools = {
      [toolName]: tool({
        description: toolDescription,
        inputSchema: schema,
      }),
    };

    // 强制使用指定的 Tool
    const toolChoice = { type: 'tool' as const, toolName };

    try {
      const result = await generateText({
        model: languageModel,
        system,
        messages,
        tools,
        toolChoice,
        providerOptions,
        temperature,
        maxOutputTokens,
        abortSignal,
        timeout: timeout ?? SysEnv.AI_LLM_TIMEOUT_MS,
        experimental_telemetry: telemetry,
      });

      LLM.logEnd(id, 'generateObjectViaTool', modelKey, startTime, result.usage);

      // 从 toolCalls 中提取结果（只取第一个，忽略可能的重复 tool call）
      const toolCall = result.toolCalls.at(0);
      if (!toolCall || !('input' in toolCall)) {
        throw new Error('No tool call returned from LLM');
      }

      if (!parallelToolCalls && result.toolCalls.length > 1) {
        LLM.logger.warn(
          `[LLM:warn] id=${id} generateObjectViaTool returned ${result.toolCalls.length} tool calls (expected 1), using first`,
        );
      }

      // 预处理：部分模型（如 Grok）将嵌套对象序列化为 JSON 字符串
      // 在验证前尝试还原，无法还原的保持原样交给 safeParse 报错
      const rawInput = toolCall.input;
      const preprocessed = coerceStringifiedObjects(rawInput);

      // safeParse 验证：fail fast，不兜底修复
      const parseResult = schema.safeParse(preprocessed);
      if (!parseResult.success) {
        // 打印原始值帮助诊断 coerce 失败原因
        const stringFields = Object.entries(rawInput as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'string' && v.length > 10)
          .map(([k, v]) => `${k}=${JSON.stringify((v as string).slice(0, 120))}`)
          .join(', ');
        if (stringFields) {
          LLM.logger.warn(`[LLM:coerce-debug] id=${id} string fields in raw input: ${stringFields}`);
        }

        const issues = parseResult.error.issues
          .slice(0, 5)
          .map((i) => {
            // 从原始输入中提取失败字段的实际值
            let actual: unknown = preprocessed;
            for (const seg of i.path) {
              if (actual != null && typeof actual === 'object') {
                actual = (actual as Record<string, unknown>)[String(seg)];
              } else {
                actual = undefined;
                break;
              }
            }
            const actualStr = actual === undefined ? '' : ` (got ${JSON.stringify(actual)})`;
            return `${i.path.join('.')}: ${i.message}${actualStr}`;
          })
          .join('; ');
        throw new Error(`[LLM:validation] id=${id} Tool call output validation failed: ${issues}`);
      }

      return {
        object: parseResult.data,
        usage: result.usage,
      };
    } catch (error) {
      LLM.logError(id, 'generateObjectViaTool', modelKey, error);
      throw error;
    }
  }

  /**
   * 通过 Tool Calling 流式生成结构化对象（实验性）
   *
   * 与 streamObject 的区别：
   * - streamObject: 使用 Structured Output 模式（Output.object）
   * - streamObjectViaTool: 使用 Tool Calling 模式
   *
   * Tool Calling 模式优势：
   * - 某些模型（如 Gemini 3 Flash）在 Tool Calling 上表现更好
   * - 提供更丰富的流式事件（tool-call-streaming-start, tool-call-delta）
   *
   * @example
   * ```typescript
   * const stream = LLM.streamObjectViaTool({
   *   model: 'openrouter:gemini-3-flash-preview',
   *   schema: MySchema,
   *   toolName: 'analyze',
   *   toolDescription: '分析用户输入',
   *   messages,
   * });
   *
   * for await (const event of stream) {
   *   if (event.type === 'partial') {
   *     console.log('Partial:', event.object);
   *   } else if (event.type === 'complete') {
   *     console.log('Complete:', event.object);
   *   }
   * }
   * ```
   */
  static async *streamObjectViaTool<T>(
    params: GenerateObjectParams<T> & {
      /** Tool 名称 */
      toolName?: string;
      /** Tool 描述（帮助 LLM 理解何时使用） */
      toolDescription?: string;
    },
  ): AsyncGenerator<ToolStreamEvent<T>> {
    const startTime = Date.now();
    const {
      model: modelKey,
      id,
      schema,
      system,
      messages,
      thinking = 'none',
      providerSort,
      temperature,
      maxOutputTokens,
      abortSignal,
      timeout,
      telemetry = DEFAULT_TELEMETRY,
      toolName = 'extract',
      toolDescription = 'Extract structured data from the input',
    } = params;

    LLM.logStart(id, 'streamObjectViaTool', modelKey, thinking);

    const languageModel = createModel(modelKey);
    const provider = parseProvider(modelKey);
    const providerOptions = buildProviderOptions(provider, thinking, providerSort);

    // 创建 Tool，将 Schema 作为 inputSchema
    const tools = {
      [toolName]: tool({
        description: toolDescription,
        inputSchema: schema,
      }),
    };

    // 强制使用指定的 Tool
    const toolChoice = { type: 'tool' as const, toolName };

    const result = streamText({
      model: languageModel,
      system,
      messages,
      tools,
      toolChoice,
      providerOptions,
      temperature,
      maxOutputTokens,
      abortSignal,
      timeout: timeout ?? SysEnv.AI_LLM_TIMEOUT_MS,
      experimental_telemetry: telemetry,
      onError: ({ error }) => {
        LLM.logError(id, 'streamObjectViaTool', modelKey, error);
      },
    });

    let ttftLogged = false;

    // 用于累积 JSON 字符串
    let jsonBuffer = '';
    let lastPartial: Partial<T> | null = null;

    // 遍历 fullStream 获取 tool-input 相关事件
    for await (const event of result.fullStream) {
      if (!ttftLogged) {
        LLM.logTTFT(id, startTime);
        ttftLogged = true;
      }

      if (event.type === 'tool-input-start') {
        // Tool input 开始
        jsonBuffer = '';
        yield { type: 'start', toolCallId: event.id };
      } else if (event.type === 'tool-input-delta') {
        // 增量 JSON 参数
        jsonBuffer += event.delta;

        // 尝试解析部分 JSON
        const partial = tryParsePartialJson<T>(jsonBuffer);
        if (partial && JSON.stringify(partial) !== JSON.stringify(lastPartial)) {
          lastPartial = partial;
          yield { type: 'partial', object: partial };
        }
      } else if (event.type === 'tool-call') {
        // Tool call 完成，获取完整参数
        yield { type: 'complete', object: event.input as T, toolCallId: event.toolCallId };
      }
    }

    // 获取 usage
    const usage = await result.usage;
    LLM.logEnd(id, 'streamObjectViaTool', modelKey, startTime, usage);
    yield { type: 'usage', usage };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Embedding
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 文本向量化
   *
   * 统一入口，支持 provider:model 格式自动路由。
   *
   * @example
   * ```typescript
   * const vector = await LLM.embedding({
   *   id: 'sculptor-dedup',
   *   model: 'openai:text-embedding-3-small',
   *   text: 'some text',
   * });
   * ```
   */
  static async embedding(params: {
    id: string;
    model: EmbeddingModelKey;
    text: string;
    abortSignal?: AbortSignal;
    /** 超时时间（毫秒），默认 60000 */
    timeout?: number;
  }): Promise<{ embedding: number[]; usage: TokenUsage }> {
    const startTime = Date.now();
    const { id, model: modelKey, text, abortSignal, timeout } = params;

    if (!text || text.trim().length === 0) {
      throw new Error(`[LLM:embedding] id=${id} empty text (type=${typeof text}, length=${text.length})`);
    }

    LLM.logger.debug(
      `[LLM:embedding] id=${id} text="${text.slice(0, 80)}${text.length > 80 ? '...' : ''}" (${text.length} chars)`,
    );
    LLM.logStart(id, 'embedding', modelKey);

    const [provider, modelId] = modelKey.split(':') as [EmbeddingProvider, string];

    let embeddingModel;
    switch (provider) {
      case 'openai':
        embeddingModel = getOpenAI().embeddingModel(modelId);
        break;
      case 'jina':
      case 'voyage':
        throw new Error(`Embedding provider "${provider}" is not implemented yet`);
    }

    const timeoutMs = timeout ?? SysEnv.AI_LLM_TIMEOUT_MS;
    const effectiveAbortSignal = abortSignal ?? AbortSignal.timeout(timeoutMs);
    const result = await embed({
      model: embeddingModel,
      value: text,
      abortSignal: effectiveAbortSignal,
    });

    const usage: TokenUsage = { inputTokens: result.usage.tokens, outputTokens: 0 };
    LLM.logEnd(id, 'embedding', modelKey, startTime, usage);

    return { embedding: result.embedding, usage };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 便捷方法
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 获取 LanguageModel 实例
   *
   * 用于需要直接使用 AI SDK 的场景
   */
  static model(key: LLMModelKey): LanguageModel {
    return createModel(key);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Stream Event Types
// ═══════════════════════════════════════════════════════════════════════════

/** Tool 流式事件类型 */
export type ToolStreamEvent<T> =
  | { type: 'start'; toolCallId: string }
  | { type: 'partial'; object: Partial<T> }
  | { type: 'complete'; object: T; toolCallId: string }
  | { type: 'usage'; usage: TokenUsage };

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * AI SDK Source 的最小子集（`Source` 类型未从 `ai` 包导出）。
 *
 * @see LanguageModelV3Source（@ai-sdk/provider 内部类型）
 */
interface AiSdkSource {
  type: 'source';
  sourceType: string;
  id: string;
  url?: string;
  title?: string;
}

/**
 * 从 AI SDK Source[] 中提取 URL 类型的 WebSource
 *
 * AI SDK 的 Source 有 url 和 document 两种变体，
 * Web Search 场景只关心 url 类型。
 */
function extractWebSources(sources: AiSdkSource[] | undefined): WebSource[] {
  if (!sources?.length) return [];

  return sources
    .filter((s): s is AiSdkSource & { sourceType: 'url'; url: string } => s.sourceType === 'url' && !!s.url)
    .map((s) => ({
      id: s.id,
      url: s.url,
      title: s.title,
    }));
}

/**
 * 部分模型（如 Grok）在 tool calling 时将嵌套对象序列化为 JSON 字符串，
 * 且可能使用欧洲小数格式（0,5 → 应为 0.5）和截断输出。
 *
 * 处理流程（顶层字段，不递归）：
 * 1. 值是 string 且以 { 或 [ 开头 → 尝试还原
 * 2. 修复欧洲小数：(\d),(\d) → $1.$2（在非字符串上下文中安全）
 * 3. 尝试 JSON.parse → 成功则替换
 * 4. parse 失败（截断）→ tryParsePartialJson 补全括号后再试
 * 5. 全部失败 → 保持原样，交给 safeParse 报错
 */
function coerceStringifiedObjects(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
      // 修复欧洲小数：0,5 → 0.5（仅在数字之间替换，不影响 JSON 逗号分隔符）
      const fixed = value.replace(/(\d),(\d)/g, '$1.$2');
      try {
        result[key] = JSON.parse(fixed);
      } catch {
        // JSON.parse 失败（截断）→ 尝试 partial parse
        const partial = tryParsePartialJson(fixed);
        result[key] = partial ?? value;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * 尝试解析部分 JSON 字符串
 *
 * 处理不完整的 JSON，尽可能提取已有字段
 */
function tryParsePartialJson<T>(jsonString: string): Partial<T> | null {
  if (!jsonString.trim()) return null;

  // 首先尝试直接解析（可能是完整 JSON）
  try {
    return JSON.parse(jsonString) as T;
  } catch {
    // 不是完整 JSON，尝试修复
  }

  // 尝试补全 JSON（添加缺失的括号）
  let fixedJson = jsonString.trim();

  // 计算未闭合的括号
  let braceCount = 0;
  let bracketCount = 0;
  let inString = false;
  let escapeNext = false;

  for (const char of fixedJson) {
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') braceCount++;
    else if (char === '}') braceCount--;
    else if (char === '[') bracketCount++;
    else if (char === ']') bracketCount--;
  }

  // 如果在字符串中间，截断到最后一个完整的引号
  if (inString) {
    const lastQuote = fixedJson.lastIndexOf('"');
    if (lastQuote > 0) {
      fixedJson = fixedJson.substring(0, lastQuote + 1);
      // 重新计算括号
      braceCount = 0;
      bracketCount = 0;
      inString = false;
      for (const char of fixedJson) {
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        if (char === '\\') {
          escapeNext = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (char === '{') braceCount++;
        else if (char === '}') braceCount--;
        else if (char === '[') bracketCount++;
        else if (char === ']') bracketCount--;
      }
    }
  }

  // 移除末尾不完整的键值对
  // 例如 `{"a": 1, "b":` -> `{"a": 1`
  fixedJson = fixedJson.replace(/,\s*"[^"]*"\s*:\s*$/, '');
  fixedJson = fixedJson.replace(/,\s*$/, '');

  // 补全括号
  fixedJson += ']'.repeat(Math.max(0, bracketCount));
  fixedJson += '}'.repeat(Math.max(0, braceCount));

  try {
    return JSON.parse(fixedJson) as Partial<T>;
  } catch {
    return null;
  }
}
