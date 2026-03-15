/**
 * Effect Config 层
 *
 * 设计意图：
 * - 用 Schema.Config 替代 class-validator 的环境变量验证
 * - Schema 验证 + 类型推断 + 结构化错误消息
 * - 与 HttpApi 的 Schema 体系统一
 *
 * 与 NestJS 版 AppEnvs 的区别：
 * - NestJS：class-validator 装饰器 + plainToInstance，运行时验证
 * - Effect：Schema.Config，启动时 Layer 构建失败即报错（fail fast）
 *
 * 用法：
 * ```ts
 * // 单个配置
 * const port = yield* Port;
 *
 * // 组合配置
 * const { port, nodeEnv } = yield* AppConfig;
 * ```
 */

import { Config, Effect, Redacted, Schema } from 'effect';

import type { ConfigError } from 'effect/ConfigError';

// ==================== 基础配置 ====================

export const NodeEnv = Schema.Config('NODE_ENV', Schema.Literal('development', 'production', 'test')).pipe(
  Config.withDefault('development' as const),
);

export const Env = Schema.Config('ENV', Schema.Literal('prd', 'stg', 'dev')).pipe(Config.withDefault('dev' as const));

export const Port = Schema.Config('PORT', Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, 65535))).pipe(
  Config.withDefault(3100),
);

export const GrpcPort = Schema.Config(
  'GRPC_PORT',
  Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, 65535)),
).pipe(Config.withDefault(50051));

export const LogLevel = Schema.Config(
  'LOG_LEVEL',
  Schema.Literal('verbose', 'debug', 'log', 'warn', 'error', 'fatal'),
).pipe(Config.withDefault('debug' as const));

export const ServiceName = Config.string('SERVICE_NAME').pipe(Config.withDefault('app'));

// ==================== 基础设施配置 ====================

export const DatabaseUrl = Schema.Config('DATABASE_URL', Schema.String.pipe(Schema.nonEmptyString()));

export const RedisUrl = Schema.Config('INFRA_REDIS_URL', Schema.String.pipe(Schema.nonEmptyString())).pipe(
  Config.withDefault('redis://localhost:6379'),
);

// ==================== OpenTelemetry 配置 ====================

export const OtelExporterEndpoint = Config.option(Config.string('OTEL_EXPORTER_OTLP_ENDPOINT'));

export const TracingExporterUrl = Config.option(Config.string('TRACING_EXPORTER_URL'));

// ==================== LLM 配置 ====================

export const AiOpenRouterApiKey = Config.option(Config.map(Config.string('AI_OPENROUTER_API_KEY'), Redacted.make));

export const AiGoogleApiKey = Config.option(Config.map(Config.string('AI_GOOGLE_API_KEY'), Redacted.make));

export const AiOpenAiApiKey = Config.option(Config.map(Config.string('AI_OPENAI_API_KEY'), Redacted.make));

// ==================== Shutdown 配置 ====================

/**
 * Graceful shutdown drain timeout（毫秒）
 *
 * SIGTERM 后 Phase 2（等待已有流量排空）的等待时间。
 * 此期间 HTTP server 仍在运行，in-flight 请求继续处理。
 * 超时后关闭资源（DB、Redis），未完成的请求因连接断开而终止。
 *
 * - 默认 5000ms：适合普通 REST API
 * - AI streaming（诊断/生成）：建议 60000-120000ms
 *
 * K8s terminationGracePeriodSeconds 必须 > 此值 + preStop 时间。
 */
export const ShutdownDrainMs = Schema.Config(
  'SHUTDOWN_DRAIN_MS',
  Schema.NumberFromString.pipe(Schema.int(), Schema.greaterThan(0)),
).pipe(Config.withDefault(5000));

// ==================== 组合配置 ====================

/** 服务器基础配置 */
export const AppConfig = Config.all({
  nodeEnv: NodeEnv,
  env: Env,
  port: Port,
  logLevel: LogLevel,
  serviceName: ServiceName,
});

// ==================== 辅助函数 ====================

/**
 * 从多个 Config 构建一个结果对象
 *
 * Config<A> extends Effect<A, ConfigError>，可以直接 yield*
 *
 * @example
 * ```ts
 * const config = yield* configAll({
 *   port: Port,
 *   dbUrl: DatabaseUrl,
 * })
 * ```
 */
export function configAll<A extends Record<string, Config.Config<unknown>>>(
  configs: A,
): Effect.Effect<{ [K in keyof A]: Config.Config.Success<A[K]> }, ConfigError> {
  const entries = Object.entries(configs);
  if (entries.length === 0) {
    return Effect.succeed({} as { [K in keyof A]: Config.Config.Success<A[K]> });
  }

  return Effect.all(
    Object.fromEntries(entries.map(([k, v]) => [k, v as Effect.Effect<unknown, ConfigError>])),
  ) as Effect.Effect<{ [K in keyof A]: Config.Config.Success<A[K]> }, ConfigError>;
}

/** 判断当前是否为生产环境 */
export const isProduction = Effect.map(NodeEnv as Effect.Effect<string, ConfigError>, (env) => env === 'production');

/** 判断当前是否为测试环境 */
export const isTest = Effect.map(NodeEnv as Effect.Effect<string, ConfigError>, (env) => env === 'test');
