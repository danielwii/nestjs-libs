import { z } from 'zod';

/**
 * OpenRouter Batch API 單條 Message 結構
 */
export const BatchMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z
      .union([z.string(), z.array(z.any())])
      .nullable()
      .optional(),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.any()).optional(),
  })
  .loose()
  .refine(
    (msg) => {
      // 1. 只有 assistant 且提供非空 tool_calls 陣列時，content 才允許為 null 或省略
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        return true;
      }
      // 2. 其餘所有情況（user, system, tool 以及無 tool_calls 的 assistant），content 必須存在且不能為 null
      return msg.content !== undefined && msg.content !== null;
    },
    {
      message: 'content is required unless assistant message provides tool_calls',
      path: ['content'],
    },
  );

/**
 * OpenRouter Batch API 單條 Request Body 結構
 */
export const BatchRequestBodySchema = z
  .object({
    model: z.string().optional(),
    messages: z.array(BatchMessageSchema).min(1, 'messages cannot be empty'),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().optional(),
    response_format: z.any().optional(),
    reasoning: z.any().optional(),
    tools: z.array(z.any()).optional(),
    tool_choice: z.any().optional(),
  })
  .loose();

/**
 * OpenRouter Batch API 單條 Request Item 結構
 */
export const BatchRequestItemSchema = z.object({
  custom_id: z.string().min(1, 'custom_id cannot be empty'),
  body: BatchRequestBodySchema,
});

/**
 * 建立 Batch 作業的入參契約
 */
export const CreateBatchParamsSchema = z.object({
  model: z.string().trim().min(1, 'model cannot be empty'),
  endpoint: z.string().default('/v1/chat/completions'),
  requests: z.array(BatchRequestItemSchema).min(1, 'requests cannot be empty'),
});

/**
 * Batch 請求計數統計
 */
export const BatchRequestCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
});

/**
 * Batch 單條產物結構 (內聯於 completed 響應中)
 */
export const BatchResultItemSchema = z
  .object({
    custom_id: z.string(),
    response: z.any().optional(),
    error: z.any().optional(),
  })
  .loose();

/**
 * Batch 作業生命週期狀態
 */
export const BatchStatusSchema = z.enum([
  'validating',
  'in_progress',
  'finalizing',
  'completed',
  'failed',
  'expired',
  'cancelling',
  'cancelled',
]);

/**
 * OpenRouter Batch 遠端響應契約 (單一真理源)
 */
export const BatchResponseSchema = z
  .object({
    id: z.string(),
    object: z.string().optional(),
    endpoint: z.string().optional(),
    model: z.string().optional(),
    status: BatchStatusSchema,
    created_at: z.number().optional(),
    expires_at: z.number().optional(),
    request_counts: BatchRequestCountsSchema.optional(),
    results: z.array(BatchResultItemSchema).optional(),
    errors: z.array(z.any()).optional(),
  })
  .loose();

// 靜態型別完全由契約逆向派生
export type BatchMessage = z.infer<typeof BatchMessageSchema>;
export type BatchRequestBody = z.infer<typeof BatchRequestBodySchema>;
export type BatchRequestItem = z.infer<typeof BatchRequestItemSchema>;
export type CreateBatchParams = z.input<typeof CreateBatchParamsSchema>;
export type BatchRequestCounts = z.infer<typeof BatchRequestCountsSchema>;
export type BatchResultItem = z.infer<typeof BatchResultItemSchema>;
export type BatchStatus = z.infer<typeof BatchStatusSchema>;
export type BatchResponse = z.infer<typeof BatchResponseSchema>;
