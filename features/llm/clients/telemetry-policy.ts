import type { TelemetryOptions } from 'ai';

/** Explicitly preserves the existing default capture policy. */
export const DEFAULT_LLM_TELEMETRY = {
  isEnabled: true,
  recordInputs: true,
  recordOutputs: true,
  includeRuntimeContext: { tags: true },
} satisfies TelemetryOptions;
