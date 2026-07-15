import type { OpenTelemetryOptions } from '@ai-sdk/otel';
import type { Telemetry } from 'ai';

export type AiSdkOtelPackageName = 'ai' | '@ai-sdk/otel';

export type AiSdkOtelRegistrationResult =
  | { status: 'registered' }
  | { status: 'already_registered' }
  | { status: 'dependency_missing'; packageName: AiSdkOtelPackageName }
  | { status: 'failed'; error: unknown };

export interface AiSdkOtelRegistrationOptions {
  globals?: Record<PropertyKey, unknown>;
  load?: (packageName: AiSdkOtelPackageName) => unknown;
}

export const AI_SDK_OTEL_REGISTERED = Symbol.for('@danielwii/nestjs-libs/ai-sdk-otel-registered');

export const AI_SDK_OTEL_OPTIONS = {
  runtimeContext: true,
  usage: true,
  providerMetadata: true,
} satisfies OpenTelemetryOptions;

type RegisterTelemetry = (...integrations: Telemetry[]) => void;
type OpenTelemetryConstructor = new (options?: OpenTelemetryOptions) => Telemetry;

function defaultLoad(packageName: AiSdkOtelPackageName): unknown {
  if (packageName === 'ai') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional runtime dependency
    return require('ai');
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional runtime dependency
  return require('@ai-sdk/otel');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isMissingOptionalPackage(error: unknown, packageName: AiSdkOtelPackageName): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const code = 'code' in error ? error.code : undefined;
  if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND') return false;

  const message = 'message' in error ? error.message : undefined;
  if (typeof message !== 'string') return false;

  const quotedPackage = escapeRegExp(packageName);
  return new RegExp(`(?:module|package) ['"]${quotedPackage}['"]`, 'i').test(message);
}

function readRegisterTelemetry(moduleValue: unknown): RegisterTelemetry {
  if (typeof moduleValue !== 'object' || moduleValue === null || !('registerTelemetry' in moduleValue)) {
    throw new TypeError("Package 'ai' does not export registerTelemetry");
  }

  const candidate = moduleValue.registerTelemetry;
  if (typeof candidate !== 'function') {
    throw new TypeError("Package 'ai' export registerTelemetry is not callable");
  }
  return candidate as RegisterTelemetry;
}

function readOpenTelemetryConstructor(moduleValue: unknown): OpenTelemetryConstructor {
  if (typeof moduleValue !== 'object' || moduleValue === null || !('OpenTelemetry' in moduleValue)) {
    throw new TypeError("Package '@ai-sdk/otel' does not export OpenTelemetry");
  }

  const candidate = moduleValue.OpenTelemetry;
  if (typeof candidate !== 'function') {
    throw new TypeError("Package '@ai-sdk/otel' export OpenTelemetry is not constructable");
  }
  return candidate as OpenTelemetryConstructor;
}

function loadOptionalPackage(
  load: (packageName: AiSdkOtelPackageName) => unknown,
  packageName: AiSdkOtelPackageName,
): { ok: true; value: unknown } | { ok: false; result: AiSdkOtelRegistrationResult } {
  try {
    return { ok: true, value: load(packageName) };
  } catch (error) {
    if (isMissingOptionalPackage(error, packageName)) {
      return { ok: false, result: { status: 'dependency_missing', packageName } };
    }
    return { ok: false, result: { status: 'failed', error } };
  }
}

/** Register exactly one process-global AI SDK v7 OpenTelemetry integration. */
export function registerAiSdkOtel(options: AiSdkOtelRegistrationOptions = {}): AiSdkOtelRegistrationResult {
  const globals: Record<PropertyKey, unknown> = options.globals ?? globalThis;
  if (globals[AI_SDK_OTEL_REGISTERED] === true) {
    return { status: 'already_registered' };
  }

  const load = options.load ?? defaultLoad;
  const aiModule = loadOptionalPackage(load, 'ai');
  if (!aiModule.ok) return aiModule.result;

  const otelModule = loadOptionalPackage(load, '@ai-sdk/otel');
  if (!otelModule.ok) return otelModule.result;

  try {
    const registerTelemetry = readRegisterTelemetry(aiModule.value);
    const OpenTelemetry = readOpenTelemetryConstructor(otelModule.value);
    registerTelemetry(new OpenTelemetry(AI_SDK_OTEL_OPTIONS));
    globals[AI_SDK_OTEL_REGISTERED] = true;
    return { status: 'registered' };
  } catch (error) {
    return { status: 'failed', error };
  }
}
