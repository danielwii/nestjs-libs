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

describe('instrument.ts preload with SENTRY_DSN enabled (Sentry error-only & multimodal OOM regression)', () => {
  it('disables Sentry spans/VercelAI integration and never JSON.stringifies Uint8Array image bytes during LLM.generateObject', () => {
    const probeScript = `
      import * as Sentry from '@sentry/bun';
      import * as core from '@sentry/core';
      import { z } from 'zod';
      import { LLM } from './features/llm/clients/llm.class';

      const client = Sentry.getClient();
      if (!client) {
        throw new Error('Expected Sentry client to be initialized by instrument.ts preload');
      }

      const origStringify = JSON.stringify;
      let maxStringifyLen = 0;
      let sawByteExpansion = false;
      JSON.stringify = function (...args: Parameters<typeof JSON.stringify>) {
        const res = origStringify.apply(this, args);
        if (typeof res === 'string') {
          if (res.length > maxStringifyLen) maxStringifyLen = res.length;
          if (res.length > 1_000_000 && res.includes('{"0":')) {
            sawByteExpansion = true;
          }
        }
        return res;
      } as typeof JSON.stringify;

      let authHeader: string | null = null;
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        authHeader = headers.get('authorization');
        return new Response(
          origStringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 1700000000,
            model: 'google/gemini-2.5-flash',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '{"ok":true}',
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch;

      const { object } = await LLM.generateObject({
        id: 'sentry-preload-4img',
        model: 'openrouter:gemini-2.5-flash',
        schema: z.object({ ok: z.boolean() }),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Inspect 4 images' },
              { type: 'image', image: new Uint8Array(1_500_000).fill(200) },
              { type: 'image', image: new Uint8Array(1_500_000).fill(201) },
              { type: 'image', image: new Uint8Array(1_500_000).fill(202) },
              { type: 'image', image: new Uint8Array(1_500_000).fill(203) },
            ],
          },
        ],
      });

      console.log(origStringify({
        ok: object.ok,
        authHeader,
        hasSpansEnabled: core.hasSpansEnabled(),
        hasVercelAI: client.getIntegrationByName('VercelAI') !== undefined,
        sawByteExpansion,
        maxStringifyLen,
      }));
      process.exit(0);
    `;

    const proc = Bun.spawnSync(['bun', '--preload', './instrument.ts', '-e', probeScript], {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        SENTRY_DSN: 'https://public@sentry.example.com/1',
        AI_OPENROUTER_API_KEY: 'sk-or-test-key',
        OTEL_LOG_LEVEL: 'NONE',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = proc.stdout.toString().trim();
    const stderr = proc.stderr.toString().trim();
    if (proc.exitCode !== 0) {
      throw new Error(`Preload probe failed (exit=${proc.exitCode}):\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
    }

    const lastLine = stdout.split('\n').at(-1) ?? '';
    const result = JSON.parse(lastLine) as {
      ok: boolean;
      authHeader: string | null;
      hasSpansEnabled: boolean;
      hasVercelAI: boolean;
      sawByteExpansion: boolean;
      maxStringifyLen: number;
    };

    expect(result.ok).toBe(true);
    expect(result.authHeader).toBe('Bearer sk-or-test-key');
    expect(result.hasSpansEnabled).toBe(false);
    expect(result.hasVercelAI).toBe(false);
    expect(result.sawByteExpansion).toBe(false);
    // OpenRouter HTTP request body encodes 4 * 1.5MB as base64 (~8MB), far below the 76.9M-char byte-indexed expansion
    expect(result.maxStringifyLen).toBeLessThan(15_000_000);
  });
});
