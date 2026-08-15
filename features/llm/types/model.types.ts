/**
 * LLM Model Registry 类型定义
 *
 * 设计意图：
 * - Provider 和 Model 直接绑定（一个 Model Key 对应一个 Provider）
 * - Key 格式：provider:model（如 openrouter:gemini-2.5-flash）
 * - 同一模型可通过不同 Provider 访问（如 openrouter:gemini vs google:gemini）
 * - Provider 类型从 Model Registry 自动推导，无需单独维护
 *
 * Fallback 机制：
 * - 开发环境：model 不存在时直接报错（fail fast）
 * - 生产环境：model 不存在时 warning + fallback 到 DEFAULT_LLM_MODEL
 *
 * 扩展方式：
 * ```typescript
 * declare module '@app/llm-core' {
 *   interface LLMModelRegistry {
 *     'moonshot:kimi-k2': ModelConfig<'moonshot'>;
 *   }
 * }
 * registerModel('moonshot:kimi-k2', { provider: 'moonshot', modelId: 'kimi-k2' });
 * ```
 */

import { getLLMModelFields, SysEnv } from '@app/env';
import { getAppLogger } from '@app/utils/app-logger';

/**
 * Vertex 特有概念，通过 `X-Vertex-AI-LLM-Shared-Request-Type` header 传递。
 * `vertex-global:*` 是与 Google 官方 Priority/Flex PayGo URL 完全一致的路径；
 * `vertex:*` 是 Express Mode 兼容路径。
 * 具体哪些模型支持以 Google 官方文档为准（运行时由 `supportedTiers` 标注 + 降级）。
 *
 * - `standard`: 共享配额池（默认）
 * - `flex`: 低优先级 / 低价，请求可能排队
 * - `priority`: 独立配额桶，价格溢价
 *
 * @see https://docs.cloud.google.com/vertex-ai/generative-ai/docs/flex-paygo
 * @see https://docs.cloud.google.com/vertex-ai/generative-ai/docs/priority-paygo
 */
export type VertexTier = 'standard' | 'flex' | 'priority';

/**
 * Vertex `X-Vertex-AI-LLM-Request-Type` header.
 *
 * 目前只暴露 Google 文档中用于“只使用 Flex/Priority PayGo”的 `shared`。
 * 未设置时保留默认行为：如有 Provisioned Throughput，先用 PT，再溢出到对应 tier。
 *
 * @see https://docs.cloud.google.com/vertex-ai/generative-ai/docs/flex-paygo
 * @see https://docs.cloud.google.com/vertex-ai/generative-ai/docs/priority-paygo
 */
export type VertexRequestType = 'shared';

/** Google/Vertex thinking 参数契约：按 route 选择 token budget 或离散 effort level。 */
export type GoogleThinkingMode = 'budget' | 'level';

/**
 * Google/Vertex `thinking=none` 的 live 传输。
 *
 * 不能从 `googleThinkingMode` 推导：Vertex 3.7 拒 `thinkingLevel:minimal`，
 * Google 3.5-lite / 3.6 拒 `thinkingBudget:0`。缺省 = budget-zero。
 */
export type GoogleNoneThinking = 'budget-zero' | 'level-minimal';

/** 模块级单例，避免 `supportedTiers` 缺省时每次调用都分配新数组 */
export const DEFAULT_SUPPORTED_TIERS: readonly VertexTier[] = ['standard'];

/** OpenRouter provider 排序策略。 */
export type OpenRouterProviderSort = 'price' | 'throughput' | 'latency';

/** OpenRouter provider routing，框架侧使用 camelCase，adapter 负责转成 OpenRouter payload。 */
export interface OpenRouterProviderRouting {
  /** Provider slugs to try in order. */
  order?: readonly string[];
  /** Only allow these provider slugs. */
  only?: readonly string[];
  /** Skip these provider slugs. */
  ignore?: readonly string[];
  /** OpenRouter `allow_fallbacks`. */
  allowFallbacks?: boolean;
  /** OpenRouter `require_parameters`. */
  requireParameters?: boolean;
  /** Sort providers by a supported OpenRouter dimension. */
  sort?: OpenRouterProviderSort;
  /** Escape hatch for OpenRouter provider-routing fields not promoted by this framework yet. */
  extra?: Record<string, unknown>;
}

/** OpenRouter-specific options parsed from model specs or accepted by call sites. */
export interface OpenRouterModelOptions {
  /** Named routing profile, resolved by the OpenRouter adapter. */
  routing?: string;
  /** Direct provider routing override. */
  provider?: OpenRouterProviderRouting;
}

/** Vertex-specific options parsed from model specs. */
export interface VertexModelOptions {
  tier?: VertexTier;
  requestType?: VertexRequestType;
}

/**
 * AWS Bedrock service tier（per-request inference 服务层级）。
 *
 * 通过 `bedrock.serviceTier` model-spec 参数传递，映射到 Converse API 的 serviceTier。
 * 各模型的可用层级以 AWS 官方文档为准。
 *
 * @see https://docs.aws.amazon.com/bedrock/latest/userguide/service-tiers-inference.html
 */
export type BedrockServiceTier = 'default' | 'reserved' | 'priority' | 'flex';

/** Bedrock-specific options parsed from model specs. */
export interface BedrockModelOptions {
  serviceTier?: BedrockServiceTier;
}

/**
 * Model 配置接口
 */
export interface ModelConfig<P extends string = string> {
  /** Provider 标识 */
  provider: P;
  /** 实际 API Model ID（发送给 Provider 的值） */
  modelId: string;
  /** UI 显示名称（可选） */
  displayName?: string;
  /**
   * 模型强制启用 reasoning，无法关闭
   *
   * 标记为 true 时：
   * - 默认/显式 thinking=none 会做**参数层 fallback**（见 `reasoningDefaultEffort`，默认 `low`）并 warn
   * - 不会发送 disableThinking / effort:none（避免 400 "Reasoning is mandatory"）
   * - validateModelSpec 可报告 REASONING_DISABLE_FORBIDDEN + suggestions
   *
   * 例：OpenRouter `google/gemini-3.5-flash`（mandatory）、MiniMax M2.5
   */
  reasoningRequired?: boolean;
  /**
   * 调用方请求 thinking=none 时，registry 要采用的非 none fallback effort。
   *
   * - mandatory 模型可设置它来覆盖默认的 low；
   * - capability 尚未实证的 route 可单独设置它作为保守策略，而不把
   *   `reasoningRequired` 错标为 true。
   *
   * 仅 `reasoningRequired` 表达“无法关闭 reasoning”的能力事实；本字段只表达
   * runtime fallback policy。不得为 none。
   */
  reasoningDefaultEffort?: 'low' | 'medium' | 'high';
  /**
   * Google/Vertex thinking 参数模式（缺省 = budget，保持既有模型兼容性）。
   *
   * 当前 Gemini 3 官方接口使用 `thinkingLevel`；既有 live-probed compatibility routes
   * 可继续使用 `thinkingBudget`。仅适用于 google / vertex / vertex-global provider。
   */
  googleThinkingMode?: GoogleThinkingMode;
  /**
   * `thinking=none` 的 Google/Vertex 传输（缺省 = budget-zero）。
   *
   * 仅在 live 证明 `thinkingBudget:0` 会 400、且 `thinkingLevel:minimal`
   * 能把 reasoning_tokens 打到 0 时设置。不得从家族版本号推断。
   */
  googleNoneThinking?: GoogleNoneThinking;
  /**
   * 该模型端到端是否接受 messages 数组里的 system 条目（事实标记，缺省 = true）。
   *
   * 背景（2026-07-19 UNEE-SERVER-PQ）：ai@7.0.31 的 standardizePrompt 默认
   * `allowSystemInMessages=false`，客户端侧拒绝 system-in-messages——但多数
   * provider 适配层本来就会翻译（gemini → systemInstruction 等），历史流量普遍可用。
   * 因此缺省 true（ libs 调用 SDK 时透传 allowSystemInMessages: true ）；
   * 仅当实测 / 线上 400 证明某模型后端确实不接受时，单独标 `false`。
   * 事实来源：`features/llm/clients/system-in-messages.spec.live.ts`（e2e 探针）。
   */
  systemInMessages?: boolean;
  /**
   * 该模型支持的 Vertex tier 列表（仅 vertex / vertex-global provider 相关）
   *
   * - 未填 = 默认只支持 `standard`
   * - 其他 provider 应留空
   * - 以 Google 官方 Flex/Priority PayGo 文档列表为准
   *
   * 运行时传入不支持的 tier 不会抛异常，只 warn + 降级到 standard。
   */
  supportedTiers?: readonly VertexTier[];
}

/**
 * Model Registry 接口（项目层可通过 Declaration Merging 扩展）
 *
 * Key 格式：provider:model
 */
/**
 * Model Registry 接口（项目层可通过 Declaration Merging 扩展）
 *
 * Key 格式：provider:model
 *
 * OpenRouter Key 支持两种格式（等价，并存）：
 * - 简称：openrouter:gemini-2.5-flash
 * - 全称：openrouter:google/gemini-2.5-flash（与 OpenRouter modelId 一致）
 *
 * OpenRouter Provider 定价差异：
 * 各 provider 定价不同，选型时可通过 openrouter.provider.sort 控制路由偏好。
 *
 * @see https://openrouter.ai/models
 */
