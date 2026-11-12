/**
 * `D` — Polymorphic Question, Multimodal Input & Abstention Band DSL for `LLM.decide`
 *
 * Modeled after Zod (`z.*`), `D` provides a single ergonomic namespace for:
 * 1. Closed-set questions: `D.noul`, `D.choice`, `D.score`, `D.box`
 * 2. Multimodal parts (AI SDK `TextPart` / `FilePart` compatible): `D.text`, `D.image`, `D.pdf`, `D.audio`, `D.video`, `D.fileUri`
 * 3. Polarity-neutral abstention bands (`[AIN-03]` Law 3): `D.band`, `D.choiceBand`
 */

import { Oops } from '@app/nest/exceptions/oops';

import type {
  AbstentionBand,
  AbstentionThresholds,
  AllowedMediaType,
  AudioMediaType,
  BoxQuestion,
  ChoiceAnswer,
  ChoiceBand,
  ChoiceBandThresholds,
  ChoiceCriterionValue,
  ChoiceQuestion,
  DecisionInlineFilePart,
  DecisionTextPart,
  DecisionUriFilePart,
  GoogleDecisionModelKey,
  GoogleMediaResolution,
  ImageMediaType,
  NoulCriteria,
  NoulQuestion,
  PdfMediaType,
  ScoreQuestion,
  VideoMediaType,
} from './decide.types';
import type { DataContent } from '@ai-sdk/provider-utils';

// ═══════════════════════════════════════════════════════════════════════════
// 1. Question Builders
// ═══════════════════════════════════════════════════════════════════════════

function noul(instructions: string, criteria?: NoulCriteria): NoulQuestion {
  return criteria ? { type: 'noul', instructions, criteria } : { type: 'noul', instructions };
}

function choice<const K extends string>(
  instructions: string,
  criteria: Readonly<Record<K, ChoiceCriterionValue>> | readonly [K, ...K[]],
): ChoiceQuestion<K> {
  if (Array.isArray(criteria)) {
    const normalized = {} as Record<K, ChoiceCriterionValue>;
    for (const key of criteria as readonly K[]) {
      normalized[key] = null;
    }
    return { type: 'choice', instructions, criteria: normalized };
  }
  return {
    type: 'choice',
    instructions,
    criteria: criteria as Readonly<Record<K, ChoiceCriterionValue>>,
  };
}

function score(instructions: string, criteria: readonly [string, string, ...string[]]): ScoreQuestion {
  return { type: 'score', instructions, criteria };
}

