/**
 * OpenAI Decisions API 官方契約型別定義 (gpt-6-luna)
 *
 * 專為條件判斷、有限集合選項挑選、依 Rubric 評分設計，
 * 支援純文字或多模態圖片 (inline base64 Data URL) 輸入，
 * 具有零生成 Token (output_tokens: 0) 與超低延遲特性。
 *
 * @see https://developers.openai.com/api/docs/guides/decisions
 */

export interface DecisionInputText {
  type: 'input_text';
  text: string;
}

export interface DecisionInputImage {
  type: 'input_image';
  /** 必須為 inline base64 Data URL (如 data:image/png;base64,...) */
  image_url: string;
}

export type DecisionInputPart = DecisionInputText | DecisionInputImage;

export interface DecisionInputMessage {
  role: 'user';
  content: DecisionInputPart[];
}

/** 支援純文字字串或多模態使用者訊息列表 */
export type DecisionInput = string | DecisionInputMessage[];

export interface DecisionPredicateQuestion<N extends string = string> {
  type: 'predicate';
  name: N;
  instructions: string;
}

export interface DecisionChoiceOption<V extends string = string> {
  value: V;
  description?: string;
}

export interface DecisionChoiceQuestion<N extends string = string, V extends string = string> {
  type: 'choice';
  name: N;
  instructions: string;
  choices: readonly DecisionChoiceOption<V>[];
}

export interface DecisionScoreLevel {
  label: string;
  description?: string;
}

export interface DecisionScoreQuestion<N extends string = string> {
  type: 'score';
  name: N;
  instructions: string;
  levels: readonly DecisionScoreLevel[];
}

export type DecisionQuestion = DecisionPredicateQuestion | DecisionChoiceQuestion | DecisionScoreQuestion;

export interface DecisionPredicateAnswer<N extends string = string> {
  type: 'predicate';
  name: N;
  /** 條件成立之估計機率 (0.0 ~ 1.0) */
  probability: number;
}

export interface DecisionChoiceAnswer<N extends string = string, V extends string = string> {
  type: 'choice';
  name: N;
  /** 被選中的選項值（精確字面量） */
  choice: V;
  /** 各選項機率分佈 */
  probabilities: Array<{
    value: V;
    probability: number;
  }>;
  /** 模型對選中選項之信心度 (0.0 ~ 1.0) */
  confidence: number;
}

export interface DecisionScoreAnswer<N extends string = string> {
  type: 'score';
  name: N;
  /** 機率加權平均分 */
  score: number;
  /** 各有序等級機率分佈 */
  probabilities: Array<{
    value: number;
    label: string;
    probability: number;
  }>;
  /** 信心度 (0.0 ~ 1.0) */
  confidence: number;
}

export interface DecisionRefusalAnswer<N extends string = string> {
  type: 'refusal';
  name: N;
}

export type DecisionAnswer =
  DecisionPredicateAnswer | DecisionChoiceAnswer | DecisionScoreAnswer | DecisionRefusalAnswer;

/**
 * 映射單個 Question 到其精確對應的 Answer 型別
 */
export type MapQuestionToAnswer<Q extends DecisionQuestion> =
  | (Q extends DecisionPredicateQuestion<infer N>
      ? DecisionPredicateAnswer<N>
      : Q extends DecisionChoiceQuestion<infer N, infer V>
        ? DecisionChoiceAnswer<N, V>
        : Q extends DecisionScoreQuestion<infer N>
          ? DecisionScoreAnswer<N>
          : DecisionAnswer)
  | DecisionRefusalAnswer<Q['name']>;

/**
 * 映射 Questions 元組到 Answers 元組
 */
export type MapQuestionsToAnswers<Q extends readonly DecisionQuestion[]> = {
  -readonly [K in keyof Q]: Q[K] extends DecisionQuestion ? MapQuestionToAnswer<Q[K]> : DecisionAnswer;
};

/**
 * 映射 Questions 元組到按 Name 索引的字典
 */
export type MapQuestionsToAnswersByName<Q extends readonly DecisionQuestion[]> = {
  [K in Q[number] as K['name']]: MapQuestionToAnswer<Extract<Q[number], { name: K['name'] }>>;
};

export interface DecisionRequest<Q extends readonly DecisionQuestion[] = readonly DecisionQuestion[]> {
  /** 預設為 gpt-6-luna */
  model?: string;
  input: DecisionInput;
  questions: Q;
}

export interface DecisionResultUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: {
    cached_tokens: number;
    cache_write_tokens: number;
  };
  output_tokens_details?: {
    reasoning_tokens: number;
  };
}

export interface DecisionResult<Q extends readonly DecisionQuestion[] = readonly DecisionQuestion[]> {
  model: string;
  answers: MapQuestionsToAnswers<Q>;
  /** 方便依據 question name 快速按鍵值存取的字典 */
  answersByName?: MapQuestionsToAnswersByName<Q>;
  usage: DecisionResultUsage;
}
