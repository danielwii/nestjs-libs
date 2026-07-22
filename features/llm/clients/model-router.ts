/**
 * Internal registered-model router.
 *
 * Public callers use `LLM.model()`. This module intentionally stays out of the
 * client barrels so provider routing has one public owner.
 */
import { Oops } from '@app/nest/exceptions/oops';

import { getModel, parseModelSpec } from '../types/model.types';
import { bedrock, google, openrouter, vertex, vertexGlobal } from './llm.clients';

import type { LLMModelSpec, LLMProviderType, ModelConfig } from '../types/model.types';
import type { LanguageModel } from 'ai';

function configurationMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveRegisteredModel(spec: LLMModelSpec): { config: ModelConfig; key: string } {
  try {
    const { key } = parseModelSpec(spec);
    const separator = key.indexOf(':');
    if (separator <= 0 || separator === key.length - 1) {
      throw Oops.Panic.Config(`Invalid model key format: ${key}, expected "provider:model"`);
    }
    return { config: getModel(key), key };
  } catch (error) {
    if (error instanceof Oops.Panic) throw error;
    throw Oops.Panic.Config(configurationMessage(error));
  }
}

/** Internal implementation behind the public `LLM.model()` boundary. */
export function createLanguageModel(spec: LLMModelSpec, modelIdSuffix?: string): LanguageModel {
  const { config, key } = resolveRegisteredModel(spec);
  const modelId = modelIdSuffix ? `${config.modelId}${modelIdSuffix}` : config.modelId;
  const provider = config.provider as LLMProviderType;

  switch (provider) {
    case 'openrouter':
      return openrouter(modelId);
    case 'google':
      return google(modelId);
    case 'vertex':
      return vertex(modelId);
    case 'vertex-global':
      return vertexGlobal(modelId);
    case 'bedrock':
      return bedrock(modelId);
    default:
      throw Oops.Panic.Config(`Unknown provider: ${provider as string} for model: ${key}`);
  }
}
