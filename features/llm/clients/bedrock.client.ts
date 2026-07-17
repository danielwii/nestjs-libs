/**
 * AWS Bedrock Provider Options Helpers
 *
 * Bedrock Converse API 的 reasoningConfig 支持按模型家族区分：
 * - Anthropic Claude ≤4.6（含 us./global. inference profile 前缀）：budgetTokens（min 1024）
 * - Anthropic Claude Opus 4.7+ / Sonnet 5 / Fable 5：仅支持 adaptive thinking，
 *   `type: "enabled" + budget_tokens` 会 400，必须用 `type: "adaptive"` + `output_config.effort`
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
export type BedrockReasoningFamily = 'anthropic' | 'anthropic-adaptive' | 'amazon-nova' | 'other';

/**
 * 仅支持 adaptive thinking 的 Claude 模型（Opus 4.7 起）。
 *
 * 这些模型对旧式 `thinking.type: "enabled" + budget_tokens` 返回 400：
 * "Use thinking.type.adaptive and output_config.effort to control thinking behavior."
 * 与 @ai-sdk/amazon-bedrock 内部的 special-case 列表（opus-4-7/4-8、sonnet-5、fable-5）对齐。
 *
 * @see https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html （Opus 4.7 model card）
 */
const ADAPTIVE_ONLY_PATTERN = /claude-(opus-4-[78]|sonnet-5|fable-5)/;

/**
 * 从 Bedrock modelId 推断 reasoning 配置形式
 *
 * 注意 Nova 1 代（nova-pro/nova-lite/nova-micro）不支持 reasoningConfig，
 * 只有 Nova 2 系列支持 maxReasoningEffort。
 */
export function inferBedrockReasoningFamily(modelId: string): BedrockReasoningFamily {
  if (modelId.includes('anthropic.')) {
    return ADAPTIVE_ONLY_PATTERN.test(modelId) ? 'anthropic-adaptive' : 'anthropic';
  }
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
    case 'anthropic-adaptive':
      // Opus 4.7+：thinking.type=adaptive + output_config.effort（budget_tokens 会 400）
      return { bedrock: { reasoningConfig: { type: 'adaptive', maxReasoningEffort: effort } } };
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
