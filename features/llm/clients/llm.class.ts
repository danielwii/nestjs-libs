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

import { model as createModel, parseProvider } from './auto.client';
import { disableThinkingOptions, reasoningEffortOptions } from './options.helpers';

import { generateText, Output, streamText, tool } from 'ai';

import type { LLMModelKey } from '../types/model.types';
import type { ProviderType } from './options.helpers';
import type { LanguageModel, StreamTextResult, TelemetrySettings } from 'ai';
import type { z } from 'zod';

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

/** 消息格式 */
export type Message = { role: 'user' | 'assistant' | 'system'; content: string };

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

/** 基础参数 */
interface BaseParams {
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
  /** 中断信号 */
  abortSignal?: AbortSignal;
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
  // 无额外参数
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
    const {
      model: modelKey,
      schema,
      system,
      messages,
      thinking = 'none',
      providerSort,
      temperature,
      maxOutputTokens,
      abortSignal,
      telemetry,
    } = params;

    const languageModel = createModel(modelKey);
    const provider = parseProvider(modelKey);
    const providerOptions = buildProviderOptions(provider, thinking, providerSort);

    const result = await generateText({
      model: languageModel,
      output: Output.object({ schema }),
      system,
      messages,
      providerOptions,
      temperature,
      maxOutputTokens,
      abortSignal,
      experimental_telemetry: telemetry,
    });

    return {
      object: result.output,
      usage: result.usage,
    };
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
    const {
      model: modelKey,
      system,
      messages,
      thinking = 'none',
      providerSort,
      temperature,
      maxOutputTokens,
      abortSignal,
      telemetry,
    } = params;

    const languageModel = createModel(modelKey);
    const provider = parseProvider(modelKey);
    const providerOptions = buildProviderOptions(provider, thinking, providerSort);

    const result = await generateText({
      model: languageModel,
      system,
      messages,
      providerOptions,
      temperature,
      maxOutputTokens,
      abortSignal,
      experimental_telemetry: telemetry,
    });

    return {
      text: result.text,
      usage: result.usage,
    };
  }

  /**
   * 流式结构化对象生成
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
    params: GenerateObjectParams<T>,
  ): StreamTextResult<Record<string, never>, ReturnType<typeof Output.object<T>>> {
    const {
      model: modelKey,
      schema,
      system,
      messages,
      thinking = 'none',
      providerSort,
      temperature,
      maxOutputTokens,
      abortSignal,
      telemetry,
    } = params;

    const languageModel = createModel(modelKey);
    const provider = parseProvider(modelKey);
    const providerOptions = buildProviderOptions(provider, thinking, providerSort);

    return streamText({
      model: languageModel,
      output: Output.object({ schema }),
      system,
      messages,
      providerOptions,
      temperature,
      maxOutputTokens,
      abortSignal,
      experimental_telemetry: telemetry,
    });
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
  static streamText(params: GenerateTextParams): StreamTextResult<Record<string, never>, never> {
    const {
      model: modelKey,
      system,
      messages,
      thinking = 'none',
      providerSort,
      temperature,
      maxOutputTokens,
      abortSignal,
      telemetry,
    } = params;

    const languageModel = createModel(modelKey);
    const provider = parseProvider(modelKey);
    const providerOptions = buildProviderOptions(provider, thinking, providerSort);

    return streamText({
      model: languageModel,
      system,
      messages,
      providerOptions,
      temperature,
      maxOutputTokens,
      abortSignal,
      experimental_telemetry: telemetry,
    });
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
    },
  ): Promise<GenerateObjectResult<T>> {
    const {
      model: modelKey,
      schema,
      system,
      messages,
      thinking = 'none',
      providerSort,
      temperature,
      maxOutputTokens,
      abortSignal,
      telemetry,
      toolName = 'extract',
      toolDescription = 'Extract structured data from the input',
    } = params;

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
      experimental_telemetry: telemetry,
    });

    // 从 toolCalls 中提取结果
    const toolCall = result.toolCalls?.[0];
    if (!toolCall || !('input' in toolCall)) {
      throw new Error('No tool call returned from LLM');
    }

    return {
      object: toolCall.input as T,
      usage: result.usage,
    };
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
    const {
      model: modelKey,
      schema,
      system,
      messages,
      thinking = 'none',
      providerSort,
      temperature,
      maxOutputTokens,
      abortSignal,
      telemetry,
      toolName = 'extract',
      toolDescription = 'Extract structured data from the input',
    } = params;

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
      experimental_telemetry: telemetry,
    });

    // 用于累积 JSON 字符串
    let jsonBuffer = '';
    let lastPartial: Partial<T> | null = null;

    // 遍历 fullStream 获取 tool-input 相关事件
    for await (const event of result.fullStream) {
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
    yield { type: 'usage', usage };
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