function box(instructions: string): BoxQuestion {
  return { type: 'box', instructions };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Multimodal Input Builders (AI SDK `TextPart` / `FilePart` Compatible)
// ═══════════════════════════════════════════════════════════════════════════

function text(value: string): DecisionTextPart {
  return { type: 'text', text: value };
}

export interface ImagePartOptions {
  /** Image MIME type (defaults to `'image/png'`). */
  readonly mediaType?: ImageMediaType;
  /** Optional asset key for TypeSafe `assets` dictionary (`<asset:key>`). */
  readonly key?: string;
  /** Optional Google Gemini media resolution (`low` | `medium` | `high`). */
  readonly resolution?: GoogleMediaResolution;
}

function image(
  data: DataContent,
  options?: ImagePartOptions,
): DecisionInlineFilePart & { readonly mediaType: ImageMediaType } {
  return {
    type: 'file',
    data,
    mediaType: options?.mediaType ?? 'image/png',
    ...(options?.key ? { key: options.key } : {}),
    ...(options?.resolution ? { resolution: options.resolution } : {}),
  };
}

export interface PdfPartOptions {
  /** Optional Google Gemini media resolution (`low` | `medium` | `high`). */
  readonly resolution?: GoogleMediaResolution;
}

function pdf(
  data: DataContent,
  options?: PdfPartOptions,
): DecisionInlineFilePart<GoogleDecisionModelKey> & { readonly mediaType: PdfMediaType } {
  return {
    type: 'file',
    data,
    mediaType: 'application/pdf',
    ...(options?.resolution ? { resolution: options.resolution } : {}),
  };
}

export interface AudioPartOptions {
  readonly mediaType: AudioMediaType;
  readonly resolution?: GoogleMediaResolution;
}

function audio(
  data: DataContent,
  options: AudioPartOptions,
): DecisionInlineFilePart<GoogleDecisionModelKey> & { readonly mediaType: AudioMediaType } {
  return {
    type: 'file',
    data,
    mediaType: options.mediaType,
    ...(options.resolution ? { resolution: options.resolution } : {}),
  };
}

export interface VideoPartOptions {
  readonly mediaType?: VideoMediaType;
  readonly resolution?: GoogleMediaResolution;
}

function video(
  data: DataContent,
  options?: VideoPartOptions,
): DecisionInlineFilePart<GoogleDecisionModelKey> & { readonly mediaType: VideoMediaType } {
  return {
    type: 'file',
    data,
    mediaType: options?.mediaType ?? 'video/mp4',
    ...(options?.resolution ? { resolution: options.resolution } : {}),
  };
}

export interface FileUriPartOptions {
  readonly mediaType: AllowedMediaType<GoogleDecisionModelKey>;
  readonly resolution?: GoogleMediaResolution;
}

function fileUri(uri: string | URL, options: FileUriPartOptions): DecisionUriFilePart {
  const url = typeof uri === 'string' ? new URL(uri) : uri;
  return {
    type: 'file',
    data: url,
    fileUri: url.toString(),
    mediaType: options.mediaType,
    ...(options.resolution ? { resolution: options.resolution } : {}),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Polarity-Neutral Abstention Bands (`[AIN-03]` Law 3)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Evaluates a `noul` probability or normalized `score` against a two-sided
 * abstention band `{ low, high }`.
 *
 * - `p < low`   -> `'low'`
 * - `p >= high` -> `'high'`
 * - otherwise   -> `'abstain'` (route to System-2 LLM or human review)
 */
function band(
  input: { readonly probability: number } | { readonly normalizedScore: number } | number,
  thresholds: AbstentionThresholds,
): AbstentionBand {
  const { low, high } = thresholds;
  if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high > 1 || low >= high) {
    throw Oops.Validation(
      `Invalid abstention band thresholds: expected 0 <= low < high <= 1, got low=${low}, high=${high}`,
    );
  }

  const value = typeof input === 'number' ? input : 'probability' in input ? input.probability : input.normalizedScore;

  if (value < low) return 'low';
  if (value >= high) return 'high';
  return 'abstain';
}

/**
 * Evaluates a multi-class `ChoiceAnswer` against minimum top probability and
 * top-1 vs top-2 margin thresholds (`[AIN-03]` Law 3).
 *
 * Returns `'confident'` only when both `topProbability >= minProbability`
 * and `margin >= (minMargin ?? 0)` hold; otherwise returns `'abstain'`.
 */
function choiceBand<K extends string>(
  answer: Pick<ChoiceAnswer<K>, 'topProbability' | 'margin'>,
  thresholds: ChoiceBandThresholds,
): ChoiceBand {
  const minProbability = thresholds.minProbability;
  const minMargin = thresholds.minMargin ?? 0;

  if (
    !Number.isFinite(minProbability) ||
    !Number.isFinite(minMargin) ||
    minProbability < 0 ||
    minProbability > 1 ||
    minMargin < 0 ||
    minMargin > 1
  ) {
    throw Oops.Validation(
      `Invalid choiceBand thresholds: expected minProbability and minMargin in [0, 1], got minProbability=${minProbability}, minMargin=${minMargin}`,
    );
  }

  if (answer.topProbability >= minProbability && answer.margin >= minMargin) {
    return 'confident';
  }
  return 'abstain';
}

export const D = {
  noul,
  choice,
  score,
  box,
  text,
  image,
  pdf,
  audio,
  video,
  fileUri,
  band,
  choiceBand,
} as const;
