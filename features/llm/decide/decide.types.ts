/**
 * Polymorphic System-1 Decision Models (`LLM.decide` / `LLM.safeDecide`) Types
 *
 * Unifies TypeSafe Jev (`typesafe:*`), Google Gemini Decision 1 (`google:*`),
 * and OpenAI Decisions API (`openai:*`) behind a compile-time capability-locked
 * deep module that reuses AI SDK v7 (`@ai-sdk/provider`, `@ai-sdk/provider-utils`)
 * and `@app/llm-core` (`TokenUsage`) primitives.
 */

import type { TokenUsage } from '../clients/llm.class';
import type { JSONObject, JSONValue } from '@ai-sdk/provider';
import type { DataContent, FilePart, TextPart } from '@ai-sdk/provider-utils';

// ═══════════════════════════════════════════════════════════════════════════
// 1. Model Keys & Provider Capabilities (`[CFT-01]`)
// ═══════════════════════════════════════════════════════════════════════════

export type TypeSafeDecisionModelKey = 'typesafe:jev-1.14.0' | 'typesafe:jev-latest';
export type GoogleDecisionModelKey = 'google:gemini-decision-1';
export type OpenAIDecisionModelKey = 'openai:gpt-6-luna';

/**
 * Closed-set System-1 Decision Model identifiers.
 *
 * Uses the same `<provider>:<modelId>` prefix convention as `LLMModelKey`
 * (`google:*`, `openai:*`, `typesafe:*`), while remaining physically separated
 * from generative `LLMModelKey` so decision models cannot be passed to
 * `LLM.generateText` or `LLM.streamText`.
 */
export type DecisionModelKey = TypeSafeDecisionModelKey | GoogleDecisionModelKey | OpenAIDecisionModelKey;

export type DecisionProvider = 'typesafe' | 'google' | 'openai';

// ═══════════════════════════════════════════════════════════════════════════
// 2. Multimodal & JSON Input Types (Reusing AI SDK v7 Primitives)
// ═══════════════════════════════════════════════════════════════════════════

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
export type PdfMediaType = 'application/pdf';
export type AudioMediaType = 'audio/mp3' | 'audio/mpeg' | 'audio/wav' | 'audio/ogg' | 'audio/aac' | 'audio/flac';
export type VideoMediaType = 'video/mp4' | 'video/mpeg' | 'video/webm' | 'video/quicktime';

/**
 * Compile-time media-type gate per decision model family:
 * - `google:*`: supports `image/*`, `application/pdf`, `audio/*`, `video/*`
 * - `typesafe:*` & `openai:*`: supports `image/*` only
 */
export type AllowedMediaType<M extends DecisionModelKey> = M extends `google:${string}`
  ? ImageMediaType | PdfMediaType | AudioMediaType | VideoMediaType
  : ImageMediaType;

export type GoogleMediaResolution = 'low' | 'medium' | 'high';

/**
 * Standard text part reusing AI SDK `TextPart`.
 */
export type DecisionTextPart = Pick<TextPart, 'type' | 'text'>;

/**
 * Standard inline file part reusing AI SDK `FilePart` (`DataContent` + `mediaType`).
 */
export type DecisionInlineFilePart<M extends DecisionModelKey = DecisionModelKey> = Omit<
  Pick<FilePart, 'type' | 'data' | 'mediaType'>,
  'data' | 'mediaType'
> & {
  readonly type: 'file';
  readonly data: DataContent;
  readonly mediaType: AllowedMediaType<M>;
  /**
   * Optional asset identifier for TypeSafe Jev `assets` dictionary (`<asset:key>`).
   * Defaults to `image_0`, `image_1`, ... in order of appearance.
   */
  readonly key?: string;
  /**
   * Optional Google Gemini media resolution (`low` | `medium` | `high`).
   */
  readonly resolution?: GoogleMediaResolution;
};

/**
 * Google File API / GCS URI file part (`file_data.file_uri`), supported only on `google:*`.
 * Uses `data: URL` from AI SDK `FilePart` so `typesafe:*` and `openai:*` reject it at compile time.
 */
export type DecisionUriFilePart = Omit<Pick<FilePart, 'type' | 'data' | 'mediaType'>, 'data' | 'mediaType'> & {
  readonly type: 'file';
  readonly data: URL;
  readonly fileUri: string;
  readonly mediaType: AllowedMediaType<GoogleDecisionModelKey>;
  readonly resolution?: GoogleMediaResolution;
};

