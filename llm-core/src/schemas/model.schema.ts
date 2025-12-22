/**
 * 可扩展的 Model Zod Schema
 *
 * 设计意图：
 * - 使用 z.custom 实现动态验证
 * - 验证时读取运行时 Registry
 * - 项目层注册新 Model 后自动生效
 */

import { z } from 'zod';
import { isModelRegistered, getRegisteredModels, type LLMModelKey } from '../types/model.types';

/**
 * 动态 Model Schema
 *
 * 验证值是否为已注册的 Model Key
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
 * 创建 Model Schema 的工厂函数（如需自定义错误消息）
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
