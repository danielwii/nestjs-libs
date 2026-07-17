/**
 * AWS Bedrock Provider Options Helpers
 *
 * Bedrock Converse API 的 reasoningConfig 支持按模型家族区分：
 * - Anthropic Claude（含 us./global. inference profile 前缀）：budgetTokens（min 1024）
 * - Amazon Nova 2 系列：maxReasoningEffort（low/medium/high）
 * - 其他家族（kimi/deepseek/minimax/nova 1 代等）：不支持 reasoningConfig，
 *   发送会被 Converse 校验拒绝，因此一律不下发（显式请求 effort 时 warning）
 *
 * @see https://ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock#reasoning
 */

import { getAppLogger } from '@app/utils/app-logger';

import type { BedrockServiceTier } from '../types/model.types';
import type { JSONObject } from '@ai-sdk/provider';

const bedrockOptionsLogger = getAppLogger('features', 'LLM', 'bedrock');

/** 支持 reasoningConfig 的模型家族 */
export type BedrockReasoningFamily = 'anthropic' | 'amazon-nova' | 'other';

/**
 * 从 Bedrock modelId 推断 reasoning 配置形式
 *
 * 注意 Nova 1 代（nova-pro/nova-lite/nova-micro）不支持 reasoningConfig，
 * 只有 Nova 2 系列支持 maxReasoningEffort。
 */
export function inferBedrockReasoningFamily(modelId: string): BedrockReasoningFamily {
  if (modelId.includes('anthropic.')) return 'anthropic';
  if (/amazon\.nova-2/.test(modelId)) return 'amazon-nova';
  return 'other';
}

/** Thinking effort → Anthropic budgetTokens（与 google budgetMap 对齐；Bedrock 下限 1024） */
const BEDROCK_BUDGET_MAP = { low: 1024, medium: 4096, high: 8192 } as const;

/**
 * 生成 Bedrock thinking/reasoning providerOptions
 *
 * - effort='none'：支持 reasoning 的家族下发 `{ type: 'disabled' }`；其他家族无推理可关，返回 {}
 * - effort≠'none'：anthropic → budgetTokens；amazon-nova → maxReasoningEffort；其他家族 warn + 返回 {}
 */
export function bedrockThinkingOptions(
  modelId: string,
  effort: 'none' | 'low' | 'medium' | 'high',
): { bedrock?: JSONObject } {
  const family = inferBedrockReasoningFamily(modelId);

  if (effort === 'none') {
    if (family === 'other') return {};
    return { bedrock: { reasoningConfig: { type: 'disabled' } } };
  }

  switch (family) {
    case 'anthropic':
      return { bedrock: { reasoningConfig: { type: 'enabled', budgetTokens: BEDROCK_BUDGET_MAP[effort] } } };
    case 'amazon-nova':
      return { bedrock: { reasoningConfig: { type: 'enabled', maxReasoningEffort: effort } } };
    default:
      bedrockOptionsLogger.warning`[bedrockThinkingOptions] reasoning effort=${effort} requested for unsupported model family (modelId=${modelId}), ignoring`;
      return {};
  }
}

/** 生成 Bedrock serviceTier providerOptions（`bedrock.serviceTier` spec 参数） */
export function bedrockServiceTierOptions(serviceTier: BedrockServiceTier): { bedrock: JSONObject } {
  return { bedrock: { serviceTier } };
}
