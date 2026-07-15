import { modelMessageSchema } from 'ai';
import { z } from 'zod';

const captureMethods = ['generateObject', 'streamObject', 'generateObjectViaTool', 'streamObjectViaTool'] as const;

/** Runtime boundary for replayable AI SDK v7 request captures. */
export const llmCaptureSchema = z
  .object({
    id: z.string().min(1),
    method: z.enum(captureMethods),
    model: z.string().min(1),
    instructions: z.string().optional(),
    system: z
      .never({
        error: "Legacy capture field 'system' is not supported; AI SDK v7 capture files use 'instructions'",
      })
      .optional(),
    messages: z.array(modelMessageSchema),
    jsonSchema: z.record(z.string(), z.unknown()),
    toolName: z.string().min(1).optional(),
    toolDescription: z.string().optional(),
    capturedAt: z.string().optional(),
  })
  .strict();

export type LLMCapture = z.infer<typeof llmCaptureSchema>;
