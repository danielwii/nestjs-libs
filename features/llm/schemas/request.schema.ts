/**
 * LLM Request/Response Zod Schemas
 */

import { LLMModelKeySchema } from './model.schema';

import { z } from 'zod';

// ==================== 消息 Schema ====================

export const LLMMessageRoleSchema = z.enum(['system', 'user', 'assistant']);

export const LLMMessageSchema = z.object({
  role: LLMMessageRoleSchema,
  content: z.string(),
});

// ==================== Reasoning Schema ====================

export const ReasoningEffortSchema = z.enum(['low', 'medium', 'high']);

export const LLMReasoningOptionsSchema = z.object({
  effort: ReasoningEffortSchema.optional(),
  maxTokens: z.number().positive().optional(),
  exclude: z.boolean().optional(),
  enabled: z.boolean().optional(),
  extra: z
    .object({
      google: z
        .object({
          thinkingBudget: z.number().positive().optional(),
        })
        .optional(),
      openrouter: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

// ==================== Request Schema ====================

export const LLMRequestSchema = z.object({
  messages: z.array(LLMMessageSchema),
  model: LLMModelKeySchema,
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().positive().optional(),
  topP: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
  system: z.string().optional(),
  reasoning: LLMReasoningOptionsSchema.optional(),
});

// ==================== Usage Schema ====================

export const LLMUsageSchema = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  cost: z.number().optional(),
  costDetails: z.unknown().optional(),
});

// ==================== Response Schema ====================

export const LLMResponseSchema = z.object({
  content: z.string(),
  usage: LLMUsageSchema.optional(),
  finishReason: z.string().optional(),
});

// ==================== 类型推导 ====================

export type LLMRequestInput = z.input<typeof LLMRequestSchema>;
export type LLMRequestOutput = z.output<typeof LLMRequestSchema>;