export type DecisionFilePart<M extends DecisionModelKey> = M extends `google:${string}`
  ? DecisionInlineFilePart<M> | DecisionUriFilePart
  : DecisionInlineFilePart<M>;

export type DecisionInputPart<M extends DecisionModelKey> = DecisionTextPart | DecisionFilePart<M>;

/**
 * Polymorphic `input` accepted by `LLM.decide` / `LLM.safeDecide`:
 * - Plain text (`string`)
 * - Structured JSON object or array (`JSONObject | readonly JSONValue[]` from `@ai-sdk/provider`)
 * - Multimodal part sequence (`readonly DecisionInputPart<M>[]` built via `D.text`, `D.image`, etc.)
 */
export type DecisionInput<M extends DecisionModelKey> =
  string | JSONObject | readonly JSONValue[] | readonly DecisionInputPart<M>[];

// ═══════════════════════════════════════════════════════════════════════════
// 3. Question Definitions (`D.noul`, `D.choice`, `D.score`, `D.box`)
// ═══════════════════════════════════════════════════════════════════════════

export interface NoulCriteria {
  readonly yes?: string | null;
  readonly no?: string | null;
}

export interface NoulQuestion {
  readonly type: 'noul';
  readonly instructions: string;
  readonly criteria?: NoulCriteria;
}

export interface ChoiceRichCriterion {
  readonly description?: string;
  readonly notFor?: string;
  readonly examples?: readonly string[];
}

export type ChoiceCriterionValue = string | null | ChoiceRichCriterion;

export interface ChoiceQuestion<K extends string = string> {
  readonly type: 'choice';
  readonly instructions: string;
  readonly criteria: Readonly<Record<K, ChoiceCriterionValue>>;
}

export interface AnyChoiceQuestion {
  readonly type: 'choice';
  readonly instructions: string;
  readonly criteria: { readonly [key: string]: ChoiceCriterionValue | undefined };
}

export interface ScoreQuestion {
  readonly type: 'score';
  readonly instructions: string;
  readonly criteria: readonly [string, string, ...string[]];
}

export interface BoxQuestion {
  readonly type: 'box';
  readonly instructions: string;
}

/**
 * Compile-time question-type gate per decision model family:
 * - `typesafe:*`: `noul` | `choice` | `score` | `box`
 * - `google:*` & `openai:*`: `noul` | `choice` | `score`
 */
export type DecisionQuestionFor<M extends DecisionModelKey> = M extends `typesafe:${string}`
  ? NoulQuestion | AnyChoiceQuestion | ScoreQuestion | BoxQuestion
  : NoulQuestion | AnyChoiceQuestion | ScoreQuestion;

export type DecisionQuestions<M extends DecisionModelKey> = Readonly<Record<string, DecisionQuestionFor<M>>>;

// ═══════════════════════════════════════════════════════════════════════════
// 4. Normalized Isomorphic Answer Shapes (`[AIN-03]`)
// ═══════════════════════════════════════════════════════════════════════════

export interface NoulAnswer {
  readonly type: 'noul';
  /** Calibrated probability in `[0, 1]`. */
  readonly probability: number;
}

export interface ChoiceAnswer<K extends string = string> {
  readonly type: 'choice';
  /** Highest-probability option key. */
  readonly choice: K;
  /** Full softmax probability distribution across all options `K`. */
  readonly probabilities: Readonly<Record<K, number>>;
  /** Probability of the winning `choice` (`P(top1)`). */
  readonly topProbability: number;
  /** Probability margin over runner-up (`P(top1) - P(top2)`). */
  readonly margin: number;
}

export interface ScoreAnswer {
  readonly type: 'score';
  /** Expected value `sum(i * P(i))` in `[0, k - 1]`. */
  readonly score: number;
  /** Normalized score `score / (k - 1)` in `[0, 1]`. */
  readonly normalizedScore: number;
  /**
   * Ordered probability distribution `[P(0), P(1), ..., P(k - 1)]`.
   * Stored as an array so `JSON.stringify` / `JSON.parse` round-trip preserves exact types.
   */
  readonly probabilities: readonly number[];
}

