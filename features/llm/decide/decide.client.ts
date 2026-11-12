/**
 * Polymorphic `LLM.decide` / `LLM.safeDecide` Execution Engine
 *
 * Compiles unified `DecideParams<M, Q>` into provider-native wire requests for:
 * - TypeSafe Jev (`POST https://api.typesafe.ai/v1/systemone`)
 * - Google Gemini Decision 1 (`POST https://generativelanguage.googleapis.com/v1beta/decisions`)
 * - OpenAI Decisions API (`POST https://api.openai.com/v1/decisions`)
 *
 * Normalizes responses into isomorphic `DecideResult<Q>` with `TokenUsage` and USD `cost`.
 */

import { SysEnv } from '@app/env';
import { Oops } from '@app/nest/exceptions/oops';
import { ApiFetcher } from '@app/utils/fetch';

import { getTypeSafeApiKey } from '../../typesafe/api-key';
import { getCostFromUsage } from '../utils/cost-calculator';
import { DECISION_PART_BRAND } from './d';
import { createDecisionSafetyBlockError, DecideHttpError, resolveDecisionProvider } from './decide.errors';

import type { TokenUsage } from '../clients/llm.class';
import type {
  BoundingBox,
  BoxAnswer,
  ChoiceAnswer,
  ChoiceCriterionValue,
  DecideAnswers,
  DecideParams,
  DecideResult,
  DecisionAnswer,
  DecisionInput,
  DecisionInputPart,
  DecisionModelKey,
  DecisionProvider,
  DecisionQuestionFor,
  DecisionQuestions,
  GoogleDecisionProviderOptions,
  NoulAnswer,
  NoulQuestion,
  OpenAIDecisionProviderOptions,
  ScoreAnswer,
  TypeSafeProviderOptions,
} from './decide.types';
import type { DataContent } from '@ai-sdk/provider-utils';

const DEFAULT_TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_GOOGLE_URL = 'https://generativelanguage.googleapis.com/v1beta/decisions';
const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1/decisions';

export type DecideFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

let testFetcher: DecideFetcher | null = null;

/**
 * Hermetic test seam for overriding the underlying HTTP fetcher in unit tests.
 */
export function setDecideFetcherForTest(fetcher: DecideFetcher | null): void {
  testFetcher = fetcher;
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared Normalization & Compilation Helpers
// ═══════════════════════════════════════════════════════════════════════════

const ALLOWED_TEXT_PART_KEYS = new Set(['type', 'text', 'providerOptions']);
const ALLOWED_FILE_PART_KEYS = new Set([
  'type',
  'mediaType',
  'data',
  'filename',
  'fileUri',
  'key',
  'resolution',
  'providerOptions',
]);

function isSingleDecisionInputPart(item: unknown): boolean {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return false;
  }
  if ((item as Record<symbol, unknown>)[DECISION_PART_BRAND] === true) {
    return true;
  }
  const record = item as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.type === 'text') {
    return typeof record.text === 'string' && keys.every((k) => ALLOWED_TEXT_PART_KEYS.has(k));
  }
  if (record.type === 'file') {
    return (
      typeof record.mediaType === 'string' &&
      (('data' in record && record.data !== undefined) || typeof record.fileUri === 'string') &&
      keys.every((k) => ALLOWED_FILE_PART_KEYS.has(k))
    );
  }
  return false;
}

function isDecisionInputPartArray<M extends DecisionModelKey>(
  input: DecisionInput<M>,
): input is readonly DecisionInputPart<M>[] {
  return Array.isArray(input) && input.length > 0 && input.every(isSingleDecisionInputPart);
}

function toBase64(data: DataContent): string {
  if (typeof data === 'string') {
    if (data.startsWith('data:')) {
      const commaIndex = data.indexOf(',');
      return commaIndex >= 0 ? data.slice(commaIndex + 1) : data;
    }
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('base64');
  }
  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('base64');
  }
  throw Oops.Validation('Unsupported binary DataContent format');
}

function toDataUrl(data: DataContent, mediaType: string): string {
  if (typeof data === 'string') {
    if (data.startsWith('data:') || data.startsWith('http://') || data.startsWith('https://')) {
      return data;
    }
    return `data:${mediaType};base64,${data}`;
  }
  return `data:${mediaType};base64,${toBase64(data)}`;
}

