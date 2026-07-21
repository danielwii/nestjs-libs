/**
 * Gemini 3.6 Flash provider capability evidence.
 *
 * Not run in CI. Execute with real credentials:
 * ```bash
 * doppler run -p unee-server -c stg -- env LLM_LIVE_TEST=1 \
 *   bun test features/llm/clients/gemini-3.6-flash.live.spec.ts
 * ```
 *
 * The raw OpenRouter call intentionally bypasses the registry fallback so a future
 * provider capability change (effort:none becomes legal) makes the evidence test fail.
 */

import 'reflect-metadata';

import { LLM } from './llm.class';

import { describe, expect, it } from 'bun:test';

const LIVE = process.env.LLM_LIVE_TEST === '1';
const OPENROUTER_API_KEY = process.env.AI_OPENROUTER_API_KEY;
const HAS_OPENROUTER_KEY = !!OPENROUTER_API_KEY?.trim();
const HAS_VERTEX_KEY = !!process.env.AI_GOOGLE_VERTEX_API_KEY?.trim();
const describeOpenRouterLive = LIVE && HAS_OPENROUTER_KEY ? describe : describe.skip;
const describeVertexLive = LIVE && HAS_VERTEX_KEY ? describe : describe.skip;

const OPENROUTER_MODEL_ID = 'google/gemini-3.6-flash';

function getReasoningTokens(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0;
  const details = (usage as { outputTokenDetails?: unknown }).outputTokenDetails;
  if (!details || typeof details !== 'object') return 0;
  const value = (details as { reasoningTokens?: unknown }).reasoningTokens;
  return typeof value === 'number' ? value : 0;
}

describeOpenRouterLive('OpenRouter Gemini 3.6 Flash reasoning capability (live)', () => {
  it('rejects a raw no-thinking request because reasoning is mandatory', async () => {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'X-Title': 'nestjs-libs live capability probe',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL_ID,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 48,
        reasoning: { enabled: false, effort: 'none' },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();

    console.log(`[gemini-3.6-live] openrouter no-thinking status=${response.status} body=${body.slice(0, 240)}`);
    expect(response.status).toBe(400);
    expect(body).toMatch(/reasoning is mandatory|cannot be disabled/i);
  }, 45_000);

  it('maps LLM thinking=none to low and remains invocable', async () => {
    const result = await LLM.generateText({
      id: 'gemini-3.6-openrouter-live-param-fallback',
      model: 'openrouter:gemini-3.6-flash',
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      thinking: 'none',
      maxOutputTokens: 256,
      maxRetries: 0,
      timeout: 30_000,
    });

    console.log(
      `[gemini-3.6-live] openrouter fallback text=${JSON.stringify(result.text)} usage=${JSON.stringify(result.usage)}`,
    );
    expect(result.text.trim().length).toBeGreaterThan(0);
    expect(getReasoningTokens(result.usage)).toBeGreaterThan(0);
  }, 45_000);
});

describeVertexLive('direct Vertex Gemini 3.6 Flash reasoning capability (live)', () => {
  it('supports true no-thinking while low thinking still emits reasoning tokens', async () => {
    const noThinking = await LLM.generateText({
      id: 'gemini-3.6-vertex-live-no-thinking',
      model: 'vertex:gemini-3.6-flash',
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      thinking: 'none',
      maxOutputTokens: 256,
      maxRetries: 0,
      timeout: 30_000,
    });
    const lowThinking = await LLM.generateText({
      id: 'gemini-3.6-vertex-live-low-thinking',
      model: 'vertex:gemini-3.6-flash',
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      thinking: 'low',
      maxOutputTokens: 256,
      maxRetries: 0,
      timeout: 30_000,
    });

    const noThinkingTokens = getReasoningTokens(noThinking.usage);
    const lowThinkingTokens = getReasoningTokens(lowThinking.usage);
    console.log(
      `[gemini-3.6-live] vertex noThinkingReasoning=${noThinkingTokens} lowThinkingReasoning=${lowThinkingTokens}`,
    );

    expect(noThinking.text.trim().length).toBeGreaterThan(0);
    expect(noThinkingTokens).toBe(0);
    expect(lowThinking.text.trim().length).toBeGreaterThan(0);
    expect(lowThinkingTokens).toBeGreaterThan(0);
  }, 60_000);
});
