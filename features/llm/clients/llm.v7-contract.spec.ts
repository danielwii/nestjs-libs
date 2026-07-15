import { LLM } from './llm.class';

import type { LLMModelKey } from '../types/model.types';
import type { ModelMessage } from 'ai';

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

void legacySystem;
void legacyTools;
void legacyStopWhen;
