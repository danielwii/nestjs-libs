import { DEFAULT_LLM_TELEMETRY } from '../../../features/llm/clients/telemetry-policy';
import { registerAiSdkOtel } from './ai-sdk-otel';

import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { generateText } from 'ai';

import type { LanguageModelV4 } from '@ai-sdk/provider';

const usage = {
  inputTokens: {
    total: 2,
    noCache: 2,
    cacheRead: 0,
    cacheWrite: 0,
  },
  outputTokens: {
    total: 1,
    text: 1,
    reasoning: 0,
  },
};

const model: LanguageModelV4 = {
  specificationVersion: 'v4',
  provider: 'fixture',
  modelId: 'fixture-model',
  supportedUrls: {},
  async doGenerate() {
    return {
      content: [{ type: 'text' as const, text: 'fixture output' }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage,
      warnings: [],
    };
  },
  async doStream() {
    throw new Error('streaming is not used by this fixture');
  },
};

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
provider.register();

const first = registerAiSdkOtel();
const second = registerAiSdkOtel();

await generateText({
  model,
  instructions: 'fixture input',
  messages: [{ role: 'user', content: 'hello' }],
  telemetry: DEFAULT_LLM_TELEMETRY,
  runtimeContext: {
    tags: ['contract:v7'],
    userId: 'must-not-export',
    token: 'must-not-export',
  },
});

await provider.forceFlush();

const spans = exporter.getFinishedSpans().map((span) => ({
  name: span.name,
  scope: span.instrumentationScope.name,
  attributes: span.attributes,
}));

process.stdout.write(`${JSON.stringify({ first, second, spans })}\n`);
await provider.shutdown();