export interface BoundingBox {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export interface BoxAnswer {
  readonly type: 'box';
  /** Normalized bounding box in `[0, 1]` coordinates, or `null` when target is absent. */
  readonly box: BoundingBox | null;
  readonly confidence: number;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer | BoxAnswer;

export type MapQuestionToAnswer<Q> = Q extends NoulQuestion
  ? NoulAnswer
  : Q extends ChoiceQuestion<infer K>
    ? ChoiceAnswer<K>
    : Q extends { readonly type: 'choice'; readonly criteria: infer C }
      ? ChoiceAnswer<Extract<keyof C, string>>
      : Q extends ScoreQuestion
        ? ScoreAnswer
        : Q extends BoxQuestion
          ? BoxAnswer
          : never;

export type DecideAnswers<Q extends Readonly<Record<string, unknown>>> = {
  readonly [P in keyof Q]: MapQuestionToAnswer<Q[P]>;
};

// ═══════════════════════════════════════════════════════════════════════════
// 5. Request & Response Envelopes (`DecideParams` & `DecideResult`)
// ═══════════════════════════════════════════════════════════════════════════

export interface TypeSafeProviderOptions {
  /** Enable `TypeSafe-Danger-Zone-Long-Context: true` header (`> 32K` tokens). */
  readonly longContext?: boolean;
  /** Override API key (defaults to `AI_TYPESAFE_API_KEY`). */
  readonly apiKey?: string;
  /** Override endpoint URL. */
  readonly baseUrl?: string;
}

export interface GoogleDecisionProviderOptions {
  /** Override API key (defaults to `AI_GOOGLE_API_KEY`). */
  readonly apiKey?: string;
  /** Override endpoint URL. */
  readonly baseUrl?: string;
}

export interface OpenAIDecisionProviderOptions {
  /** Override API key (defaults to `AI_OPENAI_API_KEY`). */
  readonly apiKey?: string;
  /** Override endpoint URL. */
  readonly baseUrl?: string;
}

export type DecisionProviderOptions<M extends DecisionModelKey> = M extends `typesafe:${string}`
  ? { readonly typesafe?: TypeSafeProviderOptions }
  : M extends `google:${string}`
    ? { readonly google?: GoogleDecisionProviderOptions }
    : M extends `openai:${string}`
      ? { readonly openai?: OpenAIDecisionProviderOptions }
      : never;

export interface DecideParams<
  M extends DecisionModelKey = DecisionModelKey,
  Q extends DecisionQuestions<M> = DecisionQuestions<M>,
> {
  /** Business trace/call identifier (aligned with `BaseParams.id`). */
  readonly id: string;
  /** Target decision model (`typesafe:*` | `google:*` | `openai:*`). */
  readonly model: M;
  /** Input context (string, JSON object/array, or multimodal `D.*` parts). */
  readonly input: DecisionInput<M>;
  /** Single-pass orthogonal question dictionary. */
  readonly questions: Q;
  /** Optional `AbortSignal` for cancellation. */
  readonly abortSignal?: AbortSignal;
  /** Request timeout in milliseconds (defaults to `SysEnv.AI_LLM_TIMEOUT_MS`). */
  readonly timeout?: number;
  /**
   * Provider-specific options.
   * Note: `maxRetries` is intentionally omitted (Owner decision #4b843150, aligned with
   * `LLM.embedding` / `LLM.systemOne`): System-1 hot-path gates fail fast via `LLM.safeDecide`
   * rather than inflating turn tail latency with retry loops.
   */
  readonly providerOptions?: DecisionProviderOptions<M>;
}

export interface DecideResult<Q extends Readonly<Record<string, unknown>>> {
  /** Strongly-typed answer dictionary mirroring `questions` keys. */
  readonly answers: DecideAnswers<Q>;
  /** Unified token usage & USD cost (aligned with `GenerateObjectResult.usage`). */
  readonly usage: TokenUsage;
  /** Underlying provider model identifier returned by the API. */
  readonly model: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Polarity-Neutral Abstention Bands (`D.band` & `D.choiceBand`)
// ═══════════════════════════════════════════════════════════════════════════

export type AbstentionBand = 'low' | 'abstain' | 'high';

export interface AbstentionThresholds {
  /** Probability strictly below `low` falls into `'low'`. */
  readonly low: number;
  /** Probability at or above `high` falls into `'high'`. */
  readonly high: number;
}

export type ChoiceBand = 'confident' | 'abstain';

export interface ChoiceBandThresholds {
  /** Minimum `topProbability` required to be `'confident'`. */
  readonly minProbability: number;
  /** Minimum `margin` (`P(top1) - P(top2)`) required to be `'confident'` (defaults to `0`). */
  readonly minMargin?: number;
}
