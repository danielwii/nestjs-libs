import type { TelemetryOptions } from 'ai';

/**
 * Default capture policy for model calls: spans carry usage, timing and selected runtime tags, but not prompt or
 * completion content. Content capture is opt-in: a call (or the `ai.telemetry` option) must set `recordInputs` /
 * `recordOutputs` to `true` explicitly.
 */
export const DEFAULT_LLM_TELEMETRY = {
  isEnabled: true,
  recordInputs: false,
  recordOutputs: false,
  includeRuntimeContext: { tags: true },
} satisfies TelemetryOptions;
