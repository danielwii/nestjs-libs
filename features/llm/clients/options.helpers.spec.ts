import { googleOptions } from './google.client';
import { disableThinkingOptions, reasoningEffortOptions } from './options.helpers';
import { vertexOptions } from './vertex.client';

import { describe, expect, it } from 'bun:test';

describe('Google/Vertex thinking parameter modes', () => {
  it('keeps budget mapping for existing models', () => {
    expect(reasoningEffortOptions('vertex', 'low')).toEqual({
      google: { thinkingConfig: { thinkingBudget: 1024 } },
    });
  });

  it('maps the live-proven Vertex Express no-thinking transport to budget zero', () => {
    expect(disableThinkingOptions('vertex', 'gemini-3.5-flash-lite')).toEqual({
      google: { thinkingConfig: { thinkingBudget: 0 } },
    });
  });

  it('maps Google 3.5-lite / 3.6 no-thinking to thinkingLevel minimal', () => {
    expect(disableThinkingOptions('google', 'gemini-3.6-flash', 'level-minimal')).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'minimal' } },
    });
  });

  it('maps public efforts to thinkingLevel for Gemini 3+ level routes', () => {
    for (const provider of ['vertex', 'vertex-global'] as const) {
      for (const effort of ['low', 'medium', 'high'] as const) {
        expect(reasoningEffortOptions(provider, effort, 'gemini-3.5-flash-lite', 'level')).toEqual({
          google: { thinkingConfig: { thinkingLevel: effort } },
        });
      }
    }
  });

  it('exposes thinkingLevel through the direct Google and Vertex helpers', () => {
    expect(googleOptions({ thinkingLevel: 'minimal' })).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'minimal' } },
    });
    expect(vertexOptions({ thinkingLevel: 'high' })).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'high' } },
    });
  });
});
