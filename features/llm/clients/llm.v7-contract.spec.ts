import { LLM } from './llm.class';
import { openrouterOptions } from './openrouter.client';

import { stepCountIs, tool } from 'ai';
import { z } from 'zod';

import type {
  StreamTextParams as PublicStreamTextParams,
  LLMStreamTextResult as PublicStreamTextResult,
} from '../index';
import type { LLMModelKey, ParsedModelSpec } from '../types/model.types';
import type { LLMProviderOptionsRegistry } from '../types/request.types';
import type {
  StreamTextParams as ClientStreamTextParams,
  LLMStreamTextResult as ClientStreamTextResult,
  LLMPrepareStepOptions,
} from './index';
import type { Context } from '@ai-sdk/provider-utils';
import type { AbstractEnvironmentVariables } from '@app/env';
import type { ModelMessage, ToolSet } from 'ai';

const model = 'openrouter:grok-4.1-fast' as LLMModelKey;
const messages: ModelMessage[] = [{ role: 'user', content: 'test' }];

// These are compile-time contract fixtures. `tsc --noEmit` must reject every
// removed public alias; Bun does not execute them as assertions.
const canonical: Parameters<typeof LLM.generateText>[0] = {
  id: 'v7-contract',
  model,
  instructions: 'canonical prompt owner',
  messages,
  openrouter: { provider: { sort: 'latency' } },
};

void canonical;

// @ts-expect-error system is removed from the canonical shared API
const legacySystem: Parameters<typeof LLM.generateText>[0] = { id: 'legacy-system', model, system: 'no', messages };
// @ts-expect-error root-level tools are removed; they live under ai.tools
const legacyTools: Parameters<typeof LLM.generateText>[0] = { id: 'legacy-tools', model, messages, tools: {} };
// @ts-expect-error root-level stopWhen is removed; it lives under ai.stopWhen
const legacyStopWhen: Parameters<typeof LLM.streamText>[0] = { id: 'legacy-stop', model, messages, stopWhen: [] };
// @ts-expect-error maxSteps is not part of the AI SDK v7 canonical API
const legacyMaxSteps: Parameters<typeof LLM.streamText>[0] = { id: 'legacy-max-steps', model, messages, maxSteps: 2 };

const removedRootProviderSort: Parameters<typeof LLM.generateText>[0] = {
  id: 'removed-root-provider-sort',
  model,
  messages,
  // @ts-expect-error provider routing has one owner: openrouter.provider
  providerSort: 'latency',
};

const removedPrepareStepProviderSort: LLMPrepareStepOptions = {
  // @ts-expect-error step routing has one owner: llm.openrouter.provider
  providerSort: 'latency',
};

const canonicalOpenRouterOptions = openrouterOptions({ provider: { sort: 'latency' } });
const removedOpenRouterProviderSort = openrouterOptions({
  // @ts-expect-error helper aliases are removed; use provider.sort
  providerSort: 'latency',
});
const removedOpenRouterProviderOrder = openrouterOptions({
  // @ts-expect-error helper aliases are removed; use provider.order
  providerOrder: ['anthropic'],
});

const canonicalRegistryOptions: LLMProviderOptionsRegistry['openrouter'] = {
  provider: { order: ['anthropic'] },
};
const removedRegistryProviderOrder: LLMProviderOptionsRegistry['openrouter'] = {
  // @ts-expect-error registry aliases are removed; use provider.order
  providerOrder: ['anthropic'],
};

type CanonicalOpenRouterKey = AbstractEnvironmentVariables['AI_OPENROUTER_API_KEY'];
type CanonicalGoogleKey = AbstractEnvironmentVariables['AI_GOOGLE_API_KEY'];
type CanonicalVertexKey = AbstractEnvironmentVariables['AI_GOOGLE_VERTEX_API_KEY'];
type CanonicalOpenAIKey = AbstractEnvironmentVariables['AI_OPENAI_API_KEY'];
type CanonicalJinaKey = AbstractEnvironmentVariables['AI_JINA_API_KEY'];
type CanonicalVoyageKey = AbstractEnvironmentVariables['AI_VOYAGE_API_KEY'];
type CanonicalVertexProject = AbstractEnvironmentVariables['GOOGLE_VERTEX_PROJECT'];
type CanonicalVertexLocation = AbstractEnvironmentVariables['GOOGLE_VERTEX_LOCATION'];

