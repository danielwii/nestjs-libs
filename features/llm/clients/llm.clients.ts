/**
 * 预配置 LLM 客户端单例
 *
 * 设计意图：
 * - 零配置使用，apiKey 和 proxy 全部从 SysEnv 读取
 * - 懒加载，首次使用时才初始化
 * - 直接导出可用的 provider 函数
 *
 * ## 模型选型指南（2026-01）
 *
 * | 场景 | 推荐模型 | 理由 |
 * |------|---------|------|
 * | generateObject 批量输出 | `google('gemini-2.5-flash')` | 原生支持 structured output，thinking tokens 免费 |
 * | 多轮工具编排 | `openrouter('x-ai/grok-4.1-fast')` | 性价比高 $0.20/$0.50/M，2M ctx，tool calling 准确 |
 * | 复杂推理 | `openrouter('google/gemini-3.7-flash')` | 强制 reasoning，标价低于旧 Pro 线 |
 * | 大上下文 | `openrouter('x-ai/grok-4.1-fast')` | 2M context window |
 *
 * ## Provider 选择：bedrock vs openrouter
 *
 * 同一模型家族（Claude/Kimi/DeepSeek/MiniMax）两边都有时的取舍：
 * - `bedrock:*`：企业合规/数据驻留（流量不进第三方代理）、AWS 账单整合、serviceTier 分层
 * - `openrouter:*`：模型更全、无需 AWS 凭证、定价透明
 *
 * ## 价格参考（2026-01）
 *
 * | 模型 | Input | Output | 备注 |
 * |------|-------|--------|------|
 * | gemini-2.5-flash | $0.15/M | $0.60/M | thinking tokens 免费 |
 * | gemini-3.7-flash | $0.375/M | $1.875/M | OpenRouter；reasoning 强制 |
 * | grok-4.1-fast | $0.20/M | $0.50/M | 2M ctx，性价比之选 |
 * | claude-4-sonnet | $3/M | $15/M | 编码/Agent 能力强 |
 *
 * @example
 * ```typescript
 * import { openrouter, google } from '@app/llm-core';
 * import { streamText, generateObject } from 'ai';
 *
 * // 直接使用，无需任何配置
 * await streamText({
 *   model: openrouter('google/gemini-2.5-flash'),
 *   messages: [...],
 * });
 *
 * await generateObject({
 *   model: google('gemini-2.5-flash'),
 *   schema: MySchema,
 *   messages: [...],
 * });
 * ```
 */

import { SysEnv } from '@app/env';
import { Oops } from '@app/nest/exceptions/oops';
import { getAppLogger } from '@app/utils/app-logger';
import { ApiFetcher } from '@app/utils/fetch';

import { createVertexFetch } from './vertex.fetch';

import { createRequire } from 'node:module';

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createVertex } from '@ai-sdk/google-vertex';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

