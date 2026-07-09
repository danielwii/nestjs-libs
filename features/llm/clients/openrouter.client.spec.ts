import 'reflect-metadata';

import {
  getOpenRouterRoutingProfile as getPublicOpenRouterRoutingProfile,
  registerOpenRouterRoutingProfile as registerPublicOpenRouterRoutingProfile,
} from '../index';
import { openrouterOptions, registerOpenRouterRoutingProfile, resolveOpenRouterOptions } from './openrouter.client';

import { describe, expect, it } from 'bun:test';

import type { OpenRouterRoutingProfile } from '../index';

describe('OpenRouter routing options', () => {
  it('resolves the built-in bedrock profile to provider.only without fallbacks', () => {
    const options = resolveOpenRouterOptions({ routing: 'bedrock' });

    expect(options).toEqual({
      openrouter: {
        provider: {
          only: ['amazon-bedrock'],
          allow_fallbacks: false,
        },
      },
    });
  });

  it('resolves the built-in latency profile to provider.sort', () => {
    const options = resolveOpenRouterOptions({ routing: 'latency' });

    expect(options).toEqual({
      openrouter: {
        provider: {
          sort: 'latency',
        },
      },
    });
  });

  it('returns no provider override for auto routing', () => {
    expect(resolveOpenRouterOptions({ routing: 'auto' })).toBeUndefined();
  });

  it('normalizes typed provider routing to OpenRouter snake_case payload', () => {
    const options = openrouterOptions({
      provider: {
        only: ['amazon-bedrock'],
        ignore: ['openai'],
        allowFallbacks: false,
        requireParameters: true,
      },
    });

    expect(options.openrouter.provider).toEqual({
      only: ['amazon-bedrock'],
      ignore: ['openai'],
      allow_fallbacks: false,
      require_parameters: true,
    });
  });

  it('lets projects register additional routing profiles', () => {
    registerOpenRouterRoutingProfile('test-bedrock-prefer', {
      kind: 'provider',
      provider: {
        order: ['amazon-bedrock'],
        allowFallbacks: true,
      },
    });

    const options = resolveOpenRouterOptions({ routing: 'test-bedrock-prefer' });

    expect(options).toEqual({
      openrouter: {
        provider: {
          order: ['amazon-bedrock'],
          allow_fallbacks: true,
        },
      },
    });
  });

  it('exports the routing profile registry through the public LLM barrel', () => {
    const profile: OpenRouterRoutingProfile = {
      kind: 'provider',
      provider: {
        only: ['amazon-bedrock'],
        allowFallbacks: false,
      },
    };

    registerPublicOpenRouterRoutingProfile('test-public-bedrock-only', profile);

    expect(getPublicOpenRouterRoutingProfile('test-public-bedrock-only')).toEqual(profile);
  });
});