function compileNoulInstructions(question: NoulQuestion): string {
  if (!question.criteria || (!question.criteria.yes && !question.criteria.no)) {
    return question.instructions;
  }
  const lines = [question.instructions];
  if (question.criteria.yes) {
    lines.push(`Criteria for YES (true): ${question.criteria.yes}`);
  }
  if (question.criteria.no) {
    lines.push(`Criteria for NO (false): ${question.criteria.no}`);
  }
  return lines.join('\n');
}

function compileChoiceCriterionString(value: ChoiceCriterionValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  const parts: string[] = [];
  if (value.description) parts.push(value.description);
  if (value.notFor) parts.push(`Not for: ${value.notFor}`);
  if (value.examples && value.examples.length > 0) {
    parts.push(`Examples: ${value.examples.join('; ')}`);
  }
  return parts.join(' | ');
}

function computeChoiceAnswer<K extends string>(
  choiceKey: K,
  probabilities: Readonly<Record<K, number>>,
): ChoiceAnswer<K> {
  const entries = Object.entries(probabilities) as Array<[K, number]>;
  const sortedProbs = entries.map(([, p]) => p).sort((a, b) => b - a);
  const topProbability = probabilities[choiceKey];
  const runnerUpProbability = sortedProbs[1] ?? 0;
  const margin = Number(Math.max(0, topProbability - runnerUpProbability).toFixed(12));

  return {
    type: 'choice',
    choice: choiceKey,
    probabilities,
    topProbability,
    margin,
  };
}

function computeScoreAnswer(score: number, probabilities: readonly number[]): ScoreAnswer {
  const k = probabilities.length;
  const normalizedScore = k > 1 ? Number((score / (k - 1)).toFixed(12)) : 0;
  return {
    type: 'score',
    score,
    normalizedScore,
    probabilities,
  };
}

function normalizeScoreProbabilities(
  provider: DecisionProvider,
  questionKey: string,
  rawProbabilities: unknown,
  expectedLength: number,
): readonly number[] {
  if (Array.isArray(rawProbabilities)) {
    if (
      rawProbabilities.length === expectedLength &&
      rawProbabilities.every((item): item is number => typeof item === 'number' && Number.isFinite(item))
    ) {
      return rawProbabilities;
    }
    const ordered = new Array<number | undefined>(expectedLength).fill(undefined);
    for (const item of rawProbabilities) {
      if (item && typeof item === 'object') {
        const entry = item as { value?: unknown; label?: unknown; probability?: unknown };
        const idx =
          typeof entry.value === 'number'
            ? entry.value
            : typeof entry.label === 'string'
              ? Number.parseInt(entry.label, 10)
              : Number.NaN;
        if (
          Number.isInteger(idx) &&
          idx >= 0 &&
          idx < expectedLength &&
          typeof entry.probability === 'number' &&
          Number.isFinite(entry.probability)
        ) {
          ordered[idx] = entry.probability;
        }
      }
    }
    if (ordered.every((val): val is number => typeof val === 'number' && Number.isFinite(val))) {
      return ordered;
    }
    throw Oops.Panic.ExternalService(
      provider,
      `Malformed score probabilities for question "${questionKey}": expected ${expectedLength} finite numeric levels`,
    );
  }

  if (rawProbabilities && typeof rawProbabilities === 'object') {
    const record = rawProbabilities as Record<string, unknown>;
    const ordered = new Array<number>(expectedLength);
    for (let i = 0; i < expectedLength; i++) {
      const val = record[String(i)];
      if (typeof val !== 'number' || !Number.isFinite(val)) {
        throw Oops.Panic.ExternalService(
          provider,
          `Malformed score probabilities for question "${questionKey}": missing finite numeric level "${i}"`,
        );
      }
      ordered[i] = val;
    }
    return ordered;
  }

  throw Oops.Panic.ExternalService(
    provider,
    `Malformed score answer for question "${questionKey}": missing probabilities distribution`,
  );
}