// type-only：编译期即被擦除，不会触发运行时模块解析（optional peer 惰性加载见下方 loadBedrockFactory）
import type { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import type { LanguageModel } from 'ai';

// ============================================================================
// 单例缓存
// ============================================================================

let _openrouter: ReturnType<typeof createOpenRouter> | null = null;
let _google: ReturnType<typeof createGoogleGenerativeAI> | null = null;
let _vertex: ReturnType<typeof createVertex> | null = null;
let _vertexGlobal: ReturnType<typeof createVertex> | null = null;
let _openai: ReturnType<typeof createOpenAI> | null = null;
let _bedrock: ReturnType<typeof createAmazonBedrock> | null = null;

// ============================================================================
// Optional peer 惰性加载
// ============================================================================

/**
 * `@ai-sdk/amazon-bedrock` 是 optional peer 且 ESM-only。
 * 静态 import 会让未安装该包的既有使用者在加载本模块时就 ERR_MODULE_NOT_FOUND，
 * 因此改为首次使用 bedrock 时才经 require(esm) 同步加载（Node ≥22.12 / bun 均支持）。
 */
let _createAmazonBedrock: typeof createAmazonBedrock | null = null;

function loadBedrockFactory(): typeof createAmazonBedrock {
  if (!_createAmazonBedrock) {
    try {
      const req = createRequire(import.meta.url);
      const mod = req('@ai-sdk/amazon-bedrock') as { createAmazonBedrock: typeof createAmazonBedrock };
      _createAmazonBedrock = mod.createAmazonBedrock;
    } catch {
      throw Oops.Panic.Config(
        'bedrock:* models require the optional peer "@ai-sdk/amazon-bedrock". Install it first (e.g. bun add @ai-sdk/amazon-bedrock).',
      );
    }
  }
  return _createAmazonBedrock;
}

const clientLogger = getAppLogger('features', 'LLM', 'clients');

/**
 * Bedrock 凭证缺失时的场景化提示。
 *
 * credential chain（IRSA/ECS instance role、AWS CLI profile）目前未接线
 * （spec 明确 defer：`@aws-sdk/credential-providers` 为额外依赖），
 * 检测到这些环境时给出针对性指引而不是泛泛的“未配置”。
 */
function bedrockCredentialHint(): string {
  if (
    process.env.AWS_WEB_IDENTITY_TOKEN_FILE ??
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ??
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI
  ) {
    return ' IAM role credentials detected (IRSA/ECS/EC2); credential chain support via @aws-sdk/credential-providers is intentionally not wired yet — use AI_BEDROCK_API_KEY or static SigV4 env keys for now.';
  }
  if (process.env.AWS_PROFILE) {
    return ' AWS_PROFILE is set but the provider does not resolve CLI profiles; export static credentials (aws configure export-credentials --format env) or set AI_BEDROCK_API_KEY.';
  }
  return '';
}

// ============================================================================
// OpenRouter 客户端
// ============================================================================

/**
 * 获取 OpenRouter 客户端单例
 *
 * 自动使用：
 * - SysEnv.AI_OPENROUTER_API_KEY
 * - ApiFetcher.fetch（带代理）
 */
export function getOpenRouter() {
  if (!_openrouter) {
    const apiKey = SysEnv.AI_OPENROUTER_API_KEY;
    if (!apiKey) {
      throw Oops.Panic.Config('AI_OPENROUTER_API_KEY is not configured');
    }
    _openrouter = createOpenRouter({
      apiKey,
      fetch: ApiFetcher.fetch,
    });
  }
  return _openrouter;
}

/**
 * OpenRouter 模型选择器
 *
 * @example
 * ```typescript
 * openrouter('google/gemini-2.5-flash')
 * openrouter('anthropic/claude-sonnet-4.5')
 * openrouter('x-ai/grok-4.1-fast')
 * ```
 */
export const openrouter = (modelId: string): LanguageModel => getOpenRouter()(modelId);

// ============================================================================
// Google AI 客户端
// ============================================================================

/**
 * 获取 Google AI 客户端单例
 *
 * 自动使用：
 * - SysEnv.AI_GOOGLE_API_KEY
 * - ApiFetcher.fetch（带代理）
 */
function getGoogle() {
  if (!_google) {
    const apiKey = SysEnv.AI_GOOGLE_API_KEY;
    if (!apiKey) {
      throw Oops.Panic.Config('AI_GOOGLE_API_KEY is not configured');
    }
    _google = createGoogleGenerativeAI({
      apiKey,
      fetch: ApiFetcher.fetch,
    });
  }
  return _google;
}

/**
 * Google AI 模型选择器
 *
 * @example
 * ```typescript
 * google('gemini-2.5-flash')
 * google('gemini-2.5-flash-thinking')
 * ```
 */
export const google = (modelId: string): LanguageModel => getGoogle()(modelId);

/**
 * 获取 Google AI Provider 实例（含 tools）
 *
 * 用于需要 provider-defined tools 的场景，如 Google Search Grounding：
 *
 * @example
 * ```typescript
 * import { getGoogleProvider } from '@app/features/llm/clients';
 *
 * const google = getGoogleProvider();
 * const tools = { googleSearch: google.tools.googleSearch({}) };
 * ```
 */
export function getGoogleProvider() {
  return getGoogle();
}

// ============================================================================
// Vertex AI 客户端 (Express Mode)
// ============================================================================

/**
 * 获取 Vertex AI 客户端单例 (Express Mode)
 *
 * 自动使用：
 * - SysEnv.AI_GOOGLE_VERTEX_API_KEY
 * - Express Mode（无需 project/location）
 */
function getVertex() {
  if (!_vertex) {
    const apiKey = SysEnv.AI_GOOGLE_VERTEX_API_KEY;
    if (!apiKey) {
      throw Oops.Panic.Config('AI_GOOGLE_VERTEX_API_KEY is not configured');
    }
    clientLogger.info`[vertex:init] mode=express, auth=api-key, baseURL=default-express, project=none, location=none`;
    _vertex = createVertex({
      apiKey,
      fetch: createVertexFetch(ApiFetcher.fetch),
    });
  }
  return _vertex;
}

/**
 * Vertex AI 模型选择器 (Express Mode)
 *
 * @example
 * ```typescript
 * vertex('gemini-2.5-flash')
 * vertex('gemini-3.6-flash')
 * ```
 */
export const vertex = (modelId: string): LanguageModel => getVertex()(modelId);

// ============================================================================
// Vertex AI 客户端 (project/global mode)
// ============================================================================

function getVertexGlobalProject(): string {
  const project = SysEnv.GOOGLE_VERTEX_PROJECT;
  if (!project) {
    throw Oops.Panic.Config('GOOGLE_VERTEX_PROJECT is not configured for vertex-global provider');
  }
  return project;
}

function getVertexGlobalLocation(): 'global' {
  const location = SysEnv.GOOGLE_VERTEX_LOCATION ?? 'global';
  if (location !== 'global') {
    throw Oops.Panic.Config(`vertex-global provider requires GOOGLE_VERTEX_LOCATION=global, got "${location}"`);
  }
  return 'global';
}

/**
 * 获取 Vertex AI project/global 客户端单例
 *
 * 用于 Google Priority PayGo 官方路径：
 * /v1/projects/{project}/locations/global/publishers/google/models/...
 *
 * 注意：
 * - URL 固定为 project/global，不使用 Express Mode URL
 * - 有 Vertex API key 时使用 x-goog-api-key
 * - 没有 API key 时由 ADC / service account / Workload Identity 提供 OAuth
 * - 真实是否命中 Priority/Flex PayGo 以响应 usage.raw.trafficType 为准
 */
function getVertexGlobal() {
  if (!_vertexGlobal) {
    const project = getVertexGlobalProject();
    const location = getVertexGlobalLocation();
    const encodedProject = encodeURIComponent(project);
    const apiKey = SysEnv.AI_GOOGLE_VERTEX_API_KEY;
    const auth = apiKey ? 'api-key' : 'adc-or-service-account';
    const baseURL = `https://aiplatform.googleapis.com/v1/projects/${encodedProject}/locations/${location}/publishers/google`;

    clientLogger.info`[vertex-global:init] mode=project-global, project=${project}, location=${location}, auth=${auth}, baseURL=${baseURL}`;

    _vertexGlobal = createVertex({
      apiKey,
      project,
      location,
      baseURL,
      fetch: createVertexFetch(ApiFetcher.fetch),
    });
  }
  return _vertexGlobal;
}

/**
 * Vertex AI 模型选择器 (project/global mode)
 *
 * @example
 * ```typescript
 * vertexGlobal('gemini-2.5-flash')
 * ```
 */
export const vertexGlobal = (modelId: string): LanguageModel => getVertexGlobal()(modelId);

// ============================================================================
// AWS Bedrock 客户端
// ============================================================================

/**
 * 获取 AWS Bedrock 客户端单例
 *
 * 认证优先级（与 @ai-sdk/amazon-bedrock 一致）：
 * 1. SysEnv.AI_BEDROCK_API_KEY（Bearer API key）
 * 2. AWS_BEARER_TOKEN_BEDROCK 环境变量（provider 自身 fallback）
 * 3. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY（SigV4）
 *
 * 注意：provider 的 env fallback 只读 process env，不解析 AWS CLI profile；
 * 本地用 `aws configure export-credentials --profile <name> --format env` 导出。
 *
 * Region 优先级：SysEnv.AI_BEDROCK_REGION > AWS_REGION > us-east-1；
 * `us.*` inference profile（Claude 全系）需美国区域端点。
 */
function getBedrock() {
  if (!_bedrock) {
    const apiKey = SysEnv.AI_BEDROCK_API_KEY;
    const hasBearerToken = !!process.env.AWS_BEARER_TOKEN_BEDROCK;
    const hasSigV4 = !!process.env.AWS_ACCESS_KEY_ID && !!process.env.AWS_SECRET_ACCESS_KEY;
    if (!apiKey && !hasBearerToken && !hasSigV4) {
      throw Oops.Panic.Config(
        `AWS Bedrock credentials are not configured. Set AI_BEDROCK_API_KEY, AWS_BEARER_TOKEN_BEDROCK, or AWS_ACCESS_KEY_ID+AWS_SECRET_ACCESS_KEY.${bedrockCredentialHint()}`,
      );
    }
    const region = SysEnv.AI_BEDROCK_REGION ?? process.env.AWS_REGION ?? 'us-east-1';
    const auth = apiKey ? 'api-key' : hasBearerToken ? 'aws-bearer-token-env' : 'aws-sigv4-env';
    clientLogger.info`[bedrock:init] region=${region}, auth=${auth}, baseURL=default`;
    _bedrock = loadBedrockFactory()({
      ...(apiKey ? { apiKey } : {}),
      region,
      fetch: ApiFetcher.fetch,
    });
  }
  return _bedrock;
}

/**
 * AWS Bedrock 模型选择器
 *
 * @example
 * ```typescript
 * bedrock('us.anthropic.claude-sonnet-4-5-20250929-v1:0')
 * bedrock('moonshotai.kimi-k2.5')
 * ```
 */
export const bedrock = (modelId: string): LanguageModel => getBedrock()(modelId);

/**
 * 获取 Bedrock Provider 实例（含 provider-defined tools）
 */
export function getBedrockProvider() {
  return getBedrock();
}

// ============================================================================
// 客户端状态检查
// ============================================================================

/**
 * 检查 LLM 客户端配置状态
 */
export function getLLMClientStatus() {
  return {
    openrouter: {
      configured: !!SysEnv.AI_OPENROUTER_API_KEY,
      initialized: !!_openrouter,
    },
    google: {
      configured: !!SysEnv.AI_GOOGLE_API_KEY,
      initialized: !!_google,
    },
    vertex: {
      configured: !!SysEnv.AI_GOOGLE_VERTEX_API_KEY,
      initialized: !!_vertex,
    },
    vertexGlobal: {
      configured: !!SysEnv.GOOGLE_VERTEX_PROJECT,
      initialized: !!_vertexGlobal,
    },
    bedrock: {
      configured:
        !!SysEnv.AI_BEDROCK_API_KEY ||
        !!process.env.AWS_BEARER_TOKEN_BEDROCK ||
        (!!process.env.AWS_ACCESS_KEY_ID && !!process.env.AWS_SECRET_ACCESS_KEY),
      initialized: !!_bedrock,
    },

    proxy: {
      enabled: SysEnv.APP_PROXY_ENABLED ?? false,
      host: SysEnv.APP_PROXY_ENABLED ? `${SysEnv.APP_PROXY_HOST}:${SysEnv.APP_PROXY_PORT}` : null,
    },
  };
}

/**
 * 重置客户端（测试用）
 */
export function resetLLMClients() {
  _openrouter = null;
  _google = null;
  _vertex = null;
  _vertexGlobal = null;
  _openai = null;
  _bedrock = null;
}

// ============================================================================
// OpenAI 客户端（用于 Embedding）
// ============================================================================

/**
 * 获取 OpenAI 客户端单例
 *
 * 自动使用：
 * - SysEnv.AI_OPENAI_API_KEY
 * - ApiFetcher.fetch（带代理）
 */
export function getOpenAI() {
  if (!_openai) {
    const apiKey = SysEnv.AI_OPENAI_API_KEY;
    if (!apiKey) {
      throw Oops.Panic.Config('AI_OPENAI_API_KEY is not configured');
    }
    _openai = createOpenAI({
      apiKey,
      fetch: ApiFetcher.fetch,
    });
  }
  return _openai;
}
