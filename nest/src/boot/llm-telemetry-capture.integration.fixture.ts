import 'reflect-metadata';

import { SysEnv } from '@app/env';
import { LLM } from '@app/features/llm/clients/llm.class';
import { ApiFetcher } from '@app/utils/fetch';

import { registerAiSdkOtel } from './ai-sdk-otel';

import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import type { TelemetryOptions } from 'ai';

(SysEnv as unknown as Record<string, string | undefined>).AI_OPENROUTER_API_KEY ??= 'test-openrouter-key';

// A model call answers with the case name so every span can be matched to the case that produced it.
(ApiFetcher as unknown as { fetch: typeof fetch }).fetch = (async (
  _url: string | URL | Request,
  init?: RequestInit,
) => {
  const requested = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
    messages?: Array<{ content?: unknown }>;
  };
  const userText = JSON.stringify(requested.messages ?? []);
  const label = /case-[a-z-]+/.exec(userText)?.[0] ?? 'case-unknown';
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-fixture',
      object: 'chat.completion',
      created: 0,
      model: 'fixture-model',
      choices: [{ index: 0, message: { role: 'assistant', content: `output-probe-${label}` }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}) as typeof fetch;

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();
registerAiSdkOtel();

const cases: Array<{ name: string; telemetry?: TelemetryOptions }> = [
  { name: 'case-none' },
  { name: 'case-partial', telemetry: { isEnabled: true } },
  { name: 'case-inputs-only', telemetry: { isEnabled: true, recordInputs: true } },
  { name: 'case-opt-in', telemetry: { isEnabled: true, recordInputs: true, recordOutputs: true } },
];

for (const { name, telemetry } of cases) {
  await LLM.generateText({
    id: name,
    model: 'openrouter:grok-4.3',
    instructions: `instructions-probe-${name}`,
    messages: [{ role: 'user', content: `input-probe-${name}` }],
    maxRetries: 0,
    ai: { runtimeContext: { tags: [name] }, ...(telemetry ? { telemetry } : {}) },
  });
}

await provider.forceFlush();

const spans = exporter
  .getFinishedSpans()
  .filter((span) => span.instrumentationScope.name === 'gen_ai')
  .map((span) => ({ traceId: span.spanContext().traceId, name: span.name, attributes: span.attributes }));

process.stdout.write(`${JSON.stringify({ spans })}\n`);
await provider.shutdown();