function buildTokenUsage(modelKey: DecisionModelKey, inputTokens: number, cachedInputTokens = 0): TokenUsage {
  const totalInput = Math.max(0, inputTokens);
  const cachedRead = Math.min(Math.max(0, cachedInputTokens), totalInput);
  const noCacheTokens = Math.max(0, totalInput - cachedRead);

  const partialUsage = {
    inputTokens: totalInput,
    outputTokens: 0,
    inputTokenDetails: {
      noCacheTokens,
      cacheReadTokens: cachedRead,
      cacheWriteTokens: 0,
    },
  };

  const cost = getCostFromUsage(partialUsage, modelKey);

  return {
    inputTokens: totalInput,
    outputTokens: 0,
    totalTokens: totalInput,
    inputTokenDetails: {
      noCacheTokens,
      cacheReadTokens: cachedRead,
      cacheWriteTokens: 0,
    },
    ...(cost !== null ? { cost } : {}),
  };
}

async function postDecisionRequest<TResponse>(
  provider: 'typesafe' | 'google' | 'openai',
  modelKey: DecisionModelKey,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<TResponse> {
  const fetcher = testFetcher ?? ApiFetcher.fetch;
  const response = await fetcher(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    let parsedBody: unknown;
    try {
      const text = await response.text();
      try {
        parsedBody = JSON.parse(text);
      } catch {
        parsedBody = text;
      }
    } catch {
      parsedBody = null;
    }

    throw new DecideHttpError(
      provider,
      modelKey,
      response.status,
      parsedBody,
      `${provider} Decision API failed with status ${response.status}`,
    );
  }

  return (await response.json()) as TResponse;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. TypeSafe Jev Adapter (`/v1/systemone`)
// ═══════════════════════════════════════════════════════════════════════════

interface TypeSafeWireResponse {
  model?: string;
  answers?: Record<string, Record<string, unknown>>;
  usage?: {
    input_tokens?: number;
  };
}

async function executeTypeSafeDecide<M extends DecisionModelKey, Q extends DecisionQuestions<M>>(
  params: DecideParams<M, Q>,
  signal?: AbortSignal,
): Promise<DecideResult<Q>> {
  const tsOptions = (params.providerOptions as { typesafe?: TypeSafeProviderOptions } | undefined)?.typesafe;
  const explicitKey = tsOptions?.apiKey?.trim();
  const apiKey = explicitKey && explicitKey.length > 0 ? explicitKey : getTypeSafeApiKey();
  const url = tsOptions?.baseUrl ?? DEFAULT_TYPESAFE_URL;
  const modelId = params.model.slice('typesafe:'.length);

  let state: unknown;
  const assets: Record<string, string> = {};

  if (typeof params.input === 'string') {
    state = params.input;
  } else if (isDecisionInputPartArray(params.input)) {
    const textChunks: string[] = [];
    const autoAssetTags: string[] = [];
    let imageIdx = 0;

    for (const part of params.input) {
      if (part.type === 'text') {
        textChunks.push(part.text);
      } else {
        if ('fileUri' in part) {
          throw Oops.Validation('TypeSafe Jev does not support fileUri parts; use inline D.image()');
        }
        const assetKey = part.key ?? `image_${imageIdx++}`;
        assets[assetKey] = toDataUrl(part.data, part.mediaType);
        autoAssetTags.push(`<asset:${assetKey}>`);
      }
    }

    const joinedText = textChunks.join('\n');
    const missingTags = autoAssetTags.filter((tag) => !joinedText.includes(tag));
    state = [joinedText, ...missingTags].filter((s) => s.length > 0).join('\n');
  } else {
    state = params.input;
  }

  const wireQuestions: Record<string, unknown> = {};
  for (const [key, q] of Object.entries(params.questions)) {
    if (q.type === 'noul') {
      wireQuestions[key] = {
        type: 'noul',
        instructions: q.instructions,
        ...(q.criteria
          ? {
              criteria: {
                true: q.criteria.yes ?? null,
                false: q.criteria.no ?? null,
              },
            }
          : {}),
      };
    } else if (q.type === 'choice') {
      const wireCriteria: Record<string, unknown> = {};
      for (const [choiceKey, val] of Object.entries(q.criteria)) {
        if (val && typeof val === 'object') {
          wireCriteria[choiceKey] = {
            ...(val.description ? { description: val.description } : {}),
            ...(val.notFor ? { not_for: val.notFor } : {}),
            ...(val.examples ? { examples: [...val.examples] } : {}),
          };
        } else {
          wireCriteria[choiceKey] = val ?? null;
        }
      }
      wireQuestions[key] = {
        type: 'choice',
        instructions: q.instructions,
        criteria: wireCriteria,
      };
    } else if (q.type === 'score') {
      wireQuestions[key] = {
        type: 'score',
        instructions: q.instructions,
        criteria: [...q.criteria],
      };
    } else {
      wireQuestions[key] = {
        type: 'box',
        instructions: q.instructions,
      };
    }
  }

  const hasAssets = Object.keys(assets).length > 0;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    ...(hasAssets ? { 'TypeSafe-Danger-Zone-Images': 'true' } : {}),
    ...(tsOptions?.longContext ? { 'TypeSafe-Danger-Zone-Long-Context': 'true' } : {}),
  };

  const wireBody: Record<string, unknown> = {
    model: modelId,
    state,
    ...(hasAssets ? { assets } : {}),
    questions: wireQuestions,
  };

  const raw = await postDecisionRequest<TypeSafeWireResponse>('typesafe', params.model, url, headers, wireBody, signal);

  const rawAnswers = raw.answers ?? {};
  const normalizedAnswers: Record<string, DecisionAnswer> = {};

  for (const [key, q] of Object.entries(params.questions)) {
    const rawAns = rawAnswers[key];
    if (!rawAns) {
      throw Oops.Panic.ExternalService('typesafe', `Missing answer for question "${key}" in TypeSafe response`);
    }
    normalizedAnswers[key] = normalizeProviderAnswer('typesafe', key, q, rawAns);
  }

  const inputTokens = raw.usage?.input_tokens ?? 0;

  return {
    answers: normalizedAnswers as DecideAnswers<Q>,
    usage: buildTokenUsage(params.model, inputTokens, 0),
    model: raw.model ?? modelId,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Google Gemini Decision 1 Adapter (`/v1beta/decisions`)
// ═══════════════════════════════════════════════════════════════════════════

interface GoogleWireResponse {
  model?: string;
  answers?: Record<string, Record<string, unknown>>;
  promptFeedback?: {
    blockReason?: string;
    blockReasonMessage?: string;
  };
  block_reason?: string;
  usage_metadata?: {
    prompt_token_count?: number;
    cached_content_token_count?: number;
    total_token_count?: number;
  };
  usage?: {
    input_tokens?: number;
    total_input_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    total_cached_tokens?: number;
    input_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

function resolveGoogleDecisionApiKey(explicitKey?: string): string {
  const candidates = [explicitKey, SysEnv.AI_GOOGLE_API_KEY, process.env.AI_GOOGLE_API_KEY];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  throw Oops.Panic.Config('AI_GOOGLE_API_KEY is not configured');
}

async function executeGoogleDecide<M extends DecisionModelKey, Q extends DecisionQuestions<M>>(
  params: DecideParams<M, Q>,
  signal?: AbortSignal,
): Promise<DecideResult<Q>> {
  const googleOpts = (params.providerOptions as { google?: GoogleDecisionProviderOptions } | undefined)?.google;
  const apiKey = resolveGoogleDecisionApiKey(googleOpts?.apiKey);
  const url = googleOpts?.baseUrl ?? DEFAULT_GOOGLE_URL;
  const modelId = params.model.slice('google:'.length);

  let wireInput: unknown;
  if (typeof params.input === 'string') {
    wireInput = params.input;
  } else if (isDecisionInputPartArray(params.input)) {
    wireInput = params.input.map((part) => {
      if (part.type === 'text') {
        return { text: part.text };
      }
      if ('fileUri' in part) {
        return {
          file_data: {
            mime_type: part.mediaType,
            file_uri: part.fileUri,
          },
          ...(part.resolution ? { media_resolution: part.resolution } : {}),
        };
      }
      return {
        inline_data: {
          mime_type: part.mediaType,
          data: toBase64(part.data),
        },
        ...(part.resolution ? { media_resolution: part.resolution } : {}),
      };
    });
  } else {
    wireInput = JSON.stringify(params.input);
  }

  const wireQuestions: Record<string, unknown> = {};
  for (const [key, q] of Object.entries(params.questions)) {
    if (q.type === 'noul') {
      wireQuestions[key] = {
        type: 'noul',
        instructions: compileNoulInstructions(q),
      };
    } else if (q.type === 'choice') {
      const wireCriteria: Record<string, string> = {};
      for (const [choiceKey, val] of Object.entries(q.criteria)) {
        wireCriteria[choiceKey] = compileChoiceCriterionString(val);
      }
      wireQuestions[key] = {
        type: 'choice',
        instructions: q.instructions,
        criteria: wireCriteria,
      };
    } else if (q.type === 'score') {
      wireQuestions[key] = {
        type: 'score',
        instructions: q.instructions,
        criteria: [...q.criteria],
      };
    } else {
      throw Oops.Validation(`Google Decision API does not support question type "${q.type}"`);
    }
  }

  const raw = await postDecisionRequest<GoogleWireResponse>(
    'google',
    params.model,
    url,
    { 'x-goog-api-key': apiKey },
    {
      model: modelId,
      input: wireInput,
      questions: wireQuestions,
    },
    signal,
  );

  const blockReason = raw.promptFeedback?.blockReason ?? raw.block_reason;
  if (blockReason) {
    throw createDecisionSafetyBlockError(params.model, raw.promptFeedback?.blockReasonMessage ?? blockReason);
  }

  const rawAnswers = raw.answers ?? {};
  const normalizedAnswers: Record<string, DecisionAnswer> = {};

  for (const [key, q] of Object.entries(params.questions)) {
    const rawAns = rawAnswers[key];
    if (!rawAns) {
      throw Oops.Panic.ExternalService('google', `Missing answer for question "${key}" in Google Decision response`);
    }
    normalizedAnswers[key] = normalizeProviderAnswer('google', key, q, rawAns);
  }

  const inputTokens =
    raw.usage_metadata?.prompt_token_count ??
    raw.usage?.total_input_tokens ??
    raw.usage?.input_tokens ??
    raw.usage?.total_tokens ??
    0;
  const cachedTokens =
    raw.usage_metadata?.cached_content_token_count ??
    raw.usage?.total_cached_tokens ??
    raw.usage?.cached_tokens ??
    raw.usage?.input_tokens_details?.cached_tokens ??
    0;

  return {
    answers: normalizedAnswers as DecideAnswers<Q>,
    usage: buildTokenUsage(params.model, inputTokens, cachedTokens),
    model: raw.model ?? modelId,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. OpenAI Decisions API Adapter (`/v1/decisions`)
// ═══════════════════════════════════════════════════════════════════════════

interface OpenAIWireAnswer {
  type: 'predicate' | 'noul' | 'choice' | 'score' | 'refusal';
  name: string;
  probability?: number;
  noul?: number;
  choice?: string;
  probabilities?: unknown;
  score?: number;
  confidence?: number;
  reason?: string;
  message?: string;
}

interface OpenAIWireResponse {
  id?: string;
  model?: string;
  answers?: OpenAIWireAnswer[];
  decisions?: OpenAIWireAnswer[];
  usage?: {
    input_tokens?: number;
    input_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

function resolveOpenAIDecisionApiKey(explicitKey?: string): string {
  const candidates = [explicitKey, SysEnv.AI_OPENAI_API_KEY, process.env.AI_OPENAI_API_KEY];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  throw Oops.Panic.Config('AI_OPENAI_API_KEY is not configured');
}

async function executeOpenAIDecide<M extends DecisionModelKey, Q extends DecisionQuestions<M>>(
  params: DecideParams<M, Q>,
  signal?: AbortSignal,
): Promise<DecideResult<Q>> {
  const openaiOpts = (params.providerOptions as { openai?: OpenAIDecisionProviderOptions } | undefined)?.openai;
  const apiKey = resolveOpenAIDecisionApiKey(openaiOpts?.apiKey);
  const url = openaiOpts?.baseUrl ?? DEFAULT_OPENAI_URL;
  const modelId = params.model.slice('openai:'.length);

  let wireInput: unknown;
  if (typeof params.input === 'string') {
    wireInput = params.input;
  } else if (isDecisionInputPartArray(params.input)) {
    const contentParts = params.input.map((part) => {
      if (part.type === 'text') {
        return { type: 'input_text', text: part.text };
      }
      if ('fileUri' in part) {
        throw Oops.Validation('OpenAI Decisions API does not support fileUri parts; use D.image()');
      }
      return {
        type: 'input_image',
        image_url: toDataUrl(part.data, part.mediaType),
      };
    });
    wireInput = [{ role: 'user', content: contentParts }];
  } else {
    wireInput = JSON.stringify(params.input);
  }

  const wireQuestions: Array<Record<string, unknown>> = [];
  for (const [name, q] of Object.entries(params.questions)) {
    if (q.type === 'noul') {
      wireQuestions.push({
        type: 'predicate',
        name,
        instructions: compileNoulInstructions(q),
      });
    } else if (q.type === 'choice') {
      const choices = Object.entries(q.criteria).map(([value, crit]) => {
        const description = compileChoiceCriterionString(crit);
        return description ? { value, description } : { value };
      });
      wireQuestions.push({
        type: 'choice',
        name,
        instructions: q.instructions,
        choices,
      });
    } else if (q.type === 'score') {
      const levels = q.criteria.map((description, idx) => ({
        label: String(idx),
        description,
      }));
      wireQuestions.push({
        type: 'score',
        name,
        instructions: q.instructions,
        levels,
      });
    } else {
      throw Oops.Validation(`OpenAI Decisions API does not support question type "${q.type}"`);
    }
  }

  const raw = await postDecisionRequest<OpenAIWireResponse>(
    'openai',
    params.model,
    url,
    { Authorization: `Bearer ${apiKey}` },
    {
      model: modelId,
      input: wireInput,
      questions: wireQuestions,
    },
    signal,
  );

  const answerItems = raw.answers ?? raw.decisions ?? [];
  const answerByName = new Map<string, OpenAIWireAnswer>();
  for (const item of answerItems) {
    if (typeof item.name === 'string') {
      if (item.type === 'refusal') {
        throw createDecisionSafetyBlockError(
          params.model,
          `Refused question "${item.name}": ${item.reason ?? item.message ?? 'Model safety refusal'}`,
        );
      }
      answerByName.set(item.name, item);
    }
  }

  const normalizedAnswers: Record<string, DecisionAnswer> = {};
  for (const [name, q] of Object.entries(params.questions)) {
    const rawAns = answerByName.get(name);
    if (!rawAns) {
      throw Oops.Panic.ExternalService('openai', `Missing answer for question "${name}" in OpenAI Decisions response`);
    }
    normalizedAnswers[name] = normalizeProviderAnswer('openai', name, q, rawAns as unknown as Record<string, unknown>);
  }

  const inputTokens = raw.usage?.input_tokens ?? 0;
  const cachedTokens = raw.usage?.input_tokens_details?.cached_tokens ?? 0;

  return {
    answers: normalizedAnswers as DecideAnswers<Q>,
    usage: buildTokenUsage(params.model, inputTokens, cachedTokens),
    model: raw.model ?? modelId,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Unified Answer Normalizer
// ═══════════════════════════════════════════════════════════════════════════

function normalizeProviderAnswer(
  provider: DecisionProvider,
  questionKey: string,
  question: DecisionQuestionFor<DecisionModelKey>,
  rawAns: Record<string, unknown>,
): DecisionAnswer {
  if (question.type === 'noul') {
    const probability =
      typeof rawAns.probability === 'number' && Number.isFinite(rawAns.probability)
        ? rawAns.probability
        : typeof rawAns.noul === 'number' && Number.isFinite(rawAns.noul)
          ? rawAns.noul
          : undefined;
    if (probability === undefined) {
      throw Oops.Panic.ExternalService(
        provider,
        `Malformed noul answer for question "${questionKey}": missing finite numeric probability`,
      );
    }
    const answer: NoulAnswer = {
      type: 'noul',
      probability,
    };
    return answer;
  }

  if (question.type === 'choice') {
    const choiceKey = typeof rawAns.choice === 'string' && rawAns.choice.length > 0 ? rawAns.choice : undefined;
    if (!choiceKey) {
      throw Oops.Panic.ExternalService(
        provider,
        `Malformed choice answer for question "${questionKey}": missing non-empty string choice`,
      );
    }

    const rawProbs = rawAns.probabilities;
    if (!rawProbs || typeof rawProbs !== 'object') {
      throw Oops.Panic.ExternalService(
        provider,
        `Malformed choice answer for question "${questionKey}": missing probabilities distribution`,
      );
    }

    const parsedProbs: Record<string, number> = {};
    if (Array.isArray(rawProbs)) {
      for (const item of rawProbs) {
        if (!item || typeof item !== 'object') {
          throw Oops.Panic.ExternalService(
            provider,
            `Malformed choice probability entry for question "${questionKey}"`,
          );
        }
        const entry = item as { value?: unknown; probability?: unknown };
        if (
          typeof entry.value !== 'string' ||
          typeof entry.probability !== 'number' ||
          !Number.isFinite(entry.probability)
        ) {
          throw Oops.Panic.ExternalService(
            provider,
            `Malformed choice probability entry for question "${questionKey}": expected string value and finite probability`,
          );
        }
        parsedProbs[entry.value] = entry.probability;
      }
    } else {
      for (const [k, v] of Object.entries(rawProbs as Record<string, unknown>)) {
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          throw Oops.Panic.ExternalService(
            provider,
            `Malformed choice probability for question "${questionKey}" option "${k}": expected finite number`,
          );
        }
        parsedProbs[k] = v;
      }
    }

    const probsRecord: Record<string, number> = {};
    for (const optionKey of Object.keys(question.criteria)) {
      const p = parsedProbs[optionKey];
      if (typeof p !== 'number' || !Number.isFinite(p)) {
        throw Oops.Panic.ExternalService(
          provider,
          `Malformed choice answer for question "${questionKey}": missing finite probability for option "${optionKey}"`,
        );
      }
      probsRecord[optionKey] = p;
    }

    if (typeof probsRecord[choiceKey] !== 'number' || !Number.isFinite(probsRecord[choiceKey])) {
      throw Oops.Panic.ExternalService(
        provider,
        `Malformed choice answer for question "${questionKey}": winning choice "${choiceKey}" has no finite probability`,
      );
    }

    return computeChoiceAnswer(choiceKey, probsRecord);
  }

  if (question.type === 'score') {
    if (typeof rawAns.score !== 'number' || !Number.isFinite(rawAns.score)) {
      throw Oops.Panic.ExternalService(
        provider,
        `Malformed score answer for question "${questionKey}": missing finite numeric score`,
      );
    }
    const probabilities = normalizeScoreProbabilities(
      provider,
      questionKey,
      rawAns.probabilities,
      question.criteria.length,
    );
    return computeScoreAnswer(rawAns.score, probabilities);
  }

  if (typeof rawAns.confidence !== 'number' || !Number.isFinite(rawAns.confidence)) {
    throw Oops.Panic.ExternalService(
      provider,
      `Malformed box answer for question "${questionKey}": missing finite numeric confidence`,
    );
  }

  const rawBox = rawAns.box as BoundingBox | null | undefined;
  if (rawBox !== null && rawBox !== undefined) {
    if (
      typeof rawBox !== 'object' ||
      typeof rawBox.top !== 'number' ||
      !Number.isFinite(rawBox.top) ||
      typeof rawBox.bottom !== 'number' ||
      !Number.isFinite(rawBox.bottom) ||
      typeof rawBox.left !== 'number' ||
      !Number.isFinite(rawBox.left) ||
      typeof rawBox.right !== 'number' ||
      !Number.isFinite(rawBox.right)
    ) {
      throw Oops.Panic.ExternalService(
        provider,
        `Malformed box coordinates for question "${questionKey}": expected finite top/bottom/left/right numbers`,
      );
    }
  }

  const boxAnswer: BoxAnswer = {
    type: 'box',
    box: rawBox
      ? {
          top: rawBox.top,
          bottom: rawBox.bottom,
          left: rawBox.left,
          right: rawBox.right,
        }
      : null,
    confidence: rawAns.confidence,
  };
  return boxAnswer;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public Entry Point for `LLM.safeDecide` / `LLM.decide`
// ═══════════════════════════════════════════════════════════════════════════

export async function executeDecide<const M extends DecisionModelKey, const Q extends DecisionQuestions<M>>(
  params: DecideParams<M, Q>,
  signal?: AbortSignal,
): Promise<DecideResult<Q>> {
  const questionKeys = Object.keys(params.questions);
  if (questionKeys.length === 0) {
    throw Oops.Validation('LLM.decide requires at least one question in `questions`');
  }

  const provider = resolveDecisionProvider(params.model);
  switch (provider) {
    case 'typesafe':
      return executeTypeSafeDecide(params, signal);
    case 'google':
      return executeGoogleDecide(params, signal);
    case 'openai':
      return executeOpenAIDecide(params, signal);
  }
}
