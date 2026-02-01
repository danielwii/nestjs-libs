/**
 * LLM 成本计算工具
 *
 * 根据模型和 token 使用量计算成本
 *
 * 优先使用 API 返回的 cost（OpenRouter 现在支持），否则手动计算
 *
 * 价格数据来源：llm.clients.ts（2026-01）
 */

import type { LLMModelKey } from '../types/model.types';

// ═══════════════════════════════════════════════════════════════════════════
// 价格表（每百万 tokens）
// ═══════════════════════════════════════════════════════════════════════════

interface ModelPricing {
  input: number; // 每百万 input tokens 的成本（美元）
  output: number; // 每百万 output tokens 的成本（美元）
}

/**
 * 模型价格表（2026-01）
 *
 * 来源：
 * - OpenRouter: https://openrouter.ai/models
 * - Google: https://ai.google.dev/pricing
 *
 * 更新频率：每月检查一次
 */
const MODEL_PRICING: Record<string, ModelPricing> = {
  // Gemini 系列
  'google/gemini-2.5-flash': { input: 0.3, output: 2.5 }, // OpenRouter 价格
  'google/gemini-2.5-flash-lite': { input: 0.075, output: 0.3 },
  'google/gemini-2.5-pro': { input: 1.25, output: 10.0 },
  'gemini-2.5-flash': { input: 0.15, output: 0.6 }, // Google 直连价格（更便宜）
  'gemini-2.5-flash-lite': { input: 0.0375, output: 0.15 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0 },

  // Anthropic Claude 系列
  'anthropic/claude-4-sonnet': { input: 3.0, output: 15.0 },
  'anthropic/claude-4-opus': { input: 5.0, output: 25.0 },
  'anthropic/claude-3.5-haiku': { input: 1.0, output: 5.0 },

  // xAI Grok
  'x-ai/grok-4.1-fast': { input: 0.2, output: 0.5 },

  // OpenAI
  'openai/gpt-5.2': { input: 1.75, output: 14.0 },
  'openai/gpt-5.2-pro': { input: 21.0, output: 168.0 },
};

/**
 * 根据 modelId 获取价格
 *
 * @param modelId - 模型 ID（OpenRouter 格式或 Google 直连格式）
 * @returns 价格信息，如果未找到返回 null
 */
function getPricing(modelId: string): ModelPricing | null {
  return MODEL_PRICING[modelId] ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 成本计算
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 计算 LLM 调用成本（内部使用）
 */
function calculateCost(modelId: string, promptTokens: number, completionTokens: number): number | null {
  const pricing = getPricing(modelId);
  if (!pricing) return null;

  const inputCost = (promptTokens / 1_000_000) * pricing.input;
  const outputCost = (completionTokens / 1_000_000) * pricing.output;

  return inputCost + outputCost;
}

/**
 * 从 LLMModelKey 计算成本（内部使用）
 */
function calculateCostFromKey(
  modelKey: LLMModelKey | string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  // 如果包含 ':'，说明是 LLMModelKey 格式
  if (modelKey.includes(':')) {
    // 从 LLMModelKey 提取 modelId
    // 'openrouter:gemini-2.5-flash' → 'google/gemini-2.5-flash'
    const [provider, ...modelParts] = modelKey.split(':');
    const modelName = modelParts.join(':');

    let modelId: string;
    if (provider === 'openrouter') {
      // OpenRouter 格式：'gemini-2.5-flash' → 'google/gemini-2.5-flash'
      // 或 'claude-4-sonnet' → 'anthropic/claude-4-sonnet'
      if (modelName.startsWith('gemini')) {
        modelId = `google/${modelName}`;
      } else if (modelName.startsWith('claude')) {
        modelId = `anthropic/${modelName}`;
      } else if (modelName.startsWith('grok')) {
        modelId = `x-ai/${modelName}`;
      } else {
        modelId = modelName; // 假设已经包含 provider 前缀
      }
    } else if (provider === 'google') {
      // Google 直连格式是 'gemini-xxx'
      modelId = modelName;
    } else {
      return null;
    }

    return calculateCost(modelId, promptTokens, completionTokens);
  }

  // 否则当作 modelId 直接使用
  return calculateCost(modelKey, promptTokens, completionTokens);
}

/**
 * 从 usage 对象中获取成本
 *
 * 优先使用 API 返回的 cost，否则手动计算
 *
 * @param usage - AI SDK 返回的 usage 对象
 * @param modelKey - LLMModelKey（fallback 计算用）
 * @returns 成本（美元），如果无法计算返回 null
 */
export function getCostFromUsage(usage: unknown, modelKey?: LLMModelKey | string): number | null {
  const usageObj = usage as Record<string, unknown>;

  // 优先使用 API 返回的 cost
  if (typeof usageObj?.cost === 'number') {
    return usageObj.cost;
  }

  // Fallback: 手动计算
  if (modelKey) {
    const inputTokens = (usageObj?.inputTokens as number) ?? (usageObj?.promptTokens as number) ?? 0;
    const outputTokens = (usageObj?.outputTokens as number) ?? (usageObj?.completionTokens as number) ?? 0;
    return calculateCostFromKey(modelKey, inputTokens, outputTokens);
  }

  return null;
}
