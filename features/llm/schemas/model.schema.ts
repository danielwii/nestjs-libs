/**
 * 可扩展的 Model Zod Schema
 *
 * 设计意图：
 * - 使用 z.custom 实现动态验证
 * - 验证时读取运行时 Registry
 * - 项目层注册新 Model 后自动生效
 */
import { isModelRegistered, isModelSpecValid } from '../types/model.types';

import { z } from 'zod';

import type { LLMModelKey, LLMModelSpec } from '../types/model.types';

/**
 * 严格 Model Key Schema — 不接受带参数的 spec
 */
export const LLMModelKeySchema = z.custom<LLMModelKey>(
  (val): val is LLMModelKey => {
    if (typeof val !== 'string') return false;
    return isModelRegistered(val);
  },
  {
    message: 'Invalid LLM model key',
  },
);

/**
 * Model Spec Schema — 接受 `provider:model` 或 `provider:model?reason=low`
 */
export const LLMModelSpecSchema = z.custom<LLMModelSpec>(
  (val): val is LLMModelSpec => {
    if (typeof val !== 'string') return false;
    return isModelSpecValid(val);
  },
  {
    message: 'Invalid LLM model spec',
  },
);

/**
 * 创建 Model Key Schema 的工厂函数（如需自定义错误消息）
 */
export function createModelKeySchema(options?: { message?: string }) {
  return z.custom<LLMModelKey>(
    (val): val is LLMModelKey => {
      if (typeof val !== 'string') return false;
      return isModelRegistered(val);
    },
    {
      message: options?.message ?? 'Invalid LLM model key',
    },
  );
}

/**
 * 创建 Model Spec Schema 的工厂函数（如需自定义错误消息）
 */
export function createModelSpecSchema(options?: { message?: string }) {
  return z.custom<LLMModelSpec>(
    (val): val is LLMModelSpec => {
      if (typeof val !== 'string') return false;
      return isModelSpecValid(val);
    },
    {
      message: options?.message ?? 'Invalid LLM model spec',
    },
  );
}
