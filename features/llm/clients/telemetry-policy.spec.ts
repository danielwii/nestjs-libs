import { DEFAULT_LLM_TELEMETRY } from './telemetry-policy';

import { describe, expect, it } from 'bun:test';

describe('DEFAULT_LLM_TELEMETRY', () => {
  it('makes input, output, and selected runtime tags explicit', () => {
    expect(DEFAULT_LLM_TELEMETRY).toEqual({
      isEnabled: true,
      recordInputs: true,
      recordOutputs: true,
      includeRuntimeContext: { tags: true },
    });
  });

  it('does not select arbitrary runtime context fields', () => {
    expect(DEFAULT_LLM_TELEMETRY.includeRuntimeContext).not.toHaveProperty('userId');
    expect(DEFAULT_LLM_TELEMETRY.includeRuntimeContext).not.toHaveProperty('token');
  });
});
