import { LLM } from './llm.class';

import { stepCountIs, tool } from 'ai';
import { z } from 'zod';

import type {
  StreamTextParams as PublicStreamTextParams,
  LLMStreamTextResult as PublicStreamTextResult,
} from '../index';
import type { LLMModelKey } from '../types/model.types';
import type {
  StreamTextParams as ClientStreamTextParams,
  LLMStreamTextResult as ClientStreamTextResult,
} from './index';
import type { Context } from '@ai-sdk/provider-utils';
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
