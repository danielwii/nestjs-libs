/**
 * Unit tests for helpers in `instrument-helpers.ts`.
 *
 * `instrument.ts` runs side effects on import (NodeSDK + Sentry bootstrap), so
 * pure logic worth testing lives in `instrument-helpers.ts` and is imported
 * here directly — single source of truth, no drift risk.
 */

import {
  isDefaultLangfuseLlmScope,
  isFullStackExtraScope,
  resolveAiSdkOtelMissingDependencyDiagnostic,
  resolveLangfuseBaseUrl,
} from './instrument-helpers';

import { describe, expect, it } from 'bun:test';

describe('isFullStackExtraScope', () => {
  it('matches the gRPC instrumentation scope', () => {
    expect(isFullStackExtraScope('@opentelemetry/instrumentation-grpc')).toBe(true);
  });

  it('matches the HTTP instrumentation scope', () => {
    expect(isFullStackExtraScope('@opentelemetry/instrumentation-http')).toBe(true);
  });

  it('matches the manual prisma tracer scope', () => {
    expect(isFullStackExtraScope('prisma')).toBe(true);
  });

  it('matches @prisma/* scope prefix (instrumentation package variants)', () => {
    expect(isFullStackExtraScope('@prisma/instrumentation')).toBe(true);
    expect(isFullStackExtraScope('@prisma/client')).toBe(true);
  });

  it('rejects unknown / AI / arbitrary scopes', () => {
    expect(isFullStackExtraScope('')).toBe(false);
    expect(isFullStackExtraScope('ai')).toBe(false);
    expect(isFullStackExtraScope('@nestjs/common')).toBe(false);
    expect(isFullStackExtraScope('app')).toBe(false);
    expect(isFullStackExtraScope('@opentelemetry/sdk-node')).toBe(false);
  });
});

describe('isDefaultLangfuseLlmScope', () => {
  it('matches AI SDK GenAI and custom AI/chat telemetry scopes', () => {
    expect(isDefaultLangfuseLlmScope('gen_ai')).toBe(true);
    expect(isDefaultLangfuseLlmScope('ai')).toBe(true);
    expect(isDefaultLangfuseLlmScope('chat')).toBe(true);
  });

  it('rejects non-LLM telemetry scopes', () => {
    expect(isDefaultLangfuseLlmScope('')).toBe(false);
    expect(isDefaultLangfuseLlmScope('@opentelemetry/instrumentation-http')).toBe(false);
    expect(isDefaultLangfuseLlmScope('prisma')).toBe(false);
  });
});

describe('resolveLangfuseBaseUrl', () => {
  it('returns the canonical setting', () => {
    expect(resolveLangfuseBaseUrl('https://langfuse.example.com', undefined)).toBe('https://langfuse.example.com');
  });

  it('returns undefined when the canonical setting is absent', () => {
    expect(resolveLangfuseBaseUrl(undefined, undefined)).toBeUndefined();
  });

  it('rejects the removed setting instead of treating it as a fallback', () => {
    expect(() => resolveLangfuseBaseUrl(undefined, 'https://legacy.example.com')).toThrow(
      'LANGFUSE_BASEURL has been removed; use LANGFUSE_BASE_URL',
    );
  });

  it('rejects ambiguous configuration when both spellings are present', () => {
    expect(() => resolveLangfuseBaseUrl('https://langfuse.example.com', 'https://legacy.example.com')).toThrow(
      'LANGFUSE_BASEURL has been removed; use LANGFUSE_BASE_URL',
    );
  });
});

describe('resolveAiSdkOtelMissingDependencyDiagnostic', () => {
  it('keeps an optional missing integration at debug when Langfuse is inactive', () => {
    expect(resolveAiSdkOtelMissingDependencyDiagnostic('@ai-sdk/otel', false)).toEqual({
      severity: 'debug',
      message: 'AI SDK OTel integration skipped because @ai-sdk/otel is not installed',
    });
  });

  it('warns that LLM spans are unavailable when Langfuse is active', () => {
    expect(resolveAiSdkOtelMissingDependencyDiagnostic('@ai-sdk/otel', true)).toEqual({
      severity: 'warning',
      message:
        'AI SDK OTel integration skipped because @ai-sdk/otel is not installed; Langfuse is active, but AI SDK LLM spans from this integration will not be produced or exported',
    });
  });
});
