import { DEFAULT_DECISIONS_MODEL, executeDecisions } from '@app/features/llm/decisions/decisions.client';

import type {
  DecisionChoiceQuestion,
  DecisionPredicateQuestion,
  DecisionQuestion,
  DecisionRequest,
  DecisionScoreQuestion,
} from '@app/features/llm/decisions/decisions.types';
import type { Questions, SystemOneRequest, SystemOneResult } from '@typesafe-ai/sdk';

/**
 * 格式化 EntryType 為文字描述
 */
function serializeEntry(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (entry === null || entry === undefined) return '';
  return JSON.stringify(entry);
}

/**
 * 將 TypeSafe SystemOneRequest 轉換為 OpenAI Decisions API 請求格式
 */
export function transformSystemOneToOpenAIDecisionRequest<const Q extends Questions>(
  request: SystemOneRequest<Q>,
): DecisionRequest {
  const input = serializeEntry(request.state);

  const questions: DecisionQuestion[] = [];

  for (const [name, q] of Object.entries(request.questions)) {
    if (q.type === 'noul') {
      let instructions = serializeEntry(q.instructions) || name;
      if (q.criteria) {
        const truePart = q.criteria.true ? ` [True: ${serializeEntry(q.criteria.true)}]` : '';
        const falsePart = q.criteria.false ? ` [False: ${serializeEntry(q.criteria.false)}]` : '';
        instructions = `${instructions}${truePart}${falsePart}`.trim();
      }
      const predicateQ: DecisionPredicateQuestion = {
        type: 'predicate',
        name,
        instructions,
      };
      questions.push(predicateQ);
    } else if (q.type === 'choice') {
      const instructions = serializeEntry(q.instructions) || name;
      const choices = Object.entries(q.criteria).map(([val, desc]) => ({
        value: val,
        description: desc ? serializeEntry(desc) : val,
      }));
      const choiceQ: DecisionChoiceQuestion = {
        type: 'choice',
        name,
        instructions,
        choices,
      };
      questions.push(choiceQ);
    } else {
      const instructions = serializeEntry(q.instructions) || name;
      const levels = (Array.isArray(q.criteria) ? q.criteria : []).map((levelDesc, idx) => {
        const text = serializeEntry(levelDesc) || `Level ${idx}`;
        return {
          label: text,
          description: text,
        };
      });
      const scoreQ: DecisionScoreQuestion = {
        type: 'score',
        name,
        instructions,
        levels,
      };
      questions.push(scoreQ);
    }
  }

  // 若請求未指定或指定了 TypeSafe 模型(jev-*)，則預設走 gpt-6-luna
  const model = request.model && !request.model.startsWith('jev') ? request.model : DEFAULT_DECISIONS_MODEL;

  return {
    model,
    input,
    questions,
  };
}

/**
 * 透過 OpenAI Decisions API 執行 SystemOne 決策 (Bridge Adapter)
 */
export async function systemOneViaOpenAI<const Q extends Questions>(
  request: SystemOneRequest<Q>,
  options: { signal?: AbortSignal; apiKey?: string } = {},
): Promise<SystemOneResult<Q>> {
  const openAIRequest = transformSystemOneToOpenAIDecisionRequest(request);
  const decisionResult = await executeDecisions(openAIRequest, options);

  const answers: Record<string, unknown> = {};

  for (const ans of decisionResult.answers) {
    if (ans.type === 'predicate') {
      answers[ans.name] = {
        type: 'noul',
        noul: ans.probability,
      };
    } else if (ans.type === 'choice') {
      const probabilities: Record<string, number> = {};
      for (const p of ans.probabilities) {
        probabilities[p.value] = p.probability;
      }
      answers[ans.name] = {
        type: 'choice',
        choice: ans.choice,
        confidence: ans.confidence,
        probabilities,
      };
    } else if (ans.type === 'score') {
      const probabilities: Record<string, number> = {};
      for (const p of ans.probabilities) {
        probabilities[String(p.value)] = p.probability;
      }
      answers[ans.name] = {
        type: 'score',
        score: ans.score,
        confidence: ans.confidence,
        probabilities,
      };
    }
  }

  return {
    model: decisionResult.model,
    answers: answers as SystemOneResult<Q>['answers'],
    usage: {
      input_tokens: decisionResult.usage.input_tokens,
      output_tokens: decisionResult.usage.output_tokens,
    },
  };
}
