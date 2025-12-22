/**
 * LLM Provider 接口定义
 */

import type { LLMProviderType } from '../types/model.types';
import type {
  LLMRequest,
  LLMResponse,
  LLMStreamResult,
  LLMStructuredRequest,
  LLMStructuredResponse,
  LLMStructuredStreamResult,
} from '../types/request.types';

/**
 * LLM Provider 接口
 *
 * 设计意图：
 * - 定义 Provider 的标准能力
 * - 所有方法可选，Provider 只需实现自己支持的能力
 * - 支持文本生成、结构化输出、流式输出
 */
export interface ILLMProvider {
  /** Provider 标识 */
  readonly name: LLMProviderType;

  /**
   * 文本生成
   */
  generateText?(request: LLMRequest): Promise<LLMResponse>;

  /**
   * 结构化输出
   */
  generateObject?<T>(request: LLMStructuredRequest<T>): Promise<LLMStructuredResponse<T>>;

  /**
   * 流式文本生成
   */
  streamText?(request: LLMRequest): Promise<LLMStreamResult>;

  /**
   * 流式结构化输出
   */
  streamObject?<T>(request: LLMStructuredRequest<T>): Promise<LLMStructuredStreamResult<T>>;
}

/**
 * Provider 能力检查
 */
export function hasGenerateText(
  provider: ILLMProvider,
): provider is ILLMProvider & { generateText: NonNullable<ILLMProvider['generateText']> } {
  return typeof provider.generateText === 'function';
}

export function hasGenerateObject(
  provider: ILLMProvider,
): provider is ILLMProvider & { generateObject: NonNullable<ILLMProvider['generateObject']> } {
  return typeof provider.generateObject === 'function';
}

export function hasStreamText(
  provider: ILLMProvider,
): provider is ILLMProvider & { streamText: NonNullable<ILLMProvider['streamText']> } {
  return typeof provider.streamText === 'function';
}

export function hasStreamObject(
  provider: ILLMProvider,
): provider is ILLMProvider & { streamObject: NonNullable<ILLMProvider['streamObject']> } {
  return typeof provider.streamObject === 'function';
}
