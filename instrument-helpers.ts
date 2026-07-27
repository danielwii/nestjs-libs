/**
 * Pure helpers shared by `instrument.ts` and `instrument.spec.ts`.
 *
 * Kept in a side-effect-free module so the spec can import directly — the main
 * `instrument.ts` runs Sentry/NodeSDK bootstrap on import and is not safe to
 * load from tests.
 */

/**
 * Span scope matchers that are not default LLM telemetry but remain useful for
 * cross-service trace correlation in Langfuse. Opt-in via
 * LANGFUSE_EXPORT_FULL_STACK=true.
 *
 * Coverage:
 * - `@opentelemetry/instrumentation-grpc` — auto-registered by instrument.ts
 *   when the package is installed.
 * - `@opentelemetry/instrumentation-http` — auto-registered by instrument.ts
 *   when `APP_OTEL_HTTP_INSTRUMENTATION_ENABLED=true` and the package is installed.
 * - `prisma` / `@prisma/*` — **NOT auto-registered.** The host app creates these
 *   spans, either via manual `trace.getTracer('prisma')` or by registering
 *   `@opentelemetry/instrumentation-prisma`. The scope string differs between
 *   mechanisms — accept both via prefix match.
 */
export function isFullStackExtraScope(scope: string): boolean {
  return (
    scope === '@opentelemetry/instrumentation-grpc' ||
    scope === '@opentelemetry/instrumentation-http' ||
    scope === 'prisma' ||
    scope.startsWith('@prisma/')
  );
}

/** Default AI and chat OpenTelemetry scopes exported to Langfuse. */
export function isDefaultLangfuseLlmScope(scope: string): boolean {
  return scope === 'gen_ai' || scope === 'ai' || scope === 'chat';
}

/**
 * Resolve the one supported Langfuse endpoint setting.
 *
 * The removed spelling is an input contract violation, not a fallback source:
 * accepting it here would keep configuration drift invisible during startup.
 */
export function resolveLangfuseBaseUrl(
  baseUrl: string | undefined,
  removedBaseUrl: string | undefined,
): string | undefined {
  if (removedBaseUrl !== undefined) {
    throw new Error('LANGFUSE_BASEURL has been removed; use LANGFUSE_BASE_URL');
  }

  return baseUrl;
}

export interface AiSdkOtelMissingDependencyDiagnostic {
  severity: 'debug' | 'warning';
  message: string;
}

/** Make a missing optional AI integration visible when Langfuse depends on it. */
export function resolveAiSdkOtelMissingDependencyDiagnostic(
  packageName: string,
  langfuseActive: boolean,
): AiSdkOtelMissingDependencyDiagnostic {
  const message = `AI SDK OTel integration skipped because ${packageName} is not installed`;

  if (!langfuseActive) {
    return { severity: 'debug', message };
  }

  return {
    severity: 'warning',
    message: `${message}; Langfuse is active, but AI SDK LLM spans from this integration will not be produced or exported`,
  };
}