export interface LLMModelRegistry {
  // ==================== OpenRouter ====================
  /**
   * Gemini 2.5 Flash
   *
   * 定价参考（2026.02）：Input $0.30/M, Output $2.50/M, Context 1M
   * Live 2026-08-15 OpenRouter：disable thinking → 200 / reasoning_tokens=0（thinkingLevel 不支持）。
   *
   * @see https://openrouter.ai/google/gemini-2.5-flash
   */
  'openrouter:gemini-2.5-flash': ModelConfig<'openrouter'>;
  'openrouter:google/gemini-2.5-flash': ModelConfig<'openrouter'>;
  /**
   * Gemini 2.5 Pro — 不考虑使用（output ≥ $10/M）
   *
   * @see https://openrouter.ai/google/gemini-2.5-pro
   */
  // 'openrouter:gemini-2.5-pro': ModelConfig<'openrouter'>;
  // 'openrouter:google/gemini-2.5-pro': ModelConfig<'openrouter'>;
  /**
   * Gemini 2.5 Flash Lite
   *
   * 定价参考（2026.02）：Input $0.10/M, Output $0.40/M, Context 1M
   * Live 2026-08-15 OpenRouter：disable thinking → 200 / reasoning_tokens=0（thinkingLevel 不支持）。
   *
   * @see https://openrouter.ai/google/gemini-2.5-flash-lite
   */
  'openrouter:gemini-2.5-flash-lite': ModelConfig<'openrouter'>;
  'openrouter:google/gemini-2.5-flash-lite': ModelConfig<'openrouter'>;
  /**
   * Gemini 3 Flash Preview
   *
   * Live 2026-08-15 OpenRouter：disable thinking → 200 / reasoning_tokens=0；effort=low → 53。
   * 3.5+ Flash 在 OpenRouter 关不掉；本 key 仍是 OR 上可关 thinking 的 3 Flash。
   *
   * @see https://openrouter.ai/google/gemini-3-flash-preview
   */
  'openrouter:gemini-3-flash-preview': ModelConfig<'openrouter'>;
  'openrouter:google/gemini-3-flash-preview': ModelConfig<'openrouter'>;
  /**
   * Claude 3.5 Sonnet — 不考虑使用（output ≥ $10/M）
   *
   * @see https://openrouter.ai/anthropic/claude-3.5-sonnet
   */
  // 'openrouter:claude-3.5-sonnet': ModelConfig<'openrouter'>;
  // 'openrouter:anthropic/claude-3.5-sonnet': ModelConfig<'openrouter'>;
  /**
   * Claude 3.5 Haiku — 绝对 legacy（OpenRouter 404；同槽位为 Haiku 4.5）
   *
   * @see https://openrouter.ai/anthropic/claude-3.5-haiku
   */
  // 'openrouter:claude-3.5-haiku': ModelConfig<'openrouter'>;
  // 'openrouter:anthropic/claude-3.5-haiku': ModelConfig<'openrouter'>;
  /**
   * Claude 4 Sonnet
   *
   * 定价参考（2026.02）：Input $3/M, Output $15/M（≤200K），Context 1M
   *
   * @see https://openrouter.ai/anthropic/claude-sonnet-4
   */
  'openrouter:claude-4-sonnet': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-sonnet-4': ModelConfig<'openrouter'>;
  /**
   * Claude Sonnet 4.5
   *
   * 定价参考（2026.02）：Input $3/M, Output $15/M, Context 1M
   *
   * @see https://openrouter.ai/anthropic/claude-sonnet-4.5
   */
  'openrouter:claude-sonnet-4.5': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-sonnet-4.5': ModelConfig<'openrouter'>;
  /**
   * Claude Opus 4.1 — 不考虑使用（output ≥ $10/M）
   *
   * @see https://openrouter.ai/anthropic/claude-opus-4.1
   */
  // 'openrouter:claude-4.1-opus': ModelConfig<'openrouter'>;
  // 'openrouter:anthropic/claude-opus-4.1': ModelConfig<'openrouter'>;
  /**
   * Claude Opus 4.5 - 最强 coding
   *
   * 定价参考（2026.02）：Input $5/M, Output $25/M, Context 200K
   *
   * @see https://openrouter.ai/anthropic/claude-opus-4.5
   */
  'openrouter:claude-opus-4.5': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-opus-4.5': ModelConfig<'openrouter'>;
  /**
   * GPT-4o Mini
   *
   * 定价参考（2026.02）：Input $0.15/M, Output $0.60/M, Context 128K
   *
   * @see https://openrouter.ai/openai/gpt-4o-mini
   */
  'openrouter:gpt-4o-mini': ModelConfig<'openrouter'>;
  'openrouter:openai/gpt-4o-mini': ModelConfig<'openrouter'>;
  /**
   * Grok 3 Mini — 绝对 legacy（OpenRouter 404；4.x 线接班）
   *
   * @see https://openrouter.ai/x-ai/grok-3-mini
   */
  // 'openrouter:grok-3-mini': ModelConfig<'openrouter'>;
  // 'openrouter:x-ai/grok-3-mini': ModelConfig<'openrouter'>;
  /**
   * Grok 4.1 Fast — 绝对 legacy（LIVE 2026-08-15 OpenRouter 404 deprecated，官方改推 4.3）
   *
   * @see https://openrouter.ai/x-ai/grok-4.3
   */
  // 'openrouter:grok-4.1-fast': ModelConfig<'openrouter'>;
  // 'openrouter:x-ai/grok-4.1-fast': ModelConfig<'openrouter'>;
  /**
   * Step 3.5 Flash
   *
   * OpenRouter standard: Input $0.10/M, Output $0.30/M, Context 256K。
   * LIVE 2026-08-15 OpenRouter：disable → 400 mandatory。
   * `:free` slug 同日 404（paid only）。
   *
   * @see https://openrouter.ai/stepfun/step-3.5-flash
   */
  'openrouter:step-3.5-flash': ModelConfig<'openrouter'>;
  'openrouter:stepfun/step-3.5-flash': ModelConfig<'openrouter'>;
  // 'openrouter:stepfun/step-3.5-flash:free': ModelConfig<'openrouter'>; // LIVE 2026-08-15 OpenRouter 404
  /**
   * DeepSeek V3.2 - Roleplay #1
   *
   * 定价参考（2026.02）：Input $0.26/M, Output $0.38/M, Context 164K
   *
   * 特点：
   * - Roleplay 排名 #1
   * - 支持 reasoning 模式（可通过 reasoning_enabled 控制）
   * - DSA 稀疏注意力，长上下文高效
   * - GPT-5 级别推理能力
   *
   * Provider 定价（选型时注意）：
   * | Provider | Input | Output |
   * |----------|-------|--------|
   * | DeepInfra / AtlasCloud | $0.26 | $0.38 |
   * | NovitaAI | $0.269 | $0.40 |
   * | SiliconFlow | $0.27 | $0.42 |
   * | Parasail | $0.28 | $0.45 |
   * | Google Vertex | $0.56 | $1.68 | ← 贵 2-4x，慎用
   *
   * 建议：openrouter.provider.sort: 'price' 优先低价 provider
   */
  'openrouter:deepseek-v3.2': ModelConfig<'openrouter'>;
  'openrouter:deepseek/deepseek-v3.2': ModelConfig<'openrouter'>;
  /**
   * Kimi K2.5 - MoonshotAI 多模态模型
   *
   * 定价参考（2026.02）：Input $0.23/M, Output $3/M, Context 262K
   *
   * 视觉编码、Agent 工具调用能力强
   *
   * Provider 定价（选型时注意）：
   * | Provider | Input | Output |
   * |----------|-------|--------|
   * | SiliconFlow | $0.23 | $3 | ← 最低价
   * | DeepInfra | $0.45 | $2.25 |
   * | Inceptron / AtlasCloud / Together | $0.50 | $2.40-2.80 |
   * | NovitaAI / Moonshot / Fireworks / Baseten | $0.60 | $2.85-3 |
   * | Venice | $0.75 | $3.75 | ← 贵 2-3x
   *
   * 建议：openrouter.provider.sort: 'price' 优先 SiliconFlow
   *
   * @see https://openrouter.ai/moonshotai/kimi-k2.5
   */
  'openrouter:kimi-k2.5': ModelConfig<'openrouter'>;
  'openrouter:moonshotai/kimi-k2.5': ModelConfig<'openrouter'>;
  // GLM 5 - 不考虑使用（Z.ai，质量不够稳定）
  // 'openrouter:glm-5': ModelConfig<'openrouter'>;
  // 'openrouter:z-ai/glm-5': ModelConfig<'openrouter'>;
  /**
   * MiniMax M2.5 - Programming #1, Technology #1
   *
   * 定价参考（2026.02）：Input $0.30/M, Output $1.10/M, Context 196K
   *
   * 特点：
   * - SWE-Bench Verified 80.2%，Multi-SWE-Bench 51.3%
   * - 基于 M2.1 扩展到通用办公（Word/Excel/PPT）
   * - 多 Agent 协作、跨软件环境切换
   * - token 效率优化，规划式输出
   *
   * ⚠️ 限制：
   * - reasoning 强制开启，无法关闭（400 "Reasoning is mandatory"）
   * - Function Calling / 结构化输出能力差，容易漏字段（finishReason=stop 但 schema 不完整）
   * - 不适合需要严格 JSON Schema 遵守的场景（如 generateObject）
   *
   * Provider 定价（选型时注意）：
   * | Provider | Input | Output |
   * |----------|-------|--------|
   * | Inceptron | $0.30 | $1.10 | ← 最低价
   * | Parasail / Fireworks / AtlasCloud / Friendli / MiniMax | $0.30 | $1.20 |
   *
   * @see https://openrouter.ai/minimax/minimax-m2.5
   */
  'openrouter:minimax-m2.5': ModelConfig<'openrouter'>;
  'openrouter:minimax/minimax-m2.5': ModelConfig<'openrouter'>;
  /**
   * MiniMax M3
   *
   * OpenRouter standard: Input $0.30/M, Output $1.20/M, Context 1M.
   * Reasoning 可关闭。
   *
   * @see https://openrouter.ai/minimax/minimax-m3
   */
  'openrouter:minimax-m3': ModelConfig<'openrouter'>;
  'openrouter:minimax/minimax-m3': ModelConfig<'openrouter'>;

  /**
   * Gemini 3.1 Flash Lite
   *
   * 定价参考（2026.03）：Input $0.25/M, Output $1.50/M, Context 1M
   * Live 2026-08-15 OpenRouter：disable thinking → 200 / reasoning_tokens=0；effort=low → 58。
   *
   * @see https://openrouter.ai/google/gemini-3.1-flash-lite
   */
  'openrouter:gemini-3.1-flash-lite': ModelConfig<'openrouter'>;
  'openrouter:google/gemini-3.1-flash-lite': ModelConfig<'openrouter'>;

  /**
   * Gemini 3.5 Flash - GA
   *
   * 定价参考（2026.05）：Input $1.50/M, Output $9/M, Context 1M
   * Live 2026-08-15 OpenRouter：disable thinking → 400 mandatory。Vertex Express 另测，见 vertex: key。
   *
   * @see https://openrouter.ai/google/gemini-3.5-flash
   */
  'openrouter:gemini-3.5-flash': ModelConfig<'openrouter'>;
  'openrouter:google/gemini-3.5-flash': ModelConfig<'openrouter'>;

  /**
   * Gemini 3.5 Flash-Lite - GA
   *
   * OpenRouter standard: Input $0.30/M, Output $2.50/M, Context 1,048,576, Max output 65,536.
   * Live 2026-08-15 OpenRouter：disable thinking → 400 mandatory。Vertex Express 另测，见 vertex: key。
   *
   * @see https://openrouter.ai/google/gemini-3.5-flash-lite
   */
  'openrouter:gemini-3.5-flash-lite': ModelConfig<'openrouter'>;
  'openrouter:google/gemini-3.5-flash-lite': ModelConfig<'openrouter'>;

  /**
   * Gemini 3.6 Flash - GA
   *
   * OpenRouter 定价（2026-07-21）：
   * - Standard: Input $1.50/M, Output $7.50/M
   * - Flex: Input $0.75/M, Output $3.75/M
   * - Priority: Input $2.70/M, Output $13.50/M
   * - Context 1,048,576；Max output 65,536
   *
   * Live 2026-08-15 OpenRouter：disable thinking → 400 mandatory。Vertex Express 另测，见 vertex: key。
   *
   * @see https://openrouter.ai/google/gemini-3.6-flash
   */
  'openrouter:gemini-3.6-flash': ModelConfig<'openrouter'>;
  'openrouter:google/gemini-3.6-flash': ModelConfig<'openrouter'>;

  /**
   * Gemini 3.7 Flash - GA
   *
   * OpenRouter 定价（2026-08-13 catalog）：Input $0.375/M, Output $1.875/M,
   * Context 1,048,576；Max output 65,536。
   *
   * Live 2026-08-15 OpenRouter：disable thinking → 400 mandatory。未注册 vertex: 路由。
   *
   * @see https://openrouter.ai/google/gemini-3.7-flash
   */
  'openrouter:gemini-3.7-flash': ModelConfig<'openrouter'>;
  'openrouter:google/gemini-3.7-flash': ModelConfig<'openrouter'>;

  /**
   * Gemini 3.1 Pro Preview — 不考虑使用（output ≥ $10/M）
   *
   * @see https://openrouter.ai/google/gemini-3.1-pro-preview
   */
  // 'openrouter:gemini-3.1-pro-preview': ModelConfig<'openrouter'>;
  // 'openrouter:google/gemini-3.1-pro-preview': ModelConfig<'openrouter'>;

