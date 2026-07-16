import { llmCaptureSchema } from './capture.schema';

import { describe, expect, it } from 'bun:test';

const baseCapture = {
  id: 'capture-contract',
  method: 'generateObject' as const,
  model: 'openrouter:grok-4.1-fast',
  instructions: 'Use the canonical prompt owner',
  messages: [{ role: 'user' as const, content: 'hello' }],
  jsonSchema: { type: 'object' },
};

describe('llmCaptureSchema', () => {
  it('accepts an AI SDK v7 capture', () => {
    expect(llmCaptureSchema.safeParse(baseCapture).success).toBe(true);
  });

  it("rejects the legacy top-level 'system' field at its exact path", () => {
    const result = llmCaptureSchema.safeParse({
      ...baseCapture,
      instructions: undefined,
      system: 'legacy prompt owner',
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['system'],
          message: expect.stringContaining("use 'instructions'"),
        }),
      ]),
    );
  });

  it("keeps the protocol message role 'system' valid", () => {
    const result = llmCaptureSchema.safeParse({
      ...baseCapture,
      messages: [{ role: 'system', content: 'valid message role' }],
    });

    expect(result.success).toBe(true);
  });
});
