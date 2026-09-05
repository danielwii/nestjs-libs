/**
 * LLM 成本计算工具
 *
 * 根据模型和 token 使用量计算成本
 *
 * 优先使用 API 返回的 cost（OpenRouter 现在支持），否则手动计算
 *
 * 价格数据来源：llm.clients.ts（2026-01）
 */

import { getModel, isModelRegistered } from '../types/model.types';

import type { BedrockServiceTier, LLMModelKey } from '../types/model.types';

/**
 * Bedrock service tier 价格系数（相对 standard on-demand）。
 *
 * 来源：AWS Bedrock pricing — Flex 为 on-demand 的 50%，Priority 为 +75%（1.75x）。
 * `reserved` 为承诺吞吐（非按 token 计费），不在此表，按 token 估算会误导，返回 null。
 *
 * @see https://aws.amazon.com/bedrock/pricing/
 */
const BEDROCK_SERVICE_TIER_MULTIPLIER: Record<Exclude<BedrockServiceTier, 'reserved'>, number> = {
  default: 1,
  flex: 0.5,
  priority: 1.75,
};

/** getCostFromUsage 的可选上下文 */
export interface CostContext {
  /** Bedrock service tier（来自 model spec 的 `bedrock.serviceTier` 参数） */
  bedrockServiceTier?: BedrockServiceTier;
}

// ═══════════════════════════════════════════════════════════════════════════
// 价格表（每百万 tokens）
// ═══════════════════════════════════════════════════════════════════════════

interface TokenPricing {
  input: number; // 每百万 input tokens 的成本（美元）
  output: number; // 每百万 output tokens 的成本（美元）
}

interface ModelPricing extends TokenPricing {
  /** 当 input tokens 严格超过阈值时，整次调用使用该档费率。 */
  longContext?: TokenPricing & { inputTokenThreshold: number };
}

/**
 * 模型价格表 —— **兜底估算**，不是权威成本。
 *
 * 权威成本是 provider 在响应里报的实际扣费额：OpenRouter 的 usage accounting 默认开启，
 * `providerMetadata.openrouter.usage.cost` 每次都有，已由 llm.class 的 withReportedCost
 * 并入 usage，getCostFromUsage 会优先采用。本表只在 provider 不报成本时（Google / Vertex /
 * Bedrock 直连）或响应异常时使用。日志里的 `cost=$x(reported|est)` 标明当次走了哪条。
 *
 * ── 本表 openrouter 条目的口径（2026-09-05 全量校准）────────────────────────
 * 取「默认路由可达档的最低价」，行尾注释是取价的 endpoint tag。
 *
 * OpenRouter 一个模型有多个 endpoint，价格分三类：
 *  1. service tier（tag 后缀 `/flex` `/priority` `/fast`）—— **默认路由不可达**，
 *     必须显式 opt-in（`service_tier` 参数、tier 后缀 slug、或 `:floor` / `:nitro`）。
 *     本库 createOpenRouter 未做任何 opt-in，故这些档一律排除。
 *     曾因误记 flex 档导致 gemini-3.7/3.8 系统性低估一半（实测 reported $0.000245
 *     vs 表估 $0.000123）。
 *  2. 各 provider 的普通 endpoint —— 默认路由的候选池。
 *  3. 区域 / 量化变体（`/us`、`/fp8`、`/int4` 等）也在候选池内。
 *
 * 默认路由不是「取最低价」，而是先剔除近 30 秒有故障的 provider，再在候选池里按
 * **1/price² 加权随机**（$1 的比 $3 的高 9 倍概率）。所以：
 *  - 单 provider 模型（如 gemini 只有 Google）→ 本表值即实际值；
 *  - 多 provider 模型（如 deepseek-v4-pro 有 17 家）→ 本表是**下界**，实际期望值更高。
 * 这是选「最低价」的已知代价；要精确成本请依赖上面的 reported cost。
 *
 * ── 非 openrouter 条目 ──────────────────────────────────────────────────
 * 无前缀的 `gemini-*` 服务 `google:` / `vertex:` 路由，`us.anthropic.*` 等服务 `bedrock:`，
 * 它们的权威源是 Google / AWS 官方定价页，**不要拿 OpenRouter catalog 去改**。
 *
 * @see https://openrouter.ai/docs/features/provider-routing
 * @see https://openrouter.ai/docs/use-cases/usage-accounting
 * @see https://ai.google.dev/gemini-api/docs/pricing
 *
 * 更新频率：每月检查一次（对 /api/v1/models/{id}/endpoints 逐个核）
 */
