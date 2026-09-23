import { SysEnv } from '@app/env';
import { Oops } from '@app/nest/exceptions/oops';
import { getAppLogger } from '@app/utils/app-logger';
import { ApiFetcher } from '@app/utils/fetch';

import { getModelId } from '../types/model.types';
import { BatchResponseSchema, CreateBatchParamsSchema } from './schemas/batch.schema';

import type { LLMModelKey } from '../types/model.types';
import type { BatchResponse, BatchResultItem, CreateBatchParams } from './schemas/batch.schema';

function normalizeModel(model: string): string {
  const trimmed = model.trim();
  try {
    return getModelId(trimmed as LLMModelKey);
  } catch {
    return trimmed.startsWith('openrouter:') ? trimmed.slice('openrouter:'.length) : trimmed;
  }
}

/**
 * 通用無狀態 LLM Batch 客戶端 (基於 OpenRouter Batch 原生協議)
 *
 * 設計哲學 (Less is More & Contract-First)：
 * - 專注於協議級通訊與邊界防禦，不含任何 Redis、資料庫或業務狀態機依賴。
 * - 境內第一層嚴格執行 Safe-Reject：校驗入參結構、防範重複 custom_id，杜絕髒數據外洩。
 * - 啟動期 Fail-Fast：缺少金鑰立即報錯，嚴禁帶病啟動。
 */
export class LLMBatch {
  private static readonly logger = getAppLogger('LLMBatch');
  private static readonly BASE_URL = 'https://openrouter.ai/api/v1/batches';

  /**
   * 提交 Batch 批量作業
   *
   * 雙階邊界防禦：
   * 1. 靜態啟動防禦 (Fail-Fast): 檢查 AI_OPENROUTER_API_KEY 是否配置。
   * 2. 動態入境防禦 (Safe-Reject):
   *    - 校驗入參結構（model 非空、requests 非空陣列）
   *    - 本機檢查 custom_id 唯一性，重複即刻拋出 Oops.Validation 攔截。
   * 3. 模型名稱自動正規化：基於 Model Registry 解析或剝除 'openrouter:' 前綴為原生模型名。
   */
  static async create(params: CreateBatchParams): Promise<BatchResponse> {
    const apiKey = LLMBatch.requireApiKey();

    // 1. 入境 Safe-Reject
    const parsed = CreateBatchParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw Oops.Validation('Invalid batch request parameters', JSON.stringify(parsed.error.issues));
    }

    // 2. 本地第一層檢查 custom_id 唯一性
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const req of parsed.data.requests) {
      if (seen.has(req.custom_id)) duplicates.add(req.custom_id);
      seen.add(req.custom_id);
    }
    if (duplicates.size > 0) {
      throw Oops.Validation(
        `Duplicate custom_id detected in batch requests: ${Array.from(duplicates).join(', ')}`,
        JSON.stringify({ duplicates: Array.from(duplicates) }),
      );
    }

    // 3. 模型名稱正規化 (利用 Model Registry 將 openrouter:gpt-6-sol 解析為 openai/gpt-6-sol)
    const normalizedModel = normalizeModel(parsed.data.model);

    const normalizedRequests = parsed.data.requests.map((r) => ({
      custom_id: r.custom_id,
      body: {
        ...r.body,
        model: r.body.model ? normalizeModel(r.body.model) : normalizedModel,
      },
    }));

    LLMBatch.logger.info`Submitting batch job: model=${normalizedModel} totalRequests=${normalizedRequests.length}`;

    const response = await ApiFetcher.fetch(LLMBatch.BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        endpoint: parsed.data.endpoint,
        model: normalizedModel,
        requests: normalizedRequests,
      }),
    });

    return LLMBatch.handleResponse(response, 'create');
  }

  /**
   * 查詢 Batch 作業狀態與產物
   *
   * 當 status 為 'completed' 時，OpenRouter 會在響應中直接內聯 results。
   */
  static async get(batchId: string): Promise<BatchResponse> {
    const apiKey = LLMBatch.requireApiKey();
    const id = batchId.trim();
    if (!id) {
      throw Oops.Validation('batchId cannot be empty');
    }

    const url = `${LLMBatch.BASE_URL}/${encodeURIComponent(id)}`;
    const response = await ApiFetcher.fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    return LLMBatch.handleResponse(response, 'get');
  }

  /**
   * 取消未完成的 Batch 作業
   */
  static async cancel(batchId: string): Promise<BatchResponse> {
    const apiKey = LLMBatch.requireApiKey();
    const id = batchId.trim();
    if (!id) {
      throw Oops.Validation('batchId cannot be empty');
    }

    const url = `${LLMBatch.BASE_URL}/${encodeURIComponent(id)}/cancel`;
    const response = await ApiFetcher.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    return LLMBatch.handleResponse(response, 'cancel');
  }

  /**
   * 便捷抽取 Helper：
   * 從已完成的 BatchResponse 中抽取以 custom_id 為 Key 的映射 Map
   */
  static getResults(batch: BatchResponse): Map<string, BatchResultItem> {
    if (batch.status !== 'completed') {
      throw Oops.Validation(
        `Batch ${batch.id} is not completed (current status: ${batch.status})`,
        JSON.stringify({ status: batch.status, batchId: batch.id }),
      );
    }

    const map = new Map<string, BatchResultItem>();
    for (const item of batch.results ?? []) {
      map.set(item.custom_id, item);
    }
    return map;
  }

  private static requireApiKey(): string {
    const key = SysEnv.AI_OPENROUTER_API_KEY;
    if (!key || key.trim() === '') {
      throw Oops.Panic.Config('AI_OPENROUTER_API_KEY is not set');
    }
    return key;
  }

  private static async handleResponse(response: Response, action: string): Promise<BatchResponse> {
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      LLMBatch.logger.error`OpenRouter Batch API error during ${action}: status=${response.status} body=${errorText}`;
      if (response.status === 429) {
        throw Oops.Block.AIModelRateLimited('openrouter:batch', { cause: new Error(errorText) });
      }
      throw Oops.Panic.ExternalService('openrouter', `Batch API ${action} failed (${response.status}): ${errorText}`, {
        cause: new Error(errorText),
      });
    }

    const json = await response.json().catch((err: unknown) => {
      throw Oops.Panic.ExternalService('openrouter', 'Failed to parse OpenRouter Batch response as JSON', {
        cause: err,
      });
    });

    const parsed = BatchResponseSchema.safeParse(json);
    if (!parsed.success) {
      LLMBatch.logger.error`Invalid OpenRouter Batch response schema: ${JSON.stringify(parsed.error.issues)}`;
      throw Oops.Panic.ExternalService('openrouter', 'OpenRouter returned invalid Batch response structure', {
        cause: parsed.error,
      });
    }

    return parsed.data;
  }
}

/**
 * 對外等價別名，明確表達 OpenRouter Batch 實現
 */
export const OpenRouterBatchClient = LLMBatch;