  // ---- Anthropic Claude (4.5+) ----
  /**
   * Claude Haiku 4.5 - 低价快速
   *
   * 定价参考（2026.05）：Input $1/M, Output $5/M, Context 200K
   *
   * @see https://openrouter.ai/anthropic/claude-haiku-4.5
   */
  'openrouter:claude-haiku-4.5': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-haiku-4.5': ModelConfig<'openrouter'>;
  /**
   * Claude Sonnet 4.6 - 旗舰对话/工具调用
   *
   * 定价参考（2026.05）：Input $3/M, Output $15/M, Context 1M
   *
   * @see https://openrouter.ai/anthropic/claude-sonnet-4.6
   */
  'openrouter:claude-sonnet-4.6': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-sonnet-4.6': ModelConfig<'openrouter'>;
  /**
   * Claude Sonnet 5 - 1M context / adaptive reasoning
   *
   * OpenRouter standard: Input $2/M, Output $10/M, Max output 128K.
   * Reasoning 可关闭；provider 默认 medium，library 支持 low/medium/high 子集。
   *
   * @see https://openrouter.ai/anthropic/claude-sonnet-5
   */
  'openrouter:claude-sonnet-5': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-sonnet-5': ModelConfig<'openrouter'>;
  /**
   * Claude Opus 4.6
   *
   * 定价参考（2026.05）：Input $5/M, Output $25/M, Context 1M
   *
   * @see https://openrouter.ai/anthropic/claude-opus-4.6
   */
  'openrouter:claude-opus-4.6': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-opus-4.6': ModelConfig<'openrouter'>;
  /**
   * Claude Opus 4.7
   *
   * 定价参考（2026.05）：Input $5/M, Output $25/M, Context 1M
   *
   * @see https://openrouter.ai/anthropic/claude-opus-4.7
   */
  'openrouter:claude-opus-4.7': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-opus-4.7': ModelConfig<'openrouter'>;
  /**
   * Claude Opus 4.8 - 1M context / optional reasoning
   *
   * OpenRouter standard: Input $5/M, Output $25/M.
   *
   * @see https://openrouter.ai/anthropic/claude-opus-4.8
   */
  'openrouter:claude-opus-4.8': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-opus-4.8': ModelConfig<'openrouter'>;
  /**
   * Claude Opus 5 - 最新旗舰
   *
   * OpenRouter standard: Input $5/M, Output $25/M, Context 1M.
   * Reasoning 可关闭；provider 默认 high。
   *
   * @see https://openrouter.ai/anthropic/claude-opus-5
   */
  'openrouter:claude-opus-5': ModelConfig<'openrouter'>;
  'openrouter:anthropic/claude-opus-5': ModelConfig<'openrouter'>;

  // ---- OpenAI GPT-5 ----
  /**
   * GPT-5.1
   *
   * 定价参考（2026.05）：Input $1.25/M, Output $10/M, Context 400K
   *
   * @see https://openrouter.ai/openai/gpt-5.1
   */
  'openrouter:gpt-5.1': ModelConfig<'openrouter'>;
  'openrouter:openai/gpt-5.1': ModelConfig<'openrouter'>;
  /**
   * GPT-5.2
   *
   * 定价参考（2026.05）：Input $1.75/M, Output $14/M, Context 400K
   *
   * @see https://openrouter.ai/openai/gpt-5.2
   */
  'openrouter:gpt-5.2': ModelConfig<'openrouter'>;
  'openrouter:openai/gpt-5.2': ModelConfig<'openrouter'>;
  /**
   * GPT-5.4 - 主力
   *
   * 定价参考（2026.05）：Input $2.50/M, Output $15/M, Context 1.05M
   *
   * @see https://openrouter.ai/openai/gpt-5.4
   */
  'openrouter:gpt-5.4': ModelConfig<'openrouter'>;
  'openrouter:openai/gpt-5.4': ModelConfig<'openrouter'>;
  /**
   * GPT-5.4 Mini
   *
   * 定价参考（2026.05）：Input $0.75/M, Output $4.50/M, Context 400K
   *
   * @see https://openrouter.ai/openai/gpt-5.4-mini
   */
  'openrouter:gpt-5.4-mini': ModelConfig<'openrouter'>;
  'openrouter:openai/gpt-5.4-mini': ModelConfig<'openrouter'>;
  /**
   * GPT-5.4 Nano
   *
   * 定价参考（2026.05）：Input $0.20/M, Output $1.25/M, Context 400K
   *
   * @see https://openrouter.ai/openai/gpt-5.4-nano
   */
  'openrouter:gpt-5.4-nano': ModelConfig<'openrouter'>;
  'openrouter:openai/gpt-5.4-nano': ModelConfig<'openrouter'>;
  /**
   * GPT-5.5 - 最新旗舰
   *
   * 定价参考（2026.05）：Input $5/M, Output $30/M, Context 1.05M
   *
   * @see https://openrouter.ai/openai/gpt-5.5
   */
  'openrouter:gpt-5.5': ModelConfig<'openrouter'>;
  'openrouter:openai/gpt-5.5': ModelConfig<'openrouter'>;
  /**
   * GPT-5.6 family - 1.05M context / 128K max output
   *
   * OpenRouter standard (≤272K input tokens):
   * - Luna: Input $1/M, Output $6/M
   * - Terra: Input $2.50/M, Output $15/M
   * - Sol: Input $5/M, Output $30/M
   *
   * >272K input tokens 使用 OpenRouter long-context override；API-returned cost 优先于静态估算。
   * Reasoning 支持 none/low/medium/high（provider 另支持 xhigh/max）。
   */
  'openrouter:gpt-5.6-luna': ModelConfig<'openrouter'>;
  'openrouter:openai/gpt-5.6-luna': ModelConfig<'openrouter'>;
  'openrouter:gpt-5.6-terra': ModelConfig<'openrouter'>;
  'openrouter:openai/gpt-5.6-terra': ModelConfig<'openrouter'>;
  'openrouter:gpt-5.6-sol': ModelConfig<'openrouter'>;
  'openrouter:openai/gpt-5.6-sol': ModelConfig<'openrouter'>;

  // ---- xAI Grok (4.20+) ----
  /**
   * Grok 4.20 - 2M context
   *
   * OpenRouter standard (≤200K input tokens): Input $1.25/M, Output $2.50/M；
   * long context (>200K input): Input $2.50/M, Output $5/M.
   *
   * @see https://openrouter.ai/x-ai/grok-4.20
   */
  'openrouter:grok-4.20': ModelConfig<'openrouter'>;
  'openrouter:x-ai/grok-4.20': ModelConfig<'openrouter'>;
  /**
   * Grok 4.3 - 最新旗舰
   *
   * 定价参考（2026.05）：Input $1.25/M, Output $2.50/M, Context 1M
   *
   * @see https://openrouter.ai/x-ai/grok-4.3
   */
  'openrouter:grok-4.3': ModelConfig<'openrouter'>;
  'openrouter:x-ai/grok-4.3': ModelConfig<'openrouter'>;
  /**
   * Grok 4.5 - 500K context
   *
   * OpenRouter standard (≤200K input tokens): Input $2/M, Output $6/M；long context 为 $4/$12。
   * Reasoning 强制开启，provider 默认 high；library 对 no-thinking intent 以 low fallback。
   *
   * @see https://openrouter.ai/x-ai/grok-4.5
   */
  'openrouter:grok-4.5': ModelConfig<'openrouter'>;
  'openrouter:x-ai/grok-4.5': ModelConfig<'openrouter'>;
  /**
   * Grok 4.6 - 最新旗舰，500K context
   *
   * OpenRouter standard (≤200K input tokens): Input $2/M, Output $6/M；long context 为 $4/$12。
   * Reasoning 强制开启，provider 默认 high；library 对 no-thinking intent 以 low fallback。
   *
   * @see https://openrouter.ai/x-ai/grok-4.6
   */
  'openrouter:grok-4.6': ModelConfig<'openrouter'>;
  'openrouter:x-ai/grok-4.6': ModelConfig<'openrouter'>;

  // ---- DeepSeek / MoonshotAI Kimi / Qwen ----
  /**
   * DeepSeek V4 Flash - 高性价比
   *
   * 定价参考（2026.05）：Input $0.112/M, Output $0.224/M, Context 1M
   *
   * @see https://openrouter.ai/deepseek/deepseek-v4-flash
   */
  'openrouter:deepseek-v4-flash': ModelConfig<'openrouter'>;
  'openrouter:deepseek/deepseek-v4-flash': ModelConfig<'openrouter'>;
  /**
   * DeepSeek V4 Pro - 旗舰推理
   *
   * 定价参考（2026.05）：Input $0.435/M, Output $0.87/M, Context 1M
   *
   * @see https://openrouter.ai/deepseek/deepseek-v4-pro
   */
  'openrouter:deepseek-v4-pro': ModelConfig<'openrouter'>;
  'openrouter:deepseek/deepseek-v4-pro': ModelConfig<'openrouter'>;
  /**
   * Kimi K2.6 - MoonshotAI 新一代
   *
   * 定价参考（2026.05）：Input $0.73/M, Output $3.49/M, Context 262K
   *
   * @see https://openrouter.ai/moonshotai/kimi-k2.6
   */
  'openrouter:kimi-k2.6': ModelConfig<'openrouter'>;
  'openrouter:moonshotai/kimi-k2.6': ModelConfig<'openrouter'>;
  /**
   * Kimi K2 Thinking - 推理特化（reasoning 强制开启）
   *
   * 定价参考（2026.05）：Input $0.60/M, Output $2.50/M, Context 262K
   *
   * @see https://openrouter.ai/moonshotai/kimi-k2-thinking
   */
  'openrouter:kimi-k2-thinking': ModelConfig<'openrouter'>;
  'openrouter:moonshotai/kimi-k2-thinking': ModelConfig<'openrouter'>;
  /**
   * Kimi K3 - 2.8T open-weight multimodal reasoning model
   *
   * OpenRouter standard: Input $3/M, Output $15/M, Context 1,048,576.
   * Reasoning metadata 为非强制，provider 默认 max；library 支持 low/high 子集。
   *
   * @see https://openrouter.ai/moonshotai/kimi-k3
   */
  'openrouter:kimi-k3': ModelConfig<'openrouter'>;
  'openrouter:moonshotai/kimi-k3': ModelConfig<'openrouter'>;
  /**
   * Kimi K2.7 Code - 代码特化（reasoning 强制开启）
   *
   * OpenRouter standard: Input $0.67/M, Output $3.40/M, Context 262K.
   *
   * @see https://openrouter.ai/moonshotai/kimi-k2.7-code
   */
  'openrouter:kimi-k2.7-code': ModelConfig<'openrouter'>;
  'openrouter:moonshotai/kimi-k2.7-code': ModelConfig<'openrouter'>;
  /**
   * Qwen3.6 Flash - 高性价比
   *
   * 定价参考（2026.05）：Input $0.1875/M, Output $1.125/M, Context 1M
   *
   * @see https://openrouter.ai/qwen/qwen3.6-flash
   */
  'openrouter:qwen3.6-flash': ModelConfig<'openrouter'>;
  'openrouter:qwen/qwen3.6-flash': ModelConfig<'openrouter'>;
  /**
   * Qwen3.7 Flash
   *
   * OpenRouter standard: Input $0.03/M, Output $0.13/M, Context 1M.
   * Reasoning 可关闭。
   *
   * @see https://openrouter.ai/qwen/qwen3.7-flash
   */
  'openrouter:qwen3.7-flash': ModelConfig<'openrouter'>;
  'openrouter:qwen/qwen3.7-flash': ModelConfig<'openrouter'>;
  /**
   * Qwen3.7 Max
   *
   * 定价参考（2026.05）：Input $2.50/M, Output $7.50/M, Context 1M
   *
   * @see https://openrouter.ai/qwen/qwen3.7-max
   */
  'openrouter:qwen3.7-max': ModelConfig<'openrouter'>;
  'openrouter:qwen/qwen3.7-max': ModelConfig<'openrouter'>;
  /**
   * Qwen3.8 Max - 最新旗舰
   *
   * OpenRouter standard: Input $2/M, Output $6/M, Context 1M.
   * Reasoning 强制开启，provider 默认 xhigh；library 对 no-thinking intent 以 low fallback。
   *
   * @see https://openrouter.ai/qwen/qwen3.8-max
   */
  'openrouter:qwen3.8-max': ModelConfig<'openrouter'>;
  'openrouter:qwen/qwen3.8-max': ModelConfig<'openrouter'>;