const MODEL_PRICING: Record<string, ModelPricing> = {
  // Gemini 系列
  // Gemini 定价来源: https://ai.google.dev/gemini-api/docs/pricing
  // OpenRouter 和 Vertex/Google AI 直连价格相同
  'google/gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'google/gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  // 'google/gemini-2.5-pro': {
  //   input: 1.25,
  //   output: 10.0,
  //   longContext: { inputTokenThreshold: 200_000, input: 2.5, output: 15.0 },
  // }, // 不考虑使用
  'google/gemini-3-flash-preview': { input: 0.5, output: 3.0 },
  'google/gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'google/gemini-3.5-flash': { input: 1.5, output: 9.0 },
  'google/gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'google/gemini-3.6-flash': { input: 0.75, output: 3.75 }, // google-ai-studio
  'google/gemini-3.7-flash': { input: 0.75, output: 3.75 }, // google-ai-studio
  'google/gemini-3.8-flash': { input: 0.75, output: 3.75 }, // google-ai-studio
  // 'google/gemini-3.1-pro-preview': { input: 2.0, output: 12.0 }, // 不考虑使用
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  // 'gemini-2.5-pro': {
  //   input: 1.25,
  //   output: 10.0,
  //   longContext: { inputTokenThreshold: 200_000, input: 2.5, output: 15.0 },
  // }, // 不考虑使用
  'gemini-3-flash-preview': { input: 0.5, output: 3.0 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'gemini-3.5-flash': { input: 1.5, output: 9.0 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'gemini-3.6-flash': { input: 1.5, output: 7.5 },
  'gemini-3.7-flash': { input: 0.375, output: 1.875 },
  // gemini-3.8-flash 无前缀条目待 google:/vertex: 路由注册后再加 —— openrouter 走 'google/gemini-3.8-flash'
  // 'gemini-3.1-pro-preview': { input: 2.0, output: 12.0 }, // 不考虑使用

  // Anthropic Claude 系列
  // 'anthropic/claude-3.5-sonnet': { input: 6.0, output: 30.0 }, // 不考虑使用
  // 'anthropic/claude-3.5-haiku': { input: 0.8, output: 4.0 }, // 绝对 legacy
  'anthropic/claude-sonnet-4': { input: 3.0, output: 15.0 },
  'anthropic/claude-4-sonnet': { input: 3.0, output: 15.0 }, // alias
  // 'anthropic/claude-opus-4.1': { input: 15.0, output: 75.0 }, // 不考虑使用
  'anthropic/claude-4-opus': { input: 5.0, output: 25.0 },
  'anthropic/claude-haiku-4.5': { input: 1.0, output: 5.0 },
  'anthropic/claude-sonnet-4.5': {
    input: 3.0,
    output: 15.0,
    longContext: { inputTokenThreshold: 200_000, input: 6.0, output: 22.5 },
  }, // claude-on-aws
  'anthropic/claude-sonnet-4.6': { input: 3.0, output: 15.0 },
  'anthropic/claude-sonnet-5': { input: 2.0, output: 10.0 },
  // 'anthropic/claude-opus-4.6': { input: 5.0, output: 25.0 }, // 停用于 2026-09-05
  // 'anthropic/claude-opus-4.7': { input: 5.0, output: 25.0 }, // 停用于 2026-09-05
  // 'anthropic/claude-opus-4.8': { input: 5.0, output: 25.0 }, // 停用于 2026-09-05
  // 'anthropic/claude-opus-5': { input: 5.0, output: 25.0 }, // 停用于 2026-09-05

  // xAI Grok
  // 'x-ai/grok-3-mini': { input: 0.3, output: 0.5 }, // 绝对 legacy
  // 'x-ai/grok-4.1-fast': { input: 0.2, output: 0.5 }, // LIVE 2026-08-15 OpenRouter 404 deprecated
  'x-ai/grok-4.20': {
    input: 1.25,
    output: 2.5,
    longContext: { inputTokenThreshold: 200_000, input: 2.5, output: 5.0 },
  },
  'x-ai/grok-4.3': { input: 1.25, output: 2.5 },
  'x-ai/grok-4.5': {
    input: 2.0,
    output: 6.0,
    longContext: { inputTokenThreshold: 200_000, input: 4.0, output: 12.0 },
  },
  'x-ai/grok-4.6': {
    input: 2.0,
    output: 6.0,
    longContext: { inputTokenThreshold: 200_000, input: 4.0, output: 12.0 },
  },

  // StepFun
  'stepfun/step-3.5-flash': { input: 0.1, output: 0.3 },
  // 'stepfun/step-3.5-flash:free': { input: 0, output: 0 }, // LIVE 2026-08-15 OpenRouter 404

  // DeepSeek（OpenRouter 最低价 provider：DeepInfra/AtlasCloud；Vertex 约 $0.56/$1.68）
  'deepseek/deepseek-v3.2': { input: 0.2088, output: 0.3096 }, // gmicloud/fp8
  'deepseek/deepseek-v4-flash': { input: 0.0679, output: 0.168 }, // digitalocean
  'deepseek/deepseek-v4-pro': { input: 1.2, output: 1.2 }, // fireworks

  // MoonshotAI Kimi（OpenRouter 最低价 provider：SiliconFlow；Venice 约 $0.75/$3.75）
  'moonshotai/kimi-k2.5': { input: 0.45, output: 2.25 }, // siliconflow/int4
  'moonshotai/kimi-k2.6': { input: 0.5484, output: 2.3089 }, // decart/fp4
  'moonshotai/kimi-k2-thinking': { input: 0.6, output: 2.5 },
  'moonshotai/kimi-k3': { input: 2.55, output: 12.75 }, // makora
  'moonshotai/kimi-k2.7-code': { input: 0.7125, output: 3.0 }, // streamlake

  // Qwen
  'qwen/qwen3.6-flash': { input: 0.1875, output: 1.125 },
  'qwen/qwen3.7-flash': { input: 0.03, output: 0.13 },
  'qwen/qwen3.7-max': { input: 1.475, output: 4.425 }, // alibaba
  'qwen/qwen3.8-max': { input: 2.0, output: 6.0 },

  // Z.ai GLM - 不考虑使用
  // 'z-ai/glm-5': { input: 0.3, output: 2.55 },

  // MiniMax（Inceptron $1.10，其他 provider $1.20）
  'minimax/minimax-m2.5': { input: 0.27, output: 0.95 }, // venice
  'minimax/minimax-m3': { input: 0.23, output: 0.96 }, // coreweave/fp4

  // OpenAI
  'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
  'openai/gpt-5.1': { input: 1.25, output: 10.0 },
  'openai/gpt-5.2': { input: 1.75, output: 14.0 },
  'openai/gpt-5.2-pro': { input: 21.0, output: 168.0 },
  'openai/gpt-5.4': { input: 2.5, output: 15.0 },
  'openai/gpt-5.4-mini': { input: 0.75, output: 4.5 },
  'openai/gpt-5.4-nano': { input: 0.2, output: 1.25 },
  // 'openai/gpt-5.5': { input: 5.0, output: 30.0 }, // 停用于 2026-09-05
  // GPT-5.6 standard ≤272K input；long-context overrides are 2x input / 1.5x output.
  'openai/gpt-5.6-luna': {
    input: 0.2,
    output: 1.2,
    longContext: { inputTokenThreshold: 272_000, input: 0.4, output: 1.8 },
  }, // azure
  'openai/gpt-5.6-terra': {
    input: 2.0,
    output: 12.0,
    longContext: { inputTokenThreshold: 272_000, input: 4.0, output: 18.0 },
  }, // azure
  'openai/gpt-5.6-sol': {
    input: 2.0,
    output: 10.0,
    longContext: { inputTokenThreshold: 272_000, input: 4.0, output: 15.0 },
  }, // openai

  // ==================== AWS Bedrock（key 为 registry 中的 Bedrock modelId）====================
  // 定价来源：AWS Bedrock pricing（经 models.dev 镜像核对，2026-07-17）
  // Claude us.* inference profile 与区域价格一致
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': { input: 1.0, output: 5.0 },
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0': { input: 3.0, output: 15.0 },
  'us.anthropic.claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  // 停用于 2026-09-05（input ≥ $5/M）
  // 'us.anthropic.claude-opus-4-5-20251101-v1:0': { input: 5.0, output: 25.0 },
  // 'us.anthropic.claude-opus-4-6-v1': { input: 5.0, output: 25.0 },
  'moonshotai.kimi-k2.5': { input: 0.6, output: 3.0 },
  'moonshot.kimi-k2-thinking': { input: 0.6, output: 2.5 },
  'deepseek.v3.2': { input: 0.62, output: 1.85 },
  'minimax.minimax-m2.5': { input: 0.3, output: 1.2 },
  'us.amazon.nova-pro-v1:0': { input: 0.8, output: 3.2 },
  'us.amazon.nova-lite-v1:0': { input: 0.06, output: 0.24 },
  'us.amazon.nova-2-lite-v1:0': { input: 0.33, output: 2.75 },
};

/**
 * 根据 modelId 获取价格
 *
 * @param modelId - 模型 ID（OpenRouter 格式或 Google 直连格式）
 * @returns 价格信息，如果未找到返回 null
 */
function getPricing(modelId: string, promptTokens: number): TokenPricing | null {
  const pricing = MODEL_PRICING[modelId];
  if (!pricing) return null;

  if (pricing.longContext && promptTokens > pricing.longContext.inputTokenThreshold) {
    return pricing.longContext;
  }

  return pricing;
}

// ═══════════════════════════════════════════════════════════════════════════
// 成本计算
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 计算 LLM 调用成本（内部使用）
 */
function calculateCost(modelId: string, promptTokens: number, completionTokens: number, multiplier = 1): number | null {
  const pricing = getPricing(modelId, promptTokens);
  if (!pricing) return null;

  const inputCost = (promptTokens / 1_000_000) * pricing.input;
  const outputCost = (completionTokens / 1_000_000) * pricing.output;

  return (inputCost + outputCost) * multiplier;
}

/**
 * 从 LLMModelKey 计算成本（内部使用）
 */
function calculateCostFromKey(
  modelKey: LLMModelKey | string,
  promptTokens: number,
  completionTokens: number,
  context?: CostContext,
): number | null {
  // 不含 ':' 的当作裸 modelId 直接查表
  if (!modelKey.includes(':')) return calculateCost(modelKey, promptTokens, completionTokens);

  // registry 是 key → modelId 的唯一来源。不按 provider 分支自己解析：
  // 早期 openrouter 从 key 字符串猜前缀（漏了 stepfun，成本恒 null）、google 直接把
  // key 后半段当 modelId，而 vertex / bedrock 查 registry —— 同一件事四种写法。
  if (!isModelRegistered(modelKey)) return null;
  const config = getModel(modelKey);

  let multiplier = 1;
  if (config.provider === 'bedrock') {
    // reserved 为承诺吞吐（非按 token 计费），按标准价估算会误导，返回 null
    if (context?.bedrockServiceTier === 'reserved') return null;
    multiplier = BEDROCK_SERVICE_TIER_MULTIPLIER[context?.bedrockServiceTier ?? 'default'];
  }

  return calculateCost(config.modelId, promptTokens, completionTokens, multiplier);
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
export function getCostFromUsage(
  usage: unknown,
  modelKey?: LLMModelKey | string,
  context?: CostContext,
): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const usageObj = usage as Record<string, unknown>;

  // 优先使用 API 返回的 cost
  if (typeof usageObj.cost === 'number') {
    return usageObj.cost;
  }

  // Fallback: 手动计算
  if (modelKey) {
    const inputTokens =
      typeof usageObj.inputTokens === 'number'
        ? usageObj.inputTokens
        : typeof usageObj.promptTokens === 'number'
          ? usageObj.promptTokens
          : 0;
    const outputTokens =
      typeof usageObj.outputTokens === 'number'
        ? usageObj.outputTokens
        : typeof usageObj.completionTokens === 'number'
          ? usageObj.completionTokens
          : 0;
    return calculateCostFromKey(modelKey, inputTokens, outputTokens, context);
  }

  return null;
}
