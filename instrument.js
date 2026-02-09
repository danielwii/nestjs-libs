/**
 * OpenTelemetry Instrumentation (preload)
 *
 * 共享的 OpenTelemetry 初始化脚本，放在 nestjs-libs 中统一管理。
 *
 * 使用方式：
 *   bun --preload ./libs/instrument.js src/main.ts
 *
 * 功能：
 * - HTTP 请求自动 tracing
 * - gRPC 请求自动 tracing + traceparent 传播
 * - 可选：Langfuse span 导出（AI 相关 span）
 * - 可选：Sentry 错误追踪
 *
 * gRPC Trace 传播机制：
 * - 客户端通过 gRPC metadata 传递 traceparent header
 * - 格式：00-{traceId}-{spanId}-{flags}（W3C Trace Context 标准）
 * - GrpcInstrumentation 自动解析并创建 span
 * - 服务端通过 trace.getSpan(context.active()) 获取当前 span
 *
 * 环境变量：
 * - OTEL_LOG_LEVEL: OpenTelemetry 日志级别（设为 NONE 禁用）
 * - LANGFUSE_ENABLED: 启用 Langfuse（需要 @langfuse/otel）
 * - LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL: Langfuse 配置
 * - SENTRY_DSN: Sentry DSN（启用错误追踪）
 *
 * 注意事项：
 * - 必须在 NestJS 启动前加载（使用 --preload）
 * - 使用 connectMicroservice 时需要 { inheritAppConfig: true } 使全局 interceptors 生效
 */

// Suppress noisy Node.js warnings from third-party libraries
const originalEmit = process.emit;
process.emit = function (event, ...args) {
  if (event === 'warning') {
    const warning = args[0];
    if (warning?.name === 'DeprecationWarning' || warning?.name === 'TimeoutNegativeWarning') {
      return false;
    }
  }
  return originalEmit.apply(process, [event, ...args]);
};

const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { GrpcInstrumentation } = require('@opentelemetry/instrumentation-grpc');
const { BatchSpanProcessor, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-node');
const { getStringFromEnv } = require('@opentelemetry/core');
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { diag } = require('@opentelemetry/api');

const pid = process.pid;
const LOG_NAMESPACE = `[${pid}]instrument.js[${process.env.NODE_ENV}]`;

// Try to load optional Langfuse processor
let LangfuseSpanProcessor = null;
try {
  LangfuseSpanProcessor = require('@langfuse/otel').LangfuseSpanProcessor;
} catch {
  // Langfuse not installed, skip
}

/**
 * Minimal exporter for development
 * Creates spans for traceId generation but produces no output
 */
class MinimalSpanExporter {
  export(spans, resultCallback) {
    resultCallback({ code: 0 });
  }
  shutdown() {
    return Promise.resolve();
  }
}

function configureDiagLogLevel() {
  const logLevel = getStringFromEnv('OTEL_LOG_LEVEL');
  if (logLevel && logLevel.toUpperCase() === 'NONE') {
    if (typeof diag.disable === 'function') {
      diag.disable();
    }
  }
}

function createLangfuseProcessor() {
  const enabled = getStringFromEnv('LANGFUSE_ENABLED');
  if (enabled !== 'true') return null;
  if (!LangfuseSpanProcessor) {
    console.warn(`${LOG_NAMESPACE}: [Langfuse] @langfuse/otel not available`);
    return null;
  }

  const publicKey = getStringFromEnv('LANGFUSE_PUBLIC_KEY');
  const secretKey = getStringFromEnv('LANGFUSE_SECRET_KEY');
  const baseUrl = getStringFromEnv('LANGFUSE_BASE_URL') || getStringFromEnv('LANGFUSE_BASEURL');
  if (!publicKey || !secretKey || !baseUrl) {
    console.warn(`${LOG_NAMESPACE}: [Langfuse] missing credentials`);
    return null;
  }

  const environmentTag = getStringFromEnv('LANGFUSE_TRACING_ENVIRONMENT') ?? process.env.NODE_ENV ?? 'dev';
  console.log(`${LOG_NAMESPACE}: [Langfuse] enabled host=${baseUrl} env=${environmentTag}`);

  // Only export AI-related spans (scope='ai')
  const shouldExportSpan = ({ otelSpan }) => {
    const scope = typeof otelSpan?.instrumentationScope?.name === 'string' ? otelSpan.instrumentationScope.name : '';
    const spanName = otelSpan?.name || 'unknown';
    const traceId = otelSpan?.spanContext?.()?.traceId ?? otelSpan?._spanContext?.traceId ?? '';
    const shouldExport = scope === 'ai';
    if (shouldExport) {
      console.log(`[DEBUG:OTEL] [${traceId}] span name=${spanName} scope=${scope} export=true`);
    }
    return shouldExport;
  };

  return new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl, shouldExportSpan });
}

function initializeSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log(`${LOG_NAMESPACE}: [Sentry] skipped (SENTRY_DSN not set)`);
    return;
  }

  try {
    const Sentry = require('@sentry/nestjs');
    console.log(`${LOG_NAMESPACE}: [Sentry] enabled`);

    const release = process.env.SENTRY_RELEASE ?? process.env.RENDER_GIT_COMMIT ?? process.env.GITHUB_SHA;
    const environment = process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV;

    const noisyPatterns = [
      /MISSING_ENV_FILE/i,
      /injecting env/i,
      /#shutdownTracing/,
      /TimeoutNegativeWarning/,
      /DeprecationWarning/,
    ];

    Sentry.init({
      enabled: process.env.NODE_ENV === 'production',
      dsn,
      sendDefaultPii: true,
      release,
      environment,
      tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,
      skipOpenTelemetrySetup: true,
      ignoreTransactions: [/^GET \/$/, /^GET \/health$/, /^GET \/api$/, /^handle.*Cron$/],
      beforeSend(event) {
        const message = event?.message || event?.logentry?.formatted || event?.logentry?.message;
        const exceptionValues = event?.exception?.values ?? [];
        const exceptionTexts = exceptionValues.map((v) => [v.type, v.value].filter(Boolean).join(':')).filter(Boolean);

        const haystack = [message, ...exceptionTexts].filter(Boolean).join('\n');
        if (haystack && noisyPatterns.some((pattern) => pattern.test(haystack))) {
          return null;
        }
        return event;
      },
      integrations: [Sentry.captureConsoleIntegration({ levels: ['error'] })],
    });
  } catch (error) {
    console.error(`${LOG_NAMESPACE}: [Sentry] init failed`, error);
  }
}

function bootstrapTracing() {
  configureDiagLogLevel();

  const langfuseProcessor = createLangfuseProcessor();
  const spanProcessors = [];

  if (langfuseProcessor) spanProcessors.push(langfuseProcessor);

  // Add minimal exporter if no exporters configured (enables traceId in logs)
  if (spanProcessors.length === 0) {
    console.log(`${LOG_NAMESPACE}: [OpenTelemetry] dev mode (minimal exporter)`);
    spanProcessors.push(new SimpleSpanProcessor(new MinimalSpanExporter()));
  }

  // HTTP + gRPC instrumentation
  // - HttpInstrumentation: HTTP 请求自动 tracing
  // - GrpcInstrumentation: gRPC 请求自动 tracing + traceparent 传播
  const instrumentations = [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req) => {
        const url = req.url || '';
        return url === '/' || url === '/health' || url.startsWith('/health');
      },
    }),
    new GrpcInstrumentation(),
  ];

  const sdk = new NodeSDK({
    spanProcessors,
    instrumentations,
    autoDetectResources: false,
    resourceDetectors: [],
  });

  try {
    sdk.start();
    console.info(`${LOG_NAMESPACE}: [OpenTelemetry] started (HTTP + gRPC instrumentation)`);
  } catch (error) {
    console.error(`${LOG_NAMESPACE}: [OpenTelemetry] failed`, error);
    return;
  }

  const shutdown = async () => {
    try {
      await sdk.shutdown();
      console.debug(`${LOG_NAMESPACE}: [OpenTelemetry] shutdown complete`);
    } catch (error) {
      console.error(`${LOG_NAMESPACE}: [OpenTelemetry] shutdown failed`, error);
    }
  };

  process.on('SIGTERM', () => void shutdown());
  process.once('beforeExit', () => void shutdown());

  // Expose flush function globally for CLI usage
  // CLI 需要在 process.exit() 前调用此方法确保 spans 发送到 Langfuse
  globalThis.__otelFlush = async () => {
    try {
      await sdk.shutdown();
      console.debug(`${LOG_NAMESPACE}: [OpenTelemetry] flush complete`);
    } catch (error) {
      console.error(`${LOG_NAMESPACE}: [OpenTelemetry] flush failed`, error);
    }
  };

  initializeSentry();
}

bootstrapTracing();