  // ==================== Google Direct (AI Studio) ====================
  // LIVE 2026-08-15 generateText（disable=thinkingBudget:0 / thinkingLevel），非 resolveThinking。
  // TESTED disable → reasoning_tokens=0：2.5-flash/lite、3-flash-preview、3.1-flash-lite、3.5-flash、3.7-flash
  // TESTED thinkingLevel=low：3-preview 21、3.1-lite 57、3.5-flash 57、3.7-flash 57
  // 2.5 thinkingLevel=low → 400 "Thinking level is not supported"（保持缺省 budget）
  // 3.5-flash-lite / 3.6：thinkingBudget:0 → 400；none 走 thinkingLevel:minimal（reasoning_tokens=0）
  'google:gemini-2.5-flash': ModelConfig<'google'>;
  // 'google:gemini-2.5-pro': ModelConfig<'google'>; // 不考虑使用（output ≥ $10/M）
  'google:gemini-2.5-flash-lite': ModelConfig<'google'>;
  'google:gemini-3-flash-preview': ModelConfig<'google'>;
  'google:gemini-3.1-flash-lite': ModelConfig<'google'>;
  'google:gemini-3.5-flash': ModelConfig<'google'>;
  'google:gemini-3.5-flash-lite': ModelConfig<'google'>;
  'google:gemini-3.6-flash': ModelConfig<'google'>;
  'google:gemini-3.7-flash': ModelConfig<'google'>;
  // 'google:gemini-3.1-pro-preview': ModelConfig<'google'>; // 不考虑使用（output ≥ $10/M）

  // ==================== Vertex AI (Express Mode) ====================
  // LIVE 2026-08-15 generateText + Doppler AI_GOOGLE_VERTEX_API_KEY（unee-server/stg）。
  // TESTED disable → reasoning_tokens=0：2.5-flash/lite、3-flash-preview、3.1-flash-lite、3.5-flash/lite、3.6-flash、3.7-flash
  // TESTED thinkingLevel：3-preview 57 / 3.1-lite 58 / 3.5 55 / 3.5-lite 50 / 3.6 59 / 3.7 medium=60 high=107（low=0）
  // 2.5 thinkingLevel=low → 400 thinking_level is not supported（保持缺省 budget）
  'vertex:gemini-2.5-flash': ModelConfig<'vertex'>;
  // 'vertex:gemini-2.5-pro': ModelConfig<'vertex'>; // 不考虑使用（output ≥ $10/M）
  'vertex:gemini-2.5-flash-lite': ModelConfig<'vertex'>;
  'vertex:gemini-3-flash-preview': ModelConfig<'vertex'>;
  'vertex:gemini-3.1-flash-lite': ModelConfig<'vertex'>;
  'vertex:gemini-3.5-flash': ModelConfig<'vertex'>;
  'vertex:gemini-3.5-flash-lite': ModelConfig<'vertex'>;
  'vertex:gemini-3.6-flash': ModelConfig<'vertex'>;
  'vertex:gemini-3.7-flash': ModelConfig<'vertex'>;
  // 'vertex:gemini-3.1-pro-preview': ModelConfig<'vertex'>; // 不考虑使用（output ≥ $10/M）

  // ==================== Vertex AI (project/global mode) ====================
  // UNTESTED 2026-08-15：Doppler unee-server/stg 无 GOOGLE_VERTEX_PROJECT，未做 live generateText。
  // 不得把上面 Express「可关 thinking」的结论套到这些 key。
  'vertex-global:gemini-2.5-flash': ModelConfig<'vertex-global'>;
  // 'vertex-global:gemini-2.5-pro': ModelConfig<'vertex-global'>; // 不考虑使用（output ≥ $10/M）
  'vertex-global:gemini-2.5-flash-lite': ModelConfig<'vertex-global'>;
  'vertex-global:gemini-3-flash-preview': ModelConfig<'vertex-global'>;
  'vertex-global:gemini-3.1-flash-lite': ModelConfig<'vertex-global'>;
  'vertex-global:gemini-3.5-flash': ModelConfig<'vertex-global'>;
  'vertex-global:gemini-3.5-flash-lite': ModelConfig<'vertex-global'>;
  'vertex-global:gemini-3.6-flash': ModelConfig<'vertex-global'>;
  // 'vertex-global:gemini-3.1-pro-preview': ModelConfig<'vertex-global'>; // 不考虑使用（output ≥ $10/M）

  // ==================== AWS Bedrock ====================
  // 模型可用性已在 mission-ai-v2（account 421454274824）/ us-east-2 验证（2026-07-17）。
  // Claude 全系为 inference-profile only，modelId 使用 us.anthropic.* 前缀。
  /**
   * Claude Haiku 4.5 - 低价快速
   *
   * @see https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html
   */
  'bedrock:claude-haiku-4.5': ModelConfig<'bedrock'>;
  /** Claude Sonnet 4.5 */
  'bedrock:claude-sonnet-4.5': ModelConfig<'bedrock'>;
  /** Claude Sonnet 4.6 */
  'bedrock:claude-sonnet-4.6': ModelConfig<'bedrock'>;
  /** Claude Opus 4.5 */
  'bedrock:claude-opus-4.5': ModelConfig<'bedrock'>;
  /** Claude Opus 4.6 */
  'bedrock:claude-opus-4.6': ModelConfig<'bedrock'>;
  /** Kimi K2.5（on-demand，moonshotai.kimi-k2.5） */
  'bedrock:kimi-k2.5': ModelConfig<'bedrock'>;
  /** Kimi K2 Thinking（on-demand；reasoning 强制开启，无法关闭） */
  'bedrock:kimi-k2-thinking': ModelConfig<'bedrock'>;
  /** DeepSeek V3.2（on-demand） */
  'bedrock:deepseek-v3.2': ModelConfig<'bedrock'>;
  /** MiniMax M2.5（on-demand；reasoning 强制开启，无法关闭） */
  'bedrock:minimax-m2.5': ModelConfig<'bedrock'>;
  /** Amazon Nova Pro（inference profile） */
  'bedrock:nova-pro': ModelConfig<'bedrock'>;
  /** Amazon Nova Lite（inference profile / on-demand） */
  'bedrock:nova-lite': ModelConfig<'bedrock'>;
  /** Amazon Nova 2 Lite（inference profile；支持 maxReasoningEffort） */
  'bedrock:nova-2-lite': ModelConfig<'bedrock'>;
}

/**
 * 从 Registry 推导的 Model Key 联合类型
 */
export type LLMModelKey = keyof LLMModelRegistry;

/**
 * Thinking effort 级别（与 llm.class.ts 中的 ThinkingEffort 保持一致）
 *
 * 在 model.types.ts 中重新定义以避免循环依赖（model.types → llm.class → model.types）
 */
type ThinkingEffortLevel = 'none' | 'low' | 'medium' | 'high';

/**
 * Model Spec — 携带运行时参数的 Model Key
 *
 * 格式：`provider:model` 或 `provider:model?param=value&...`
 * 使用 URL query string 语法，用 URLSearchParams 解析。
 *
 * 参数嵌入 model key 的好处：
 * - 在 env.ts 中配置模型时同时指定参数，无需改业务代码
 * - 换模型时参数跟着走（Grok 需要 reason，Gemini 不需要）
 * - 调用方仍可通过显式参数覆盖
 *
 * 支持的参数：
 * - reason: thinking effort（none/low/medium/high）
 *
 * @example
 * 'openrouter:grok-4.3?reason=low'  // Grok + low reasoning
 * 'openrouter:gemini-3.7-flash'           // Gemini, no params
 */
export type LLMModelSpec = LLMModelKey | `${LLMModelKey}?${string}`;

/**
 * parseModelSpec 的返回结果
 */
export interface ParsedModelSpec {
  key: LLMModelKey;
  provider: LLMProviderType;
  thinking: ThinkingEffortLevel | undefined;
  /**
   * Raw `reason` query when present but not in VALID_THINKING_EFFORTS.
   * Runtime still ignores it (`thinking` stays undefined); validateModelSpec reports it.
   */
  invalidReason: string | undefined;
  /** 最大重试次数（覆盖 AI_LLM_MAX_RETRIES） */
  maxRetries: number | undefined;
  /** 超时毫秒（覆盖 AI_LLM_TIMEOUT_MS） */
  timeout: number | undefined;
  /** 降级模型链，主模型失败后依次尝试 */
  fallbackModels: LLMModelKey[];
  /** Provider-namespaced Vertex options. */
  vertex: VertexModelOptions | undefined;
  /** Provider-namespaced OpenRouter options. */
  openrouter: OpenRouterModelOptions | undefined;
  /** Provider-namespaced Bedrock options. */
  bedrock: BedrockModelOptions | undefined;
}

const VALID_THINKING_EFFORTS = new Set<string>(['none', 'low', 'medium', 'high']);
const VALID_VERTEX_TIERS = new Set<string>(['standard', 'flex', 'priority']);
const VALID_VERTEX_REQUEST_TYPES = new Set<string>(['shared']);
const VALID_BEDROCK_SERVICE_TIERS = new Set<string>(['default', 'reserved', 'priority', 'flex']);
const REMOVED_MODEL_SPEC_PARAMS = new Map([
  ['tier', 'vertex.tier'],
  ['vertexRequestType', 'vertex.requestType'],
] as const);

function findRemovedModelSpecParam(params: URLSearchParams): readonly [string, string] | undefined {
  for (const [removed, canonical] of REMOVED_MODEL_SPEC_PARAMS) {
    if (params.has(removed)) return [removed, canonical];
  }
  return undefined;
}

function parseProviderFromKey(key: LLMModelKey): LLMProviderType {
  return key.slice(0, key.indexOf(':')) as LLMProviderType;
}

/**
 * 解析 LLMModelSpec 为 base key + 参数
 *
 * @example
 * parseModelSpec('openrouter:grok-4.3?reason=low')
 * // → { key: 'openrouter:grok-4.3', thinking: 'low' }
 *
 * parseModelSpec('openrouter:gemini-3.7-flash')
 * // → { key: 'openrouter:gemini-3.7-flash', thinking: undefined }
 */
