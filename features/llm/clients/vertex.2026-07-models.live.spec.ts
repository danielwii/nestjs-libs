/**
 * Official July 2026 Vertex route probes.
 *
 * Not run in CI. Execute with credentials already present in the environment:
 * ```bash
 * LLM_LIVE_TEST=1 bun test features/llm/clients/vertex.2026-07-models.live.spec.ts
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

const LIVE = process.env.LLM_LIVE_TEST === '1';
const HAS_VERTEX_KEY = !!process.env.AI_GOOGLE_VERTEX_API_KEY?.trim();
const HAS_VERTEX_GLOBAL_CONFIG =
  !!process.env.GOOGLE_VERTEX_PROJECT?.trim() && (process.env.GOOGLE_VERTEX_LOCATION ?? 'global') === 'global';
const describeVertexLive = LIVE && HAS_VERTEX_KEY ? describe : describe.skip;
const describeVertexGlobalLive = LIVE && HAS_VERTEX_GLOBAL_CONFIG ? describe : describe.skip;

async function expectInvocable(model: LLMModelKey): Promise<void> {
  const result = await LLM.generateText({
    id: `${model.replaceAll(':', '-')}-live`,
    model,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    // The registry safely maps no-thinking intent to the lowest public effort,
    // which is `low` for the level-based July routes.
    thinking: 'none',
    maxOutputTokens: 256,
    maxRetries: 0,
    timeout: 30_000,
  });

  expect(result.text.trim().length).toBeGreaterThan(0);
}

describeVertexLive('Vertex Express July 2026 models (live)', () => {
  it('invokes Gemini 3.5 Flash-Lite', async () => {
    await expectInvocable('vertex:gemini-3.5-flash-lite');
  }, 45_000);
});

describeVertexGlobalLive('Vertex project/global July 2026 models (live)', () => {
  it('invokes Gemini 3.5 Flash-Lite and Gemini 3.6 Flash', async () => {
    await expectInvocable('vertex-global:gemini-3.5-flash-lite');
    await expectInvocable('vertex-global:gemini-3.6-flash');
  }, 90_000);
});
