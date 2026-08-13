/**
 * Official July 2026 Vertex route probes.
 *
 * Not run in CI. Execute with credentials already present in the environment:
 * ```bash
 * bun test ./features/llm/clients/vertex.2026-07-models.spec.live.ts
 * ```
 *
 * Express requires AI_GOOGLE_VERTEX_API_KEY. Project/global requires
 * GOOGLE_VERTEX_PROJECT, GOOGLE_VERTEX_LOCATION=global, and either that API key
 * or ambient ADC / service-account credentials.
 *
 * @see https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash-lite
 * @see https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-6-flash
 */

import 'reflect-metadata';

import { LLM } from './llm.class';

import { describe, expect, it } from 'bun:test';

import type { LLMModelKey } from '../types/model.types';

const HAS_VERTEX_KEY = !!process.env.AI_GOOGLE_VERTEX_API_KEY?.trim();
const HAS_VERTEX_GLOBAL_CONFIG =
  !!process.env.GOOGLE_VERTEX_PROJECT?.trim() && (process.env.GOOGLE_VERTEX_LOCATION ?? 'global') === 'global';
const describeVertexLive = HAS_VERTEX_KEY ? describe : describe.skip;
const describeVertexGlobalLive = HAS_VERTEX_GLOBAL_CONFIG ? describe : describe.skip;

function getReasoningTokens(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0;
  const details = (usage as { outputTokenDetails?: unknown }).outputTokenDetails;
  if (!details || typeof details !== 'object') return 0;
  const value = (details as { reasoningTokens?: unknown }).reasoningTokens;
  return typeof value === 'number' ? value : 0;
}

async function expectInvocable(model: LLMModelKey, expectNoThinking = false): Promise<void> {
  const result = await LLM.generateText({
    id: `${model.replaceAll(':', '-')}-live`,
    model,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    // Registry policy resolves this intent per access profile before request construction.
    thinking: 'none',
    maxOutputTokens: 256,
    maxRetries: 0,
    timeout: 30_000,
  });
  const reasoningTokens = getReasoningTokens(result.usage);

  console.log(`[vertex-july-live] model=${model} reasoningTokens=${reasoningTokens}`);
  expect(result.text.trim().length).toBeGreaterThan(0);
  if (expectNoThinking) expect(reasoningTokens).toBe(0);
}

describeVertexLive('Vertex Express July 2026 models (live)', () => {
  it('invokes Gemini 3.5 Flash-Lite with reasoning disabled', async () => {
    await expectInvocable('vertex:gemini-3.5-flash-lite', true);
  }, 45_000);
});

describeVertexGlobalLive('Vertex project/global July 2026 models (live)', () => {
  it('invokes Gemini 3.5 Flash-Lite with the conservative registry policy', async () => {
    await expectInvocable('vertex-global:gemini-3.5-flash-lite');
  }, 45_000);

  it('invokes Gemini 3.6 Flash', async () => {
    await expectInvocable('vertex-global:gemini-3.6-flash');
  }, 45_000);
});
