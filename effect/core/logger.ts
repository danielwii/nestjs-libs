/**
 * Effect Logger 层
 *
 * 设计意图：
 * - 替代 LogTape 的手动配置
 * - Effect Logger 自带 Fiber 上下文传播，span/traceId 自动附加
 * - Dev 用 pretty print，Prod 用 JSON lines
 *
 * 优势：
 * - 无需 lazy() hack 注入 traceId（Effect Fiber 自动携带）
 * - 通过 Layer 组合控制日志级别，无需全局状态
 */

import { Effect, Layer, Logger, LogLevel } from 'effect';

// ==================== Log Level 映射 ====================

/** 应用配置的 LOG_LEVEL → Effect LogLevel */
const parseLogLevel = (level: string): LogLevel.LogLevel => {
  switch (level) {
    case 'verbose':
    case 'debug':
      return LogLevel.Debug;
    case 'log':
      return LogLevel.Info;
    case 'warn':
      return LogLevel.Warning;
    case 'error':
      return LogLevel.Error;
    case 'fatal':
      return LogLevel.Fatal;
    default:
      return LogLevel.Debug;
  }
};

// ==================== Logger Layer ====================

/**
 * Dev logger: structured + pretty printed
 *
 * 自动包含 timestamp、fiber ID、span context
 */
export const DevLoggerLayer = Logger.replace(Logger.defaultLogger, Logger.prettyLogger());

/**
 * Prod logger: JSON lines for log aggregation
 *
 * 便于 Grafana Loki / CloudWatch / Datadog 解析
 */
export const ProdLoggerLayer = Logger.replace(Logger.defaultLogger, Logger.jsonLogger);

/**
 * 根据 NODE_ENV 选择 logger
 *
 * - production → JSON lines
 * - 其他 → pretty print
 */
export const AppLoggerLayer = Layer.unwrapEffect(
  Effect.sync(() => {
    const isProd = process.env.NODE_ENV === 'production';
    return isProd ? ProdLoggerLayer : DevLoggerLayer;
  }),
);

/**
 * 设置最低日志级别的 Layer
 */
export const logLevelLayer = (level: string): Layer.Layer<never> => Logger.minimumLogLevel(parseLogLevel(level));

/**
 * 完整的日志层：logger + 日志级别
 */
export const FullLoggerLayer = (level?: string): Layer.Layer<never> => {
  const effectiveLevel = level ?? process.env.LOG_LEVEL ?? 'debug';
  return Layer.merge(AppLoggerLayer, logLevelLayer(effectiveLevel));
};
