/**
 * LLM Reasoning/Thinking 配置
 *
 * 设计意图：
 * - 提供统一的业务层接口
 * - 各 Provider Adapter 自行转换为对应格式
 * - 支持扩展性（通过 extra 字段）
 */

/**
 * 推理强度级别
 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

/**
 * 统一的 Reasoning 配置接口
 */
export interface LLMReasoningOptions {
  /**
   * 推理强度：low（快速）、medium（平衡）、high（深度）
   *
   * 各 Provider 映射：
   * - OpenRouter: 转为 reasoning.effort
   * - Google: 转为 thinkingConfig.thinkingBudget (low=2000, medium=5000, high=10000 tokens)
   */
  effort?: ReasoningEffort;

  /**
   * 最大推理 token 数（可选，优先级高于 effort）
   *
   * 各 Provider 映射：
   * - OpenRouter: 转为 reasoning.maxTokens
   * - Google: 转为 thinkingConfig.thinkingBudget
   */
  maxOutputTokens?: number;

  /**
   * 是否排除推理过程（仅返回结论）
   *
   * 各 Provider 映射：
   * - OpenRouter: 转为 reasoning.exclude
   * - Google: 可能不支持，Adapter 内部忽略
   */
  exclude?: boolean;

  /**
   * 是否启用推理功能
   *
   * 各 Provider 映射：
   * - OpenRouter: 转为 reasoning.enabled
   * - Google: 通过是否传递 thinkingConfig 控制
   */
  enabled?: boolean;

  /**
   * Provider 特定的扩展配置
   */
  extra?: {
    google?: {
      /** 覆盖默认的 thinking budget（优先级最高） */
      thinkingBudget?: number;
    };
    openrouter?: {
      /** OpenRouter 特定参数 */
      [key: string]: unknown;
    };
  };
}

/**
 * Effort 到 Token Budget 的默认映射
 */
export const EFFORT_TOKEN_MAPPING: Record<ReasoningEffort, number> = {
  low: 2000,
  medium: 5000,
  high: 10000,
};

/**
 * 获取 reasoning 的 token budget
 */
export function getReasoningTokenBudget(options?: LLMReasoningOptions): number | undefined {
  if (!options) return undefined;

  // 优先级：extra.google.thinkingBudget > maxTokens > effort 映射
  if (options.extra?.google?.thinkingBudget) {
    return options.extra.google.thinkingBudget;
  }

  if (options.maxOutputTokens) {
    return options.maxOutputTokens;
  }

  if (options.effort) {
    return EFFORT_TOKEN_MAPPING[options.effort];
  }

  return undefined;
}
