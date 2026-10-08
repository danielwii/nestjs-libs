import { SysEnv } from '@app/env';
import { Oops } from '@app/nest/exceptions/oops';
import { ApiFetcher } from '@app/utils/fetch';

import { classifyOpenAIDecisionsError } from './decisions.errors';

import type {
  DecisionAnswer,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
  DecisionResultUsage,
  MapQuestionsToAnswers,
  MapQuestionsToAnswersByName,
} from './decisions.types';

export const DEFAULT_DECISIONS_MODEL = 'gpt-6-luna';
export const DEFAULT_DECISIONS_BASE_URL = 'https://api.openai.com/v1';

let testFetcher: typeof fetch | null = null;

/** Test seam: 注入自定義 fetcher 避免單元測試走真實網路請求 */
export function setDecisionsFetcherForTest(fetcher: typeof fetch | null): void {
  testFetcher = fetcher;
}

export function getOpenAIDecisionsApiKey(): string {
  const key = SysEnv.AI_OPENAI_API_KEY?.trim() ?? process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw Oops.Panic.Config('AI_OPENAI_API_KEY is not configured');
  }
  return key;
}

export interface ExecuteDecisionsOptions {
  signal?: AbortSignal;
  apiKey?: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
}

export async function executeDecisions<const Q extends readonly DecisionQuestion[] = readonly DecisionQuestion[]>(
  request: DecisionRequest<Q>,
  options: ExecuteDecisionsOptions = {},
): Promise<DecisionResult<Q>> {
  const model = request.model ?? DEFAULT_DECISIONS_MODEL;
  const apiKey = options.apiKey ?? getOpenAIDecisionsApiKey();
  const baseUrl = options.baseUrl ?? DEFAULT_DECISIONS_BASE_URL;
  const activeFetcher = options.fetcher ?? testFetcher ?? ApiFetcher.fetch;

  const url = `${baseUrl.replace(/\/+$/, '')}/decisions`;
  const payload = {
    model,
    input: request.input,
    questions: request.questions,
  };

  try {
    const response = await activeFetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: options.signal,
    });

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status} ${response.statusText}`;
      try {
        const errorJson = (await response.json()) as { error?: { message?: string } };
        if (errorJson.error?.message) {
          errorMessage = errorJson.error.message;
        }
      } catch {
        // 非 JSON 回應，保留 statusText
      }

      if (response.status === 429) {
        throw Oops.Block.AIModelRateLimited(model, { cause: new Error(errorMessage) });
      }
      if (response.status === 401 || response.status === 403) {
        throw Oops.Panic.Config(`OpenAI authentication failed: ${errorMessage}`);
      }
      if (response.status === 400) {
        throw Oops.Validation(`OpenAI decisions request invalid: ${errorMessage}`);
      }
      throw Oops.Panic.AIModelError(model, `OpenAI upstream error: ${errorMessage}`);
    }

    const rawResult = (await response.json()) as {
      model: string;
      answers: DecisionAnswer[];
      usage: DecisionResultUsage;
    };

    const answersByName = {} as Record<string, DecisionAnswer>;
    for (const ans of rawResult.answers) {
      answersByName[ans.name] = ans;
    }

    return {
      model: rawResult.model,
      answers: rawResult.answers as unknown as MapQuestionsToAnswers<Q>,
      answersByName: answersByName as unknown as MapQuestionsToAnswersByName<Q>,
      usage: rawResult.usage,
    };
  } catch (error) {
    throw classifyOpenAIDecisionsError(error, model);
  }
}