// @ts-expect-error removed wrapper env key; use AI_OPENROUTER_API_KEY
type RemovedOpenRouterKey = AbstractEnvironmentVariables['OPENROUTER_API_KEY'];
// @ts-expect-error removed wrapper env key; use AI_GOOGLE_API_KEY
type RemovedGoogleKey = AbstractEnvironmentVariables['GOOGLE_GENERATIVE_AI_API_KEY'];
// @ts-expect-error removed wrapper env key; use AI_GOOGLE_VERTEX_API_KEY
type RemovedVertexKey = AbstractEnvironmentVariables['GOOGLE_VERTEX_API_KEY'];
// @ts-expect-error removed wrapper env key; use AI_OPENAI_API_KEY
type RemovedOpenAIKey = AbstractEnvironmentVariables['OPENAI_API_KEY'];
// @ts-expect-error removed wrapper env key; use AI_JINA_API_KEY
type RemovedJinaKey = AbstractEnvironmentVariables['JINA_API_KEY'];
// @ts-expect-error removed wrapper env key; use AI_VOYAGE_API_KEY
type RemovedVoyageKey = AbstractEnvironmentVariables['VOYAGE_API_KEY'];
// @ts-expect-error use the AI SDK v7 canonical GOOGLE_VERTEX_PROJECT
type RemovedGoogleCloudProject = AbstractEnvironmentVariables['GOOGLE_CLOUD_PROJECT'];
// @ts-expect-error use the AI SDK v7 canonical GOOGLE_VERTEX_LOCATION
type RemovedGoogleCloudLocation = AbstractEnvironmentVariables['GOOGLE_CLOUD_LOCATION'];

// @ts-expect-error parsed Vertex options have one owner: vertex.tier
type RemovedParsedTier = ParsedModelSpec['tier'];
// @ts-expect-error parsed Vertex options have one owner: vertex.requestType
type RemovedParsedVertexRequestType = ParsedModelSpec['vertexRequestType'];

type PublicClientModule = typeof import('./index');
type InternalClientModule = typeof import('./llm.clients');

// Hard-retired automatic-routing surfaces must not return through the public barrel.
// @ts-expect-error use LLM.model()
type RemovedStandaloneModel = PublicClientModule['model'];
// @ts-expect-error model-aware execution belongs to LLM
type RemovedAutoOpts = PublicClientModule['autoOpts'];
// @ts-expect-error provider resolution belongs to the model registry
type RemovedParseProvider = PublicClientModule['parseProvider'];
// @ts-expect-error provider-only presets cannot claim model safety
type RemovedOpts = PublicClientModule['opts'];
// @ts-expect-error merge explicit provider-native options at the call site
type RemovedMergeProviderOptions = PublicClientModule['mergeProviderOptions'];
// @ts-expect-error internal thinking builders are not public API
type RemovedDisableThinkingOptions = PublicClientModule['disableThinkingOptions'];
// @ts-expect-error internal thinking builders are not public API
type RemovedReasoningEffortOptions = PublicClientModule['reasoningEffortOptions'];
// @ts-expect-error internal routing stays behind LLM.model()
type RemovedInternalRouter = PublicClientModule['createLanguageModel'];
// @ts-expect-error static no-thinking defaults are unsafe for mandatory-reasoning models
type RemovedOpenRouterDefaults = InternalClientModule['OPENROUTER_DEFAULTS'];
// @ts-expect-error duplicate provider type was replaced by LLMProviderType
type RemovedProviderType = import('./index').ProviderType;

// Old deep-import modules are deleted rather than retained as migration bridges.
// @ts-expect-error auto.client was hard-retired
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type RemovedAutoClientModule = typeof import('./auto.client');
// @ts-expect-error opts.presets was hard-retired
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type RemovedOptsPresetModule = typeof import('./opts.presets');

const validTools = {
  lookup: tool({
    description: 'Lookup a city',
    inputSchema: z.object({ city: z.string() }),
  }),
};

type RuntimeContext = {
  tags: string[];
  requestId: string;
};