export function parseModelSpec(spec: LLMModelSpec): ParsedModelSpec {
  const qIdx = spec.indexOf('?');
  if (qIdx === -1) {
    const key = spec as LLMModelKey;
    return {
      key,
      provider: parseProviderFromKey(key),
      thinking: undefined,
      invalidReason: undefined,
      maxRetries: undefined,
      timeout: undefined,
      fallbackModels: [],
      vertex: undefined,
      openrouter: undefined,
      bedrock: undefined,
    };
  }
  const key = spec.slice(0, qIdx) as LLMModelKey;
  const provider = parseProviderFromKey(key);
  const params = new URLSearchParams(spec.slice(qIdx + 1));
  const removedParam = findRemovedModelSpecParam(params);
  if (removedParam) {
    const [removed, canonical] = removedParam;
    throw new Error(`Model spec parameter "${removed}" has been removed; use "${canonical}" in "${spec}"`);
  }

  // reason → thinking effort（无效值 warning + 忽略，不阻断；invalidReason 留给 validate）
  const reason = params.get('reason');
  let thinking: ThinkingEffortLevel | undefined;
  let invalidReason: string | undefined;
  if (reason !== null) {
    if (VALID_THINKING_EFFORTS.has(reason)) {
      thinking = reason as ThinkingEffortLevel;
    } else {
      invalidReason = reason;
      logger.warning`[parseModelSpec] Invalid reason "${reason}" in "${spec}", ignoring. Valid: ${[...VALID_THINKING_EFFORTS].join(', ')}`;
    }
  }

  // retry → maxRetries（无效值 warning + 忽略）
  const retryRaw = params.get('retry');
  let maxRetries: number | undefined;
  if (retryRaw !== null) {
    const n = Number(retryRaw);
    if (/^\d+$/.test(retryRaw) && n >= 0) {
      maxRetries = n;
    } else {
      logger.warning`[parseModelSpec] Invalid retry "${retryRaw}" in "${spec}", ignoring. Must be non-negative integer.`;
    }
  }

  // timeout → timeout ms（无效值 warning + 忽略）
  const timeoutRaw = params.get('timeout');
  let timeout: number | undefined;
  if (timeoutRaw !== null) {
    const n = Number(timeoutRaw);
    if (/^\d+$/.test(timeoutRaw) && n >= 1000) {
      timeout = n;
    } else {
      logger.warning`[parseModelSpec] Invalid timeout "${timeoutRaw}" in "${spec}", ignoring. Must be ≥ 1000ms.`;
    }
  }

  // fallback → fallback model chain（未注册的 warning + 跳过）
  const fallbackRaw = params.get('fallback');
  const fallbackModels: LLMModelKey[] = [];
  if (fallbackRaw) {
    for (const fb of fallbackRaw.split(',')) {
      const trimmed = fb.trim();
      if (!trimmed) continue;
      if (!modelRegistry.has(trimmed)) {
        logger.warning`[parseModelSpec] Fallback model "${trimmed}" in "${spec}" not registered, skipping.`;
        continue;
      }
      fallbackModels.push(trimmed as LLMModelKey);
    }
  }

  // vertex.tier → Vertex AI tier.
  const tierRaw = params.get('vertex.tier');
  let tier: VertexTier | undefined;
  if (tierRaw !== null) {
    if (provider !== 'vertex' && provider !== 'vertex-global') {
      logger.warning`[parseModelSpec] vertex.tier requested for non-vertex provider=${provider} in "${spec}", ignoring`;
    } else if (VALID_VERTEX_TIERS.has(tierRaw)) {
      tier = tierRaw as VertexTier;
    } else {
      logger.warning`[parseModelSpec] Invalid vertex.tier "${tierRaw}" in "${spec}", ignoring. Valid: ${[...VALID_VERTEX_TIERS].join(', ')}`;
    }
  }

  // vertex.requestType → Vertex AI request type header.
  const vertexRequestTypeRaw = params.get('vertex.requestType');
  let vertexRequestType: VertexRequestType | undefined;
  if (vertexRequestTypeRaw !== null) {
    if (provider !== 'vertex' && provider !== 'vertex-global') {
      logger.warning`[parseModelSpec] vertex.requestType requested for non-vertex provider=${provider} in "${spec}", ignoring`;
    } else if (VALID_VERTEX_REQUEST_TYPES.has(vertexRequestTypeRaw)) {
      vertexRequestType = vertexRequestTypeRaw as VertexRequestType;
    } else {
      logger.warning`[parseModelSpec] Invalid vertex.requestType "${vertexRequestTypeRaw}" in "${spec}", ignoring. Valid: ${[...VALID_VERTEX_REQUEST_TYPES].join(', ')}`;
    }
  }

  // openrouter.routing → OpenRouter named routing profile.
  const openrouterRoutingRaw = params.get('openrouter.routing');
  let openrouter: OpenRouterModelOptions | undefined;
  if (openrouterRoutingRaw !== null) {
    if (provider === 'openrouter') {
      openrouter = { routing: openrouterRoutingRaw };
    } else {
      logger.warning`[parseModelSpec] openrouter.routing requested for provider=${provider} in "${spec}", ignoring`;
    }
  }

  // bedrock.serviceTier → Bedrock service tier.
  const serviceTierRaw = params.get('bedrock.serviceTier');
  let serviceTier: BedrockServiceTier | undefined;
  if (serviceTierRaw !== null) {
    if (provider !== 'bedrock') {
      logger.warning`[parseModelSpec] bedrock.serviceTier requested for non-bedrock provider=${provider} in "${spec}", ignoring`;
    } else if (VALID_BEDROCK_SERVICE_TIERS.has(serviceTierRaw)) {
      serviceTier = serviceTierRaw as BedrockServiceTier;
    } else {
      logger.warning`[parseModelSpec] Invalid bedrock.serviceTier "${serviceTierRaw}" in "${spec}", ignoring. Valid: ${[...VALID_BEDROCK_SERVICE_TIERS].join(', ')}`;
    }
  }

  const bedrock = serviceTier !== undefined ? { serviceTier } : undefined;

  const vertex =
    tier !== undefined || vertexRequestType !== undefined
      ? {
          ...(tier !== undefined ? { tier } : {}),
          ...(vertexRequestType !== undefined ? { requestType: vertexRequestType } : {}),
        }
      : undefined;

  return {
    key,
    provider,
    thinking,
    invalidReason,
    maxRetries,
    timeout,
    fallbackModels,
    vertex,
    openrouter,
    bedrock,
  };
}

/**
 * 从 Registry 推导的 Provider 联合类型
 * 会自动包含所有注册的 Provider
 */
export type LLMProviderType = LLMModelRegistry[LLMModelKey]['provider'];

// ==================== 运行时 Registry ====================

