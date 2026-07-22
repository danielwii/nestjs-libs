import 'reflect-metadata';

import { autoOpts } from './auto.client';

import { describe, expect, it } from 'bun:test';

describe('autoOpts model-aware thinking contracts', () => {
  it('emits thinkingLevel for full Gemini 3 level-mode keys', () => {
    expect(autoOpts.thinking('vertex:gemini-3.5-flash-lite', 'low')).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'low' } },
    });
    expect(autoOpts.thinking('vertex-global:gemini-3.6-flash', 'high')).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'high' } },
    });
  });

  it('falls no-thinking intent back to low for mandatory level-mode keys', () => {
    for (const key of [
      'vertex:gemini-3.5-flash-lite',
      'vertex-global:gemini-3.5-flash-lite',
      'vertex-global:gemini-3.6-flash',
    ] as const) {
      expect(autoOpts.noThinking(key)).toEqual({
        google: { thinkingConfig: { thinkingLevel: 'low' } },
      });
    }
  });

  it('honors mandatory reasoning for non-Google full model keys', () => {
    expect(autoOpts.noThinking('openrouter:gemini-3.6-flash')).toEqual({
      openrouter: { reasoning: { effort: 'low' } },
    });
  });

  it('preserves the live-probed budget contract for Vertex Express Gemini 3.6 Flash', () => {
    expect(autoOpts.noThinking('vertex:gemini-3.6-flash')).toEqual({
      google: { thinkingConfig: { thinkingBudget: 0 } },
    });
    expect(autoOpts.thinking('vertex:gemini-3.6-flash', 'low')).toEqual({
      google: { thinkingConfig: { thinkingBudget: 1024 } },
    });
  });

  it('preserves legacy provider-only behavior when no model contract is available', () => {
    expect(autoOpts.noThinking('vertex')).toEqual({
      google: { thinkingConfig: { thinkingBudget: 0 } },
    });
    expect(autoOpts.thinking('vertex-global', 'low')).toEqual({
      google: { thinkingConfig: { thinkingBudget: 1024 } },
    });
  });
});