const typedParams: ClientStreamTextParams<typeof validTools, RuntimeContext> = {
  id: 'typed-v7-contract',
  model,
  instructions: 'Use the canonical boundary',
  messages,
  ai: {
    tools: validTools,
    toolChoice: { type: 'tool', toolName: 'lookup' },
    stopWhen: stepCountIs(2),
    runtimeContext: { tags: ['contract:v7'], requestId: 'request-1' },
    telemetry: {
      includeRuntimeContext: { tags: true, requestId: true },
    },
    prepareStep: () => ({ instructions: 'Canonical per-step instructions' }),
  },
};

const publicParams: PublicStreamTextParams<typeof validTools, RuntimeContext> = typedParams;

const invalidToolChoice: ClientStreamTextParams<typeof validTools, RuntimeContext> = {
  ...typedParams,
  ai: {
    ...typedParams.ai,
    // @ts-expect-error concrete tool names must survive the public boundary
    toolChoice: { type: 'tool', toolName: 'calendar' },
  },
};

const invalidRuntimeSelection: ClientStreamTextParams<typeof validTools, RuntimeContext> = {
  ...typedParams,
  ai: {
    ...typedParams.ai,
    telemetry: {
      includeRuntimeContext: {
        // @ts-expect-error concrete runtime-context keys must survive the public boundary
        userId: true,
      },
    },
  },
};

const nestedInstructions: ClientStreamTextParams = {
  id: 'nested-instructions',
  model,
  messages,
  // @ts-expect-error prompt ownership belongs to the wrapper top level
  ai: { instructions: 'duplicate owner' },
};

const nestedSystem: ClientStreamTextParams = {
  id: 'nested-system',
  model,
  messages,
  // @ts-expect-error legacy prompt owner is not accepted under ai
  ai: { system: 'legacy duplicate owner' },
};

const nestedPrompt: ClientStreamTextParams = {
  id: 'nested-prompt',
  model,
  messages,
  // @ts-expect-error prompt ownership belongs to the wrapper top level
  ai: { prompt: 'duplicate owner' },
};

const nestedMessages: ClientStreamTextParams = {
  id: 'nested-messages',
  model,
  messages,
  // @ts-expect-error message ownership belongs to the wrapper top level
  ai: { messages },
};

const nestedOnFinish: ClientStreamTextParams = {
  id: 'nested-on-finish',
  model,
  messages,
  // @ts-expect-error onEnd is the only canonical completion callback
  ai: { onFinish: () => undefined },
};

const prepareStepSystem: ClientStreamTextParams = {
  id: 'prepare-step-system',
  model,
  messages,
  ai: {
    // @ts-expect-error prepareStep.system is a deprecated AI SDK alias
    prepareStep: () => ({ system: 'legacy step prompt' }),
  },
};

function assertCanonicalResult<TOOLS extends ToolSet, RUNTIME_CONTEXT extends Context>(
  result: ClientStreamTextResult<TOOLS, RUNTIME_CONTEXT>,
): PublicStreamTextResult<TOOLS, RUNTIME_CONTEXT> {
  void result.stream;
  // @ts-expect-error fullStream is intentionally hidden from the shared public result
  void result.fullStream;
  return result;
}

function assertStreamTextMethodResult(result: ReturnType<typeof LLM.streamText>): void {
  void result.stream;
  // @ts-expect-error the actual method return type must hide the deprecated alias
  void result.fullStream;
}

function assertStreamObjectMethodResult(result: ReturnType<typeof LLM.streamObject>): void {
  void result.stream;
  // @ts-expect-error the actual method return type must hide the deprecated alias
  void result.fullStream;
}

void legacySystem;
void legacyTools;
void legacyStopWhen;
void legacyMaxSteps;
void removedRootProviderSort;
void removedPrepareStepProviderSort;
void canonicalOpenRouterOptions;
void removedOpenRouterProviderSort;
void removedOpenRouterProviderOrder;
void canonicalRegistryOptions;
void removedRegistryProviderOrder;
void publicParams;
void invalidToolChoice;
void invalidRuntimeSelection;
void nestedInstructions;
void nestedSystem;
void nestedPrompt;
void nestedMessages;
void nestedOnFinish;
void prepareStepSystem;
void assertCanonicalResult;
void assertStreamTextMethodResult;
void assertStreamObjectMethodResult;
