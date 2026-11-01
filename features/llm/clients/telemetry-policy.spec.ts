import 'reflect-metadata';

import { withProvenanceTelemetry } from './llm.class';
import { DEFAULT_LLM_TELEMETRY } from './telemetry-policy';

import { describe, expect, it } from 'bun:test';

describe('DEFAULT_LLM_TELEMETRY', () => {
  it('records neither inputs nor outputs, and selects only runtime tags', () => {
    expect(DEFAULT_LLM_TELEMETRY).toEqual({
      isEnabled: true,
      recordInputs: false,
      recordOutputs: false,
      includeRuntimeContext: { tags: true },
    });
  });

  it('does not select arbitrary runtime context fields', () => {
    expect(DEFAULT_LLM_TELEMETRY.includeRuntimeContext).not.toHaveProperty('userId');
    expect(DEFAULT_LLM_TELEMETRY.includeRuntimeContext).not.toHaveProperty('token');
  });
});

describe('withProvenanceTelemetry content capture', () => {
  it('keeps content capture off for the default policy and keeps isEnabled and tags', () => {
    expect(withProvenanceTelemetry(DEFAULT_LLM_TELEMETRY)).toEqual({
      isEnabled: true,
      recordInputs: false,
      recordOutputs: false,
      includeRuntimeContext: { tags: true },
    });
  });

  it('fills each omitted item with the default for a partial object', () => {
    expect(withProvenanceTelemetry({ isEnabled: true })).toEqual({
      isEnabled: true,
      recordInputs: false,
      recordOutputs: false,
      includeRuntimeContext: { tags: true },
    });
    expect(withProvenanceTelemetry({})).toMatchObject({ recordInputs: false, recordOutputs: false });
  });

  it('fills only the omitted item when the other one is set', () => {
    expect(withProvenanceTelemetry({ isEnabled: true, recordInputs: true })).toMatchObject({
      recordInputs: true,
      recordOutputs: false,
    });
    expect(withProvenanceTelemetry({ isEnabled: true, recordOutputs: true })).toMatchObject({
      recordInputs: false,
      recordOutputs: true,
    });
  });

  it('follows an explicit setting in either direction', () => {
    expect(withProvenanceTelemetry({ isEnabled: true, recordInputs: true, recordOutputs: true })).toMatchObject({
      recordInputs: true,
      recordOutputs: true,
    });
    expect(withProvenanceTelemetry({ isEnabled: true, recordInputs: false, recordOutputs: false })).toMatchObject({
      recordInputs: false,
      recordOutputs: false,
    });
  });

  it('keeps caller runtime context selections and still adds tags', () => {
    expect(
      withProvenanceTelemetry({ isEnabled: true, includeRuntimeContext: { requestId: true } } as never),
    ).toMatchObject({
      includeRuntimeContext: { requestId: true, tags: true },
    });
  });

  it('leaves a disabled telemetry object unchanged', () => {
    const disabled = { isEnabled: false as const };
    expect(withProvenanceTelemetry(disabled)).toBe(disabled);
  });
});