const modelRegistry = new Map<string, ModelConfig>([
  // OpenRouter 模型（简称 + 全称成对，按模型分组）
  // Gemini 2.5 Flash — LIVE 2026-08-15 OpenRouter disable → 200 / reasoning_tokens=0
  ['openrouter:gemini-2.5-flash', { provider: 'openrouter', modelId: 'google/gemini-2.5-flash' }],
  ['openrouter:google/gemini-2.5-flash', { provider: 'openrouter', modelId: 'google/gemini-2.5-flash' }],
  // Gemini 2.5 Pro — 不考虑使用（output ≥ $10/M）
  // ['openrouter:gemini-2.5-pro', { provider: 'openrouter', modelId: 'google/gemini-2.5-pro' }],
  // ['openrouter:google/gemini-2.5-pro', { provider: 'openrouter', modelId: 'google/gemini-2.5-pro' }],
  // Gemini 2.5 Flash Lite — LIVE 2026-08-15 OpenRouter disable → 200 / reasoning_tokens=0
  ['openrouter:gemini-2.5-flash-lite', { provider: 'openrouter', modelId: 'google/gemini-2.5-flash-lite' }],
  ['openrouter:google/gemini-2.5-flash-lite', { provider: 'openrouter', modelId: 'google/gemini-2.5-flash-lite' }],
  // Gemini 3 Flash Preview — LIVE 2026-08-15 OpenRouter disable → 200 / reasoning_tokens=0
  ['openrouter:gemini-3-flash-preview', { provider: 'openrouter', modelId: 'google/gemini-3-flash-preview' }],
  ['openrouter:google/gemini-3-flash-preview', { provider: 'openrouter', modelId: 'google/gemini-3-flash-preview' }],
  // Claude 3.5 Sonnet — 不考虑使用（output ≥ $10/M）
  // ['openrouter:claude-3.5-sonnet', { provider: 'openrouter', modelId: 'anthropic/claude-3.5-sonnet' }],
  // ['openrouter:anthropic/claude-3.5-sonnet', { provider: 'openrouter', modelId: 'anthropic/claude-3.5-sonnet' }],
  // Claude 3.5 Haiku — 绝对 legacy
  // ['openrouter:claude-3.5-haiku', { provider: 'openrouter', modelId: 'anthropic/claude-3.5-haiku' }],
  // ['openrouter:anthropic/claude-3.5-haiku', { provider: 'openrouter', modelId: 'anthropic/claude-3.5-haiku' }],
  // Claude 4 Sonnet
  ['openrouter:claude-4-sonnet', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4' }],
  ['openrouter:anthropic/claude-sonnet-4', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4' }],
  // Claude Sonnet 4.5
  ['openrouter:claude-sonnet-4.5', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4.5' }],
  ['openrouter:anthropic/claude-sonnet-4.5', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4.5' }],
  // Claude Opus 4.1 — 不考虑使用（output ≥ $10/M）
  // ['openrouter:claude-4.1-opus', { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.1' }],
  // ['openrouter:anthropic/claude-opus-4.1', { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.1' }],
  // Claude Opus 4.5
  ['openrouter:claude-opus-4.5', { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.5' }],
  ['openrouter:anthropic/claude-opus-4.5', { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.5' }],
  // GPT-4o Mini
  ['openrouter:gpt-4o-mini', { provider: 'openrouter', modelId: 'openai/gpt-4o-mini' }],
  ['openrouter:openai/gpt-4o-mini', { provider: 'openrouter', modelId: 'openai/gpt-4o-mini' }],
  // Grok 3 Mini — 绝对 legacy
  // ['openrouter:grok-3-mini', { provider: 'openrouter', modelId: 'x-ai/grok-3-mini' }],
  // ['openrouter:x-ai/grok-3-mini', { provider: 'openrouter', modelId: 'x-ai/grok-3-mini' }],
  // Grok 4.1 Fast — LIVE 2026-08-15 OpenRouter 404 deprecated
  // ['openrouter:grok-4.1-fast', { provider: 'openrouter', modelId: 'x-ai/grok-4.1-fast' }],
  // ['openrouter:x-ai/grok-4.1-fast', { provider: 'openrouter', modelId: 'x-ai/grok-4.1-fast' }],
  // Step 3.5 Flash — LIVE 2026-08-15 OpenRouter disable → 400 mandatory
  ['openrouter:step-3.5-flash', { provider: 'openrouter', modelId: 'stepfun/step-3.5-flash', reasoningRequired: true }],
  [
    'openrouter:stepfun/step-3.5-flash',
    { provider: 'openrouter', modelId: 'stepfun/step-3.5-flash', reasoningRequired: true },
  ],
  // ['openrouter:stepfun/step-3.5-flash:free', { provider: 'openrouter', modelId: 'stepfun/step-3.5-flash:free', reasoningRequired: true }], // LIVE 404
  // DeepSeek V3.2
  ['openrouter:deepseek-v3.2', { provider: 'openrouter', modelId: 'deepseek/deepseek-v3.2' }],
  ['openrouter:deepseek/deepseek-v3.2', { provider: 'openrouter', modelId: 'deepseek/deepseek-v3.2' }],
  // Kimi K2.5
  ['openrouter:kimi-k2.5', { provider: 'openrouter', modelId: 'moonshotai/kimi-k2.5' }],
  ['openrouter:moonshotai/kimi-k2.5', { provider: 'openrouter', modelId: 'moonshotai/kimi-k2.5' }],
  // GLM 5 - 不考虑使用
  // ['openrouter:glm-5', { provider: 'openrouter', modelId: 'z-ai/glm-5' }],
  // ['openrouter:z-ai/glm-5', { provider: 'openrouter', modelId: 'z-ai/glm-5' }],
  // MiniMax M2.5 — LIVE 2026-08-15 OpenRouter disable → 400 mandatory
  ['openrouter:minimax-m2.5', { provider: 'openrouter', modelId: 'minimax/minimax-m2.5', reasoningRequired: true }],
  [
    'openrouter:minimax/minimax-m2.5',
    { provider: 'openrouter', modelId: 'minimax/minimax-m2.5', reasoningRequired: true },
  ],
  // MiniMax M3 — OpenRouter metadata: reasoning optional
  ['openrouter:minimax-m3', { provider: 'openrouter', modelId: 'minimax/minimax-m3' }],
  ['openrouter:minimax/minimax-m3', { provider: 'openrouter', modelId: 'minimax/minimax-m3' }],

  // Gemini 3.1 Flash Lite — LIVE 2026-08-15 OpenRouter disable → 200 / reasoning_tokens=0
  ['openrouter:gemini-3.1-flash-lite', { provider: 'openrouter', modelId: 'google/gemini-3.1-flash-lite' }],
  ['openrouter:google/gemini-3.1-flash-lite', { provider: 'openrouter', modelId: 'google/gemini-3.1-flash-lite' }],

  // Gemini 3.5 Flash via OpenRouter — LIVE 2026-08-15 disable → 400 mandatory；param-fallback to low
  [
    'openrouter:gemini-3.5-flash',
    {
      provider: 'openrouter',
      modelId: 'google/gemini-3.5-flash',
      reasoningRequired: true,
      reasoningDefaultEffort: 'low',
    },
  ],
  [
    'openrouter:google/gemini-3.5-flash',
    {
      provider: 'openrouter',
      modelId: 'google/gemini-3.5-flash',
      reasoningRequired: true,
      reasoningDefaultEffort: 'low',
    },
  ],

  // Gemini 3.5 Flash-Lite via OpenRouter — LIVE 2026-08-15 disable → 400 mandatory；param-fallback to low
  [
    'openrouter:gemini-3.5-flash-lite',
    {
      provider: 'openrouter',
      modelId: 'google/gemini-3.5-flash-lite',
      reasoningRequired: true,
      reasoningDefaultEffort: 'low',
    },
  ],
  [
    'openrouter:google/gemini-3.5-flash-lite',
    {
      provider: 'openrouter',
      modelId: 'google/gemini-3.5-flash-lite',
      reasoningRequired: true,
      reasoningDefaultEffort: 'low',
    },
  ],

  // Gemini 3.6 Flash via OpenRouter — LIVE 2026-08-15 disable → 400 mandatory；param-fallback to low
  [
    'openrouter:gemini-3.6-flash',
    {
      provider: 'openrouter',
      modelId: 'google/gemini-3.6-flash',
      reasoningRequired: true,
      reasoningDefaultEffort: 'low',
    },
  ],
  [
    'openrouter:google/gemini-3.6-flash',
    {
      provider: 'openrouter',
      modelId: 'google/gemini-3.6-flash',
      reasoningRequired: true,
      reasoningDefaultEffort: 'low',
    },
  ],

  // Gemini 3.7 Flash via OpenRouter — LIVE 2026-08-15 disable → 400 mandatory；未注册 vertex:。param-fallback to low
  [
    'openrouter:gemini-3.7-flash',
    {
      provider: 'openrouter',
      modelId: 'google/gemini-3.7-flash',
      reasoningRequired: true,
      reasoningDefaultEffort: 'low',
    },
  ],
  [
    'openrouter:google/gemini-3.7-flash',
    {
      provider: 'openrouter',
      modelId: 'google/gemini-3.7-flash',
      reasoningRequired: true,
      reasoningDefaultEffort: 'low',
    },
  ],

  // Gemini 3.1 Pro Preview — 不考虑使用（output ≥ $10/M）
  // ['openrouter:gemini-3.1-pro-preview', { provider: 'openrouter', modelId: 'google/gemini-3.1-pro-preview' }],
  // ['openrouter:google/gemini-3.1-pro-preview', { provider: 'openrouter', modelId: 'google/gemini-3.1-pro-preview' }],

  // Claude Haiku 4.5
  ['openrouter:claude-haiku-4.5', { provider: 'openrouter', modelId: 'anthropic/claude-haiku-4.5' }],
  ['openrouter:anthropic/claude-haiku-4.5', { provider: 'openrouter', modelId: 'anthropic/claude-haiku-4.5' }],
  // Claude Sonnet 4.6
  ['openrouter:claude-sonnet-4.6', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4.6' }],
  ['openrouter:anthropic/claude-sonnet-4.6', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4.6' }],
  // Claude Sonnet 5 — OpenRouter metadata: optional adaptive reasoning
  ['openrouter:claude-sonnet-5', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-5' }],
  ['openrouter:anthropic/claude-sonnet-5', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-5' }],
  // Claude Opus 4.6
  ['openrouter:claude-opus-4.6', { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.6' }],
  ['openrouter:anthropic/claude-opus-4.6', { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.6' }],
  // Claude Opus 4.7
  ['openrouter:claude-opus-4.7', { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.7' }],
  ['openrouter:anthropic/claude-opus-4.7', { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.7' }],
  // Claude Opus 4.8 — OpenRouter metadata: optional reasoning
  ['openrouter:claude-opus-4.8', { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.8' }],
  ['openrouter:anthropic/claude-opus-4.8', { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.8' }],
  // Claude Opus 5 — OpenRouter metadata: optional reasoning
  ['openrouter:claude-opus-5', { provider: 'openrouter', modelId: 'anthropic/claude-opus-5' }],
  ['openrouter:anthropic/claude-opus-5', { provider: 'openrouter', modelId: 'anthropic/claude-opus-5' }],

  // GPT-5.1
  ['openrouter:gpt-5.1', { provider: 'openrouter', modelId: 'openai/gpt-5.1' }],
  ['openrouter:openai/gpt-5.1', { provider: 'openrouter', modelId: 'openai/gpt-5.1' }],
  // GPT-5.2
  ['openrouter:gpt-5.2', { provider: 'openrouter', modelId: 'openai/gpt-5.2' }],
  ['openrouter:openai/gpt-5.2', { provider: 'openrouter', modelId: 'openai/gpt-5.2' }],
  // GPT-5.4
  ['openrouter:gpt-5.4', { provider: 'openrouter', modelId: 'openai/gpt-5.4' }],
  ['openrouter:openai/gpt-5.4', { provider: 'openrouter', modelId: 'openai/gpt-5.4' }],
  // GPT-5.4 Mini
  ['openrouter:gpt-5.4-mini', { provider: 'openrouter', modelId: 'openai/gpt-5.4-mini' }],
  ['openrouter:openai/gpt-5.4-mini', { provider: 'openrouter', modelId: 'openai/gpt-5.4-mini' }],
  // GPT-5.4 Nano
  ['openrouter:gpt-5.4-nano', { provider: 'openrouter', modelId: 'openai/gpt-5.4-nano' }],
  ['openrouter:openai/gpt-5.4-nano', { provider: 'openrouter', modelId: 'openai/gpt-5.4-nano' }],
  // GPT-5.5
  ['openrouter:gpt-5.5', { provider: 'openrouter', modelId: 'openai/gpt-5.5' }],
  ['openrouter:openai/gpt-5.5', { provider: 'openrouter', modelId: 'openai/gpt-5.5' }],
  // GPT-5.6 family — OpenRouter metadata: reasoning supports none
  ['openrouter:gpt-5.6-luna', { provider: 'openrouter', modelId: 'openai/gpt-5.6-luna' }],
  ['openrouter:openai/gpt-5.6-luna', { provider: 'openrouter', modelId: 'openai/gpt-5.6-luna' }],
  ['openrouter:gpt-5.6-terra', { provider: 'openrouter', modelId: 'openai/gpt-5.6-terra' }],
  ['openrouter:openai/gpt-5.6-terra', { provider: 'openrouter', modelId: 'openai/gpt-5.6-terra' }],
  ['openrouter:gpt-5.6-sol', { provider: 'openrouter', modelId: 'openai/gpt-5.6-sol' }],
  ['openrouter:openai/gpt-5.6-sol', { provider: 'openrouter', modelId: 'openai/gpt-5.6-sol' }],

  // Grok 4.20
  ['openrouter:grok-4.20', { provider: 'openrouter', modelId: 'x-ai/grok-4.20' }],
  ['openrouter:x-ai/grok-4.20', { provider: 'openrouter', modelId: 'x-ai/grok-4.20' }],
  // Grok 4.3
  ['openrouter:grok-4.3', { provider: 'openrouter', modelId: 'x-ai/grok-4.3' }],
  ['openrouter:x-ai/grok-4.3', { provider: 'openrouter', modelId: 'x-ai/grok-4.3' }],
  // Grok 4.5 — LIVE 2026-08-15 OpenRouter disable → 400 mandatory
  [
    'openrouter:grok-4.5',
    { provider: 'openrouter', modelId: 'x-ai/grok-4.5', reasoningRequired: true, reasoningDefaultEffort: 'low' },
  ],
  [
    'openrouter:x-ai/grok-4.5',
    { provider: 'openrouter', modelId: 'x-ai/grok-4.5', reasoningRequired: true, reasoningDefaultEffort: 'low' },
  ],
  // Grok 4.6 — LIVE 2026-08-15 OpenRouter disable → 400 mandatory
  [
    'openrouter:grok-4.6',
    { provider: 'openrouter', modelId: 'x-ai/grok-4.6', reasoningRequired: true, reasoningDefaultEffort: 'low' },
  ],
  [
    'openrouter:x-ai/grok-4.6',
    { provider: 'openrouter', modelId: 'x-ai/grok-4.6', reasoningRequired: true, reasoningDefaultEffort: 'low' },
  ],

  // DeepSeek V4 Flash
  ['openrouter:deepseek-v4-flash', { provider: 'openrouter', modelId: 'deepseek/deepseek-v4-flash' }],
  ['openrouter:deepseek/deepseek-v4-flash', { provider: 'openrouter', modelId: 'deepseek/deepseek-v4-flash' }],
  // DeepSeek V4 Pro
  ['openrouter:deepseek-v4-pro', { provider: 'openrouter', modelId: 'deepseek/deepseek-v4-pro' }],
  ['openrouter:deepseek/deepseek-v4-pro', { provider: 'openrouter', modelId: 'deepseek/deepseek-v4-pro' }],
  // Kimi K2.6
  ['openrouter:kimi-k2.6', { provider: 'openrouter', modelId: 'moonshotai/kimi-k2.6' }],
  ['openrouter:moonshotai/kimi-k2.6', { provider: 'openrouter', modelId: 'moonshotai/kimi-k2.6' }],
  // Kimi K2 Thinking — LIVE 2026-08-15 OpenRouter disable → 400 mandatory
  [
    'openrouter:kimi-k2-thinking',
    { provider: 'openrouter', modelId: 'moonshotai/kimi-k2-thinking', reasoningRequired: true },
  ],
  [
    'openrouter:moonshotai/kimi-k2-thinking',
    { provider: 'openrouter', modelId: 'moonshotai/kimi-k2-thinking', reasoningRequired: true },
  ],
  // Kimi K3 — OpenRouter metadata: reasoning optional
  ['openrouter:kimi-k3', { provider: 'openrouter', modelId: 'moonshotai/kimi-k3' }],
  ['openrouter:moonshotai/kimi-k3', { provider: 'openrouter', modelId: 'moonshotai/kimi-k3' }],
  // Kimi K2.7 Code — LIVE 2026-08-15 OpenRouter disable → 400 mandatory
  [
    'openrouter:kimi-k2.7-code',
    { provider: 'openrouter', modelId: 'moonshotai/kimi-k2.7-code', reasoningRequired: true },
  ],
  [
    'openrouter:moonshotai/kimi-k2.7-code',
    { provider: 'openrouter', modelId: 'moonshotai/kimi-k2.7-code', reasoningRequired: true },
  ],
  // Qwen3.6 Flash
  ['openrouter:qwen3.6-flash', { provider: 'openrouter', modelId: 'qwen/qwen3.6-flash' }],
  ['openrouter:qwen/qwen3.6-flash', { provider: 'openrouter', modelId: 'qwen/qwen3.6-flash' }],
  // Qwen3.7 Flash — OpenRouter metadata: reasoning optional
  ['openrouter:qwen3.7-flash', { provider: 'openrouter', modelId: 'qwen/qwen3.7-flash' }],
  ['openrouter:qwen/qwen3.7-flash', { provider: 'openrouter', modelId: 'qwen/qwen3.7-flash' }],
  // Qwen3.7 Max
  ['openrouter:qwen3.7-max', { provider: 'openrouter', modelId: 'qwen/qwen3.7-max' }],
  ['openrouter:qwen/qwen3.7-max', { provider: 'openrouter', modelId: 'qwen/qwen3.7-max' }],
  // Qwen3.8 Max — LIVE 2026-08-15 OpenRouter disable → 400 mandatory
  [
    'openrouter:qwen3.8-max',
    {
      provider: 'openrouter',
      modelId: 'qwen/qwen3.8-max',
      reasoningRequired: true,
      reasoningDefaultEffort: 'low',
    },
  ],
  [
    'openrouter:qwen/qwen3.8-max',
    {
      provider: 'openrouter',
      modelId: 'qwen/qwen3.8-max',
      reasoningRequired: true,
      reasoningDefaultEffort: 'low',
    },
  ],

  // Google Direct — LIVE 2026-08-15：2.5 可关 thinking，但不支持 thinkingLevel（缺省 budget）
  ['google:gemini-2.5-flash', { provider: 'google', modelId: 'gemini-2.5-flash' }],
  // ['google:gemini-2.5-pro', { provider: 'google', modelId: 'gemini-2.5-pro' }], // 不考虑使用
  ['google:gemini-2.5-flash-lite', { provider: 'google', modelId: 'gemini-2.5-flash-lite' }],
  // LIVE 2026-08-15：disable → reasoning_tokens=0；thinkingLevel=low 有 reasoning tokens
  [
    'google:gemini-3-flash-preview',
    { provider: 'google', modelId: 'gemini-3-flash-preview', googleThinkingMode: 'level' },
  ],
  [
    'google:gemini-3.1-flash-lite',
    { provider: 'google', modelId: 'gemini-3.1-flash-lite', googleThinkingMode: 'level' },
  ],
  // LIVE：disable → reasoning_tokens=0；thinkingLevel=low 有 reasoning tokens
  ['google:gemini-3.5-flash', { provider: 'google', modelId: 'gemini-3.5-flash', googleThinkingMode: 'level' }],
  // LIVE：thinkingBudget:0 → 400；thinkingLevel:minimal → reasoning_tokens=0
  [
    'google:gemini-3.5-flash-lite',
    {
      provider: 'google',
      modelId: 'gemini-3.5-flash-lite',
      googleThinkingMode: 'level',
      googleNoneThinking: 'level-minimal',
    },
  ],
  [
    'google:gemini-3.6-flash',
    {
      provider: 'google',
      modelId: 'gemini-3.6-flash',
      googleThinkingMode: 'level',
      googleNoneThinking: 'level-minimal',
    },
  ],
  ['google:gemini-3.7-flash', { provider: 'google', modelId: 'gemini-3.7-flash', googleThinkingMode: 'level' }],
  // ['google:gemini-3.1-pro-preview', { provider: 'google', modelId: 'gemini-3.1-pro-preview' }], // 不考虑使用

  // Vertex Express — LIVE 2026-08-15 Doppler AI_GOOGLE_VERTEX_API_KEY
  // 这些 key 保持既有 API-key Express Mode 语义；需要 Google 官方 project/global
  // Priority/Flex PayGo 路径时，使用下方 `vertex-global:*` key。
  // supportedTiers 以 Google 官方文档为准，更新时同步两个列表：
  // - Flex: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/flex-paygo
  // - Priority: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/priority-paygo
  // LIVE：disable → reasoning_tokens=0；thinkingLevel=low → 400 not supported（保持缺省 budget）
  [
    'vertex:gemini-2.5-flash',
    { provider: 'vertex', modelId: 'gemini-2.5-flash', supportedTiers: ['standard', 'priority'] },
  ],
  // [
  //   'vertex:gemini-2.5-pro',
  //   { provider: 'vertex', modelId: 'gemini-2.5-pro', supportedTiers: ['standard', 'priority'] },
  // ], // 不考虑使用
  [
    'vertex:gemini-2.5-flash-lite',
    { provider: 'vertex', modelId: 'gemini-2.5-flash-lite', supportedTiers: ['standard', 'priority'] },
  ],
  // LIVE：disable → reasoning_tokens=0；thinkingLevel=low 有 reasoning tokens
  [
    'vertex:gemini-3-flash-preview',
    {
      provider: 'vertex',
      modelId: 'gemini-3-flash-preview',
      googleThinkingMode: 'level',
      supportedTiers: ['standard', 'flex', 'priority'],
    },
  ],
  [
    'vertex:gemini-3.1-flash-lite',
    {
      provider: 'vertex',
      modelId: 'gemini-3.1-flash-lite',
      googleThinkingMode: 'level',
      supportedTiers: ['standard', 'flex', 'priority'],
    },
  ],
  [
    'vertex:gemini-3.5-flash',
    {
      provider: 'vertex',
      modelId: 'gemini-3.5-flash',
      googleThinkingMode: 'level',
      supportedTiers: ['standard', 'flex', 'priority'],
    },
  ],
  [
    'vertex:gemini-3.5-flash-lite',
    {
      provider: 'vertex',
      modelId: 'gemini-3.5-flash-lite',
      googleThinkingMode: 'level',
      supportedTiers: ['standard', 'flex', 'priority'],
    },
  ],
  [
    'vertex:gemini-3.6-flash',
    {
      provider: 'vertex',
      modelId: 'gemini-3.6-flash',
      googleThinkingMode: 'level',
      supportedTiers: ['standard', 'flex', 'priority'],
    },
  ],
  // LIVE：disable → reasoning_tokens=0；thinkingLevel medium/high 有 reasoning tokens（low=0）
  [
    'vertex:gemini-3.7-flash',
    {
      provider: 'vertex',
      modelId: 'gemini-3.7-flash',
      googleThinkingMode: 'level',
    },
  ],
  // [
  //   'vertex:gemini-3.1-pro-preview',
  //   {
  //     provider: 'vertex',
  //     modelId: 'gemini-3.1-pro-preview',
  //     supportedTiers: ['standard', 'flex', 'priority'],
  //   },
  // ], // 不考虑使用

  // Vertex project/global — UNTESTED 2026-08-15（Doppler 无 GOOGLE_VERTEX_PROJECT）
  // 不得把 Express 的 disable 证据套到这些 key。3.5-lite / 3.6 的 reasoningDefaultEffort=low
  // 是保守策略，不是 live 证明 mandatory。
  // Google Priority/Flex PayGo 文档要求使用 /projects/{project}/locations/global/... 路径。
  [
    'vertex-global:gemini-2.5-flash',
    { provider: 'vertex-global', modelId: 'gemini-2.5-flash', supportedTiers: ['standard', 'priority'] },
  ],
  // [
  //   'vertex-global:gemini-2.5-pro',
  //   { provider: 'vertex-global', modelId: 'gemini-2.5-pro', supportedTiers: ['standard', 'priority'] },
  // ], // 不考虑使用
  [
    'vertex-global:gemini-2.5-flash-lite',
    { provider: 'vertex-global', modelId: 'gemini-2.5-flash-lite', supportedTiers: ['standard', 'priority'] },
  ],
  [
    'vertex-global:gemini-3-flash-preview',
    { provider: 'vertex-global', modelId: 'gemini-3-flash-preview', supportedTiers: ['standard', 'flex', 'priority'] },
  ],
  [
    'vertex-global:gemini-3.1-flash-lite',
    {
      provider: 'vertex-global',
      modelId: 'gemini-3.1-flash-lite',
      supportedTiers: ['standard', 'flex', 'priority'],
    },
  ],
  [
    'vertex-global:gemini-3.5-flash',
    { provider: 'vertex-global', modelId: 'gemini-3.5-flash', supportedTiers: ['standard', 'flex', 'priority'] },
  ],
  // Express evidence does not establish project/global no-thinking behavior.
  // Keep this access profile on the lowest public effort until separately live-probed.
  [
    'vertex-global:gemini-3.5-flash-lite',
    {
      provider: 'vertex-global',
      modelId: 'gemini-3.5-flash-lite',
      reasoningDefaultEffort: 'low',
      googleThinkingMode: 'level',
      supportedTiers: ['standard', 'flex', 'priority'],
    },
  ],
  // The official project/global contract exposes thinking levels; keep no-thinking conservative until live-probed.
  [
    'vertex-global:gemini-3.6-flash',
    {
      provider: 'vertex-global',
      modelId: 'gemini-3.6-flash',
      reasoningDefaultEffort: 'low',
      googleThinkingMode: 'level',
      supportedTiers: ['standard', 'flex', 'priority'],
    },
  ],
  // [
  //   'vertex-global:gemini-3.1-pro-preview',
  //   {
  //     provider: 'vertex-global',
  //     modelId: 'gemini-3.1-pro-preview',
  //     supportedTiers: ['standard', 'flex', 'priority'],
  //   },
  // ], // 不考虑使用

  // AWS Bedrock 模型
  // 可用性已在 mission-ai-v2 (account 421454274824) / us-east-2 验证（2026-07-17）。
  // Claude 全系为 inference-profile only，modelId 必须带 us. 前缀；
  // 区域需为美国区域端点（us-east-1/us-east-2/us-west-2…），见 specs/2026-07-17-llm-bedrock-provider.tpdd.md。
  ['bedrock:claude-haiku-4.5', { provider: 'bedrock', modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' }],
  ['bedrock:claude-sonnet-4.5', { provider: 'bedrock', modelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' }],
  ['bedrock:claude-sonnet-4.6', { provider: 'bedrock', modelId: 'us.anthropic.claude-sonnet-4-6' }],
  ['bedrock:claude-opus-4.5', { provider: 'bedrock', modelId: 'us.anthropic.claude-opus-4-5-20251101-v1:0' }],
  ['bedrock:claude-opus-4.6', { provider: 'bedrock', modelId: 'us.anthropic.claude-opus-4-6-v1' }],
  ['bedrock:kimi-k2.5', { provider: 'bedrock', modelId: 'moonshotai.kimi-k2.5' }],
  // LIVE 2026-08-15：plain / reasoningConfig.disabled 均 200；usage 无 reasoningTokens 字段，关没关上看不出来
  ['bedrock:kimi-k2-thinking', { provider: 'bedrock', modelId: 'moonshot.kimi-k2-thinking', reasoningRequired: true }],
  ['bedrock:deepseek-v3.2', { provider: 'bedrock', modelId: 'deepseek.v3.2' }],
  ['bedrock:minimax-m2.5', { provider: 'bedrock', modelId: 'minimax.minimax-m2.5', reasoningRequired: true }],
  ['bedrock:nova-pro', { provider: 'bedrock', modelId: 'us.amazon.nova-pro-v1:0' }],
  ['bedrock:nova-lite', { provider: 'bedrock', modelId: 'us.amazon.nova-lite-v1:0' }],
  ['bedrock:nova-2-lite', { provider: 'bedrock', modelId: 'us.amazon.nova-2-lite-v1:0' }],
]);

// ==================== 注册函数 ====================

/**
 * 注册新的 Model（项目层扩展时调用）
 *
 * @example
 * registerModel('moonshot:kimi-k2', { provider: 'moonshot', modelId: 'kimi-k2-turbo-preview' });
 */
export function registerModel<K extends string, P extends string>(key: K, config: ModelConfig<P>): void {
  modelRegistry.set(key, config);
}

// ==================== 查询函数 ====================

const logger = getAppLogger('features', 'LLMModel');

/**
 * 获取 Model 配置
 *
 * Fallback 机制：
 * - 开发环境：model 不存在时直接报错（fail fast）
 * - 生产环境：model 不存在时 warning + fallback 到 DEFAULT_LLM_MODEL
 */
export function getModel(spec: LLMModelSpec): ModelConfig {
  const { key } = parseModelSpec(spec);
  const config = modelRegistry.get(key);
  if (config) {
    return config;
  }

  // Model 不存在，检查环境决定处理方式
  const fallbackKey = SysEnv.DEFAULT_LLM_MODEL;
  const isProd = SysEnv.environment.isProd;

  if (!isProd) {
    // 开发环境：直接报错，快速发现问题
    throw new Error(`Unknown model: "${key}". Registered models: ${getRegisteredModels().join(', ')}`);
  }

  // 生产环境：warning + fallback
  const fallbackConfig = modelRegistry.get(fallbackKey as string);
  if (!fallbackConfig) {
    // fallback 模型也不存在，必须报错
    throw new Error(
      `Unknown model: "${key}" and fallback model "${fallbackKey}" is also not registered. ` +
        `Check DEFAULT_LLM_MODEL configuration.`,
    );
  }

  logger.warning`#getModel Unknown model "${key}", falling back to "${fallbackKey}". This indicates a configuration issue that should be fixed.`;

  return fallbackConfig;
}

/**
 * 获取实际 API Model ID
 *
 * @example
 * getModelId('openrouter:claude-sonnet-4.5') // → 'anthropic/claude-sonnet-4.5'
 */
export function getModelId(spec: LLMModelSpec): string {
  return getModel(spec).modelId;
}

/**
 * 获取 Provider
 *
 * @example
 * getProvider('openrouter:gemini-2.5-flash') // → 'openrouter'
 */
export function getProvider(spec: LLMModelSpec): LLMProviderType {
  return getModel(spec).provider as LLMProviderType;
}

/**
 * 未标注 supportedTiers 的模型默认走 `['standard']`。
 * 调用方可预先判断；也可直接传 tier，运行时不支持会 warn + 降级。
 *
 * @example
 * getSupportedTiers('vertex-global:gemini-3.1-flash-lite') // → ['standard', 'flex', 'priority']
 * getSupportedTiers('vertex:gemini-2.5-flash-lite')                 // → ['standard', 'priority']
 * getSupportedTiers('openrouter:grok-4.3')                     // → ['standard']
 */
export function getSupportedTiers(spec: LLMModelSpec): readonly VertexTier[] {
  return getModel(spec).supportedTiers ?? DEFAULT_SUPPORTED_TIERS;
}

/**
 * 检查 Model Key 是否已注册（严格匹配，不接受带参数的 spec）
 */
export function isModelRegistered(key: string): key is LLMModelKey {
  return modelRegistry.has(key);
}

/**
 * 检查 Model Spec 是否有效（支持 `provider:model?param=value` 格式）
 */
export function isModelSpecValid(spec: string): spec is LLMModelSpec {
  const qIdx = spec.indexOf('?');
  const baseKey = qIdx === -1 ? spec : spec.slice(0, qIdx);
  if (!modelRegistry.has(baseKey)) return false;
  if (qIdx === -1) return true;
  return findRemovedModelSpecParam(new URLSearchParams(spec.slice(qIdx + 1))) === undefined;
}

/**
 * 获取所有已注册的 Model Keys
 */
export function getRegisteredModels(): string[] {
  return Array.from(modelRegistry.keys());
}

/**
 * 获取指定 Provider 的所有 Model Keys
 */
export function getModelsByProvider(provider: LLMProviderType): string[] {
  return Array.from(modelRegistry.entries())
    .filter(([, config]) => config.provider === provider)
    .map(([key]) => key);
}

// ==================== Provider 配置验证 ====================

/**
 * Provider 到环境变量的映射
 */
interface ProviderConfigRequirement {
  envVar: string;
  configured: () => boolean;
}

/** Provider → canonical configuration requirement mapping. */
const providerConfigRequirements: Partial<Record<string, ProviderConfigRequirement>> = {
  openrouter: {
    envVar: 'AI_OPENROUTER_API_KEY',
    configured: () => !!SysEnv.AI_OPENROUTER_API_KEY,
  },
  google: {
    envVar: 'AI_GOOGLE_API_KEY',
    configured: () => !!SysEnv.AI_GOOGLE_API_KEY,
  },
  vertex: {
    envVar: 'AI_GOOGLE_VERTEX_API_KEY',
    configured: () => !!SysEnv.AI_GOOGLE_VERTEX_API_KEY,
  },
  'vertex-global': {
    envVar: 'GOOGLE_VERTEX_PROJECT',
    configured: () => !!SysEnv.GOOGLE_VERTEX_PROJECT,
  },
  bedrock: {
    // 认证优先级：AI_BEDROCK_API_KEY > AWS_BEARER_TOKEN_BEDROCK > SigV4 静态凭证（与 @ai-sdk/amazon-bedrock 一致）
    envVar: 'AI_BEDROCK_API_KEY',
    configured: () =>
      !!SysEnv.AI_BEDROCK_API_KEY ||
      !!process.env.AWS_BEARER_TOKEN_BEDROCK ||
      (!!process.env.AWS_ACCESS_KEY_ID && !!process.env.AWS_SECRET_ACCESS_KEY),
  },
  openai: {
    envVar: 'AI_OPENAI_API_KEY',
    configured: () => !!SysEnv.AI_OPENAI_API_KEY,
  },
};

/**
 * 检查 Provider 是否已配置 canonical credential/configuration field
 */
export function isProviderConfigured(provider: string): boolean {
  return providerConfigRequirements[provider]?.configured() ?? false;
}

/**
 * 获取 Provider 配置状态
 */
export function getProviderStatus(): Record<string, { configured: boolean; envVar: string }> {
  return Object.entries(providerConfigRequirements).reduce<Record<string, { configured: boolean; envVar: string }>>(
    (acc, [provider, requirement]) => {
      if (!requirement) return acc;
      acc[provider] = {
        configured: requirement.configured(),
        envVar: requirement.envVar,
      };
      return acc;
    },
    {},
  );
}

export interface LLMConfigurationValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * 验证单个 Model Key
 */
export function validateModelKey(modelKey: string): { valid: boolean; error?: string } {
  // 检查 Model 是否已注册（支持 spec 格式）
  if (!isModelSpecValid(modelKey)) {
    return {
      valid: false,
      error: `Model "${modelKey}" is not registered. Available: ${getRegisteredModels().join(', ')}`,
    };
  }

  // 检查 Provider 是否配置了 API Key（strip query string）
  const qIdx = modelKey.indexOf('?');
  const baseKey = qIdx === -1 ? modelKey : modelKey.slice(0, qIdx);
  const config = modelRegistry.get(baseKey);
  if (config) {
    const provider = config.provider;
    if (!isProviderConfigured(provider)) {
      const requirement = providerConfigRequirements[provider];
      return {
        valid: false,
        error: `Provider "${provider}" for model "${modelKey}" is not configured. Set ${requirement?.envVar ?? provider}.`,
      };
    }
  }

  return { valid: true };
}

// ==================== Model Spec Validation (reasoning policy) ====================

export type ModelSpecIssueCode =
  | 'UNKNOWN_MODEL'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'REASONING_DISABLE_FORBIDDEN'
  | 'REASONING_EFFORT_UNSUPPORTED'
  | 'REMOVED_PARAM';

export interface ModelSpecIssue {
  code: ModelSpecIssueCode;
  message: string;
  /** Advisory alternate specs (registered keys / key?reason=); not auto-applied */
  suggestions?: string[];
}

export type ModelSpecValidation =
  | { ok: true; parsed: ParsedModelSpec; warnings: ModelSpecIssue[]; effectiveThinking: ThinkingEffortLevel }
  | { ok: false; issues: ModelSpecIssue[] };

const DEFAULT_MANDATORY_REASONING_EFFORT: Exclude<ThinkingEffortLevel, 'none'> = 'low';

/**
 * Whether this model forbids disabling reasoning (gateway/model contract).
 */
export function isReasoningMandatory(key: LLMModelKey): boolean {
  return getModel(key).reasoningRequired === true;
}

/**
 * Whether this model end-to-end accepts system entries inside messages (default true).
 * libs 调用 AI SDK 时据此透传 `allowSystemInMessages`；仅实测/线上 400 证明
 * 后端不接受的模型在 registry 单独标 `systemInMessages: false`。
 */
export function allowsSystemInMessages(key: LLMModelKey): boolean {
  return getModel(key).systemInMessages !== false;
}

/**
 * Resolve caller thinking intent against the per-key runtime fallback policy.
 *
 * `reasoningRequired` is capability truth and defaults its fallback to low.
 * `reasoningDefaultEffort` may also be set alone for a conservative route policy whose
 * disable capability is not yet proven. A fallback alone must not be interpreted as
 * evidence that reasoning is mandatory.
 */
export function resolveThinkingForModel(
  key: LLMModelKey,
  requested: ThinkingEffortLevel,
): { thinking: ThinkingEffortLevel; paramFallbackApplied: boolean } {
  if (requested !== 'none') {
    return { thinking: requested, paramFallbackApplied: false };
  }
  const config = getModel(key);
  const effort =
    config.reasoningDefaultEffort ?? (config.reasoningRequired ? DEFAULT_MANDATORY_REASONING_EFFORT : undefined);
  if (effort === undefined) {
    return { thinking: 'none', paramFallbackApplied: false };
  }
  return { thinking: effort, paramFallbackApplied: true };
}

function buildParamFallbackSuggestion(key: LLMModelKey): string {
  const effort = getModel(key).reasoningDefaultEffort ?? DEFAULT_MANDATORY_REASONING_EFFORT;
  return `${key}?reason=${effort}`;
}

/**
 * Typed validation of an LLMModelSpec + optional thinking intent.
 *
 * - Configuration validation: pass `{ thinking: 'none' }` (framework default) to catch
 *   mandatory-reasoning models that cannot disable thinking.
 * - Does not auto-switch providers; `suggestions` are advisory only.
 * - When disable is forbidden, `ok` is still true if the model is registered and provider
 *   configured — with a REASONING_DISABLE_FORBIDDEN **warning** and `effectiveThinking`
 *   after param-level fallback (runtime will use that effort).
 */
export function validateModelSpec(spec: string, options?: { thinking?: ThinkingEffortLevel }): ModelSpecValidation {
  if (!isModelSpecValid(spec)) {
    return {
      ok: false,
      issues: [
        {
          code: 'UNKNOWN_MODEL',
          message: `Model "${spec}" is not registered. Available: ${getRegisteredModels().join(', ')}`,
        },
      ],
    };
  }

  const parsed = parseModelSpec(spec);
  const warnings: ModelSpecIssue[] = [];

  // Typo / unknown reason= value: report before treating as omitted (runtime still ignores)
  if (parsed.invalidReason !== undefined) {
    warnings.push({
      code: 'REASONING_EFFORT_UNSUPPORTED',
      message:
        `Invalid reason "${parsed.invalidReason}" in "${spec}". ` +
        `Valid: ${[...VALID_THINKING_EFFORTS].join(', ')}. Treated as omitted at runtime.`,
    });
  }

  const requested: ThinkingEffortLevel = options?.thinking ?? parsed.thinking ?? 'none';
  const { thinking: effectiveThinking, paramFallbackApplied } = resolveThinkingForModel(parsed.key, requested);

  // Skip disable warning when the root cause was an invalid reason= typo (not an intentional none)
  if (paramFallbackApplied && isReasoningMandatory(parsed.key) && parsed.invalidReason === undefined) {
    const suggestion = buildParamFallbackSuggestion(parsed.key);
    warnings.push({
      code: 'REASONING_DISABLE_FORBIDDEN',
      message:
        `Model "${parsed.key}" requires reasoning and cannot use thinking=none / effort:none; ` +
        `param-fallback to reason=${effectiveThinking}. ` +
        `If the call still fails with 400, configure ?fallback=… for provider fallback.`,
      suggestions: [suggestion],
    });
  }

  if (requested !== 'none' && requested !== effectiveThinking && !paramFallbackApplied) {
    warnings.push({
      code: 'REASONING_EFFORT_UNSUPPORTED',
      message: `Thinking effort "${requested}" adjusted to "${effectiveThinking}" for "${parsed.key}".`,
    });
  }

  // Provider credentials after policy checks so CI without keys still exercises reasoning warnings
  if (!isProviderConfigured(parsed.provider)) {
    const requirement = providerConfigRequirements[parsed.provider];
    return {
      ok: false,
      issues: [
        ...warnings,
        {
          code: 'PROVIDER_NOT_CONFIGURED',
          message: `Provider "${parsed.provider}" for model "${spec}" is not configured. Set ${requirement?.envVar ?? parsed.provider}.`,
        },
      ],
    };
  }

  return { ok: true, parsed, warnings, effectiveThinking };
}

/**
 * 验证 LLM 配置
 *
 * 自动验证所有标记了 @LLMModelField() 装饰器的配置字段：
 * 1. Model 是否已注册
 * 2. 对应 Provider 的 API Key 是否已配置
 *
 * @example
 * // 在 bootstrap 中调用
 * const result = validateLLMConfiguration();
 * if (!result.valid) {
 *   throw new Error(`LLM configuration invalid: ${result.errors.join(', ')}`);
 * }
 * result.warnings.forEach(w => logger.warn(w));
 */
export function validateLLMConfiguration(): LLMConfigurationValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 获取所有标记了 @LLMModelField() 的字段
  const llmModelFields = getLLMModelFields();
  const envValues = SysEnv as unknown as Record<string, string | undefined>;

  // 如果没有任何 LLM model 字段，跳过验证
  if (llmModelFields.length === 0) {
    return { valid: true, errors, warnings };
  }

  // 验证每个配置的 model
  for (const fieldName of llmModelFields) {
    const modelKey = envValues[fieldName];

    // 跳过未配置的字段
    if (!modelKey) {
      continue;
    }

    const result = validateModelKey(modelKey);
    if (!result.valid && result.error) {
      errors.push(`[${fieldName}] ${result.error}`);
    }
  }

  // 可选：检查其他已注册模型的 Provider 状态（作为警告）
  const providerStatus = getProviderStatus();
  const unconfiguredProviders = Object.entries(providerStatus)
    .filter(([, status]) => !status.configured)
    .map(([provider, status]) => `${provider} (${status.envVar})`);

  if (unconfiguredProviders.length > 0) {
    warnings.push(`Unconfigured providers: ${unconfiguredProviders.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
