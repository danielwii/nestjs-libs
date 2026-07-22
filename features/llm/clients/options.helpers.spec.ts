import { googleOptions } from './google.client';
import { reasoningEffortOptions } from './options.helpers';
import { vertexOptions } from './vertex.client';

import { describe, expect, it } from 'bun:test';

describe('Google/Vertex thinking parameter modes', () => {
  it('keeps budget mapping for existing models', () => {
    expect(reasoningEffortOptions('vertex', 'low')).toEqual({
      google: { thinkingConfig: { thinkingBudget: 1024 } },
    });
  });

  it('maps public efforts to thinkingLevel for Gemini 3+ level routes', () => {
    for (const effort of ['low', 'medium', 'high'] as const) {
      expect(reasoningEffortOptions('vertex-global', effort, 'gemini-3.5-flash-lite', 'level')).toEqual({
        google: { thinkingConfig: { thinkingLevel: effort } },
      });
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
