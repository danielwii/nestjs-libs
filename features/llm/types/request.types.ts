/**
 * LLM 请求/响应 类型定义
 *
 * 设计原则：
 * 1. 通用参数顶层定义
 * 2. 场景化便利（如 disableThinking）自动处理 Provider 差异
 * 3. Provider 特有选项类型安全
 */

import type { LLMModelKey } from './model.types';
import type { z } from 'zod';

// ==================== 消息类型 ====================

export type LLMMessageRole = 'system' | 'user' | 'assistant';

export interface LLMMessage {
  role: LLMMessageRole;
  content: string;
}

// ==================== Token 使用统计 ====================

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost?: number;
  costDetails?: unknown;
}

// ==================== Provider 特有选项（可扩展） ====================

/**
 * Provider 特有选项 Registry
 *
 * 项目可通过 Declaration Merging 扩展：
 * ```typescript
 * declare module '@app/llm-core' {
 *   interface LLMProviderOptionsRegistry {
 *     vertex: { location?: string };
 *     fal: { webhookUrl?: string };
 *   }
 * }
 * ```
 */
export interface LLMProviderOptionsRegistry {
  // OpenRouter 特有选项
  openrouter: {
    /** 路由策略 */
    route?: 'fallback' | string;
    /** 模型转换 */
    transforms?: string[];
    /** Provider 偏好顺序 */
    providerOrder?: string[];
    /** 额外透传参数 */
    extra?: Record<string, unknown>;
  };

  // Google/Gemini 特有选项
  google: {
    /** Thinking token 预算（针对 thinking 模型） */
    thinkingBudget?: number;
    /** 安全设置 */
    safetySettings?: Array<{
      category: string;
      threshold: string;
    }>;
  };

  // OpenAI 特有选项
  openai: {
    /** 响应格式 */
    responseFormat?: { type: 'text' | 'json_object' };
    /** 函数调用 */
    tools?: unknown[];
    toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  };

  // Anthropic 特有选项
  anthropic: {
    /** Extended thinking */
    thinking?: {
      type: 'enabled';
      budgetTokens: number;
    };
  };
}

// 推导 Provider 类型
export type LLMProviderOptionsKey = keyof LLMProviderOptionsRegistry;

// ==================== 请求类型 ====================

/**
 * 通用 LLM 请求参数
 *
 * 使用示例：
 * ```typescript
 * const request: LLMRequest = {
 *   messages: [{ role: 'user', content: 'Hello' }],
 *   model: 'openrouter:gemini-2.5-flash',
 *
 *   // 场景化便利：一个开关，自动处理不同 Provider
 *   disableThinking: true,
 *
 *   // Provider 特有选项：类型安全
 *   openrouter: { route: 'fallback' },
 * };
 * ```
 */
export interface LLMRequest {
  // ========== 通用参数 ==========
  messages: LLMMessage[];
  model: LLMModelKey;
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  stream?: boolean;
  system?: string;
  signal?: AbortSignal;

  // ========== 场景化便利 ==========

  /**
   * 禁用 thinking/reasoning 输出
   *
   * 适用于：Gemini thinking、Claude extended thinking、OpenRouter reasoning
   * Provider 实现会自动转换为对应的参数
   */
  disableThinking?: boolean;

  /**
   * Thinking/Reasoning 强度
   *
   * 适用于支持 reasoning 的模型
   * - low: 快速响应，少量推理
   * - medium: 平衡
   * - high: 深度推理
   */
  thinkingEffort?: 'low' | 'medium' | 'high';

  // ========== Provider 特有选项（类型安全） ==========

  /** OpenRouter 特有选项 */
  openrouter?: LLMProviderOptionsRegistry['openrouter'];

  /** Google/Gemini 特有选项 */
  google?: LLMProviderOptionsRegistry['google'];

  /** OpenAI 特有选项 */
  openai?: LLMProviderOptionsRegistry['openai'];

  /** Anthropic 特有选项 */
  anthropic?: LLMProviderOptionsRegistry['anthropic'];
}

/**
 * 结构化输出请求参数
 */
export interface LLMStructuredRequest<T = unknown> extends LLMRequest {
  structuredSchema: LLMStructuredSchema<T>;
}

// ==================== 响应类型 ====================

/**
 * 通用 LLM 响应
 */
export interface LLMResponse {
  /** 生成的文本内容 */
  content: string;
  /** Token 使用统计 */
  usage?: LLMUsage;
  /** 结束原因 */
  finishReason?: string;
}

/**
 * 结构化输出响应
 */
export interface LLMStructuredResponse<T> {
  /** 解析后的对象 */
  object: T;
  /** Token 使用统计 */
  usage?: LLMUsage;
}

// ==================== 流式响应类型 ====================

/**
 * 流式文本响应结果
 */
export interface LLMStreamResult {
  /** 文本流（过滤后的纯文本） */
  readonly stream: AsyncIterable<string>;
  /** 获取 token 使用统计 */
  getUsage(): Promise<LLMUsage>;
  /** 获取完整生成文本 */
  getText(): Promise<string>;
  /** 获取结束原因 */
  getFinishReason(): Promise<string>;
}

/**
 * 流式结构化输出响应结果
 */
export interface LLMStructuredStreamResult<T> {
  /** 部分对象流（边生成边解析） */
  readonly partialStream: AsyncIterable<Partial<T>>;
  /** 获取最终完整对象 */
  getObject(): Promise<T>;
  /** 获取 token 使用统计 */
  getUsage(): Promise<LLMUsage>;
}

// ==================== Schema 定义 ====================

/**
 * 结构化输出的 schema 定义
 */
export interface LLMStructuredSchema<T = unknown> {
  /** Zod schema，用于 AI SDK 的结构化输出 */
  zodSchema: z.ZodType<T>;
  /** JSON 结构的字符串描述（用于 response_format json_object 模式） */
  jsonStructureDescription: string;
  /** Schema 名称 */
  name?: string;
  /** Schema 描述 */
  description?: string;
}
