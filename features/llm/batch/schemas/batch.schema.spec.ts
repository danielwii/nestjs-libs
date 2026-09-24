import {
  BatchMessageSchema,
  BatchRequestItemSchema,
  BatchResponseSchema,
  BatchResultItemSchema,
  CreateBatchParamsSchema,
} from './batch.schema';

import { describe, expect, it } from 'bun:test';

describe('Batch Schemas', () => {
  describe('BatchMessageSchema', () => {
    it('successfully parses standard messages', () => {
      const msg = { role: 'user', content: 'hello' };
      const parsed = BatchMessageSchema.safeParse(msg);
      expect(parsed.success).toBe(true);
    });

    it('preserves tool-calling fields and extra protocol properties', () => {
      const assistantWithToolCalls = {
        role: 'assistant',
        content: '',
        name: 'agent_runner',
        tool_calls: [
          {
            id: 'call_123',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":"Taipei"}' },
          },
        ],
        extra_custom_metadata: { trace_id: 't-99' },
      };

      const parsedAssistant = BatchMessageSchema.safeParse(assistantWithToolCalls);
      expect(parsedAssistant.success).toBe(true);
      if (parsedAssistant.success) {
        expect(parsedAssistant.data.role).toBe('assistant');
        expect(parsedAssistant.data.name).toBe('agent_runner');
        expect(parsedAssistant.data.tool_calls).toHaveLength(1);
        expect((parsedAssistant.data as any).extra_custom_metadata).toEqual({ trace_id: 't-99' });
      }

      const toolResponse = {
        role: 'tool',
        content: '{"temp": 24}',
        tool_call_id: 'call_123',
        name: 'get_weather',
      };

      const parsedTool = BatchMessageSchema.safeParse(toolResponse);
      expect(parsedTool.success).toBe(true);
      if (parsedTool.success) {
        expect(parsedTool.data.role).toBe('tool');
        expect(parsedTool.data.tool_call_id).toBe('call_123');
        expect(parsedTool.data.name).toBe('get_weather');
      }
    });

    it('accepts assistant tool-call messages with null or omitted content', () => {
      const assistantWithNullContent = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_abc',
            type: 'function',
            function: { name: 'calculator', arguments: '{"expr":"1+1"}' },
          },
        ],
      };

      const parsedNull = BatchMessageSchema.safeParse(assistantWithNullContent);
      expect(parsedNull.success).toBe(true);
      if (parsedNull.success) {
        expect(parsedNull.data.role).toBe('assistant');
        expect(parsedNull.data.content).toBeNull();
        expect(parsedNull.data.tool_calls).toHaveLength(1);
      }

      const assistantWithOmittedContent = {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_def',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"nestjs"}' },
          },
        ],
      };

      const parsedOmitted = BatchMessageSchema.safeParse(assistantWithOmittedContent);
      expect(parsedOmitted.success).toBe(true);
      if (parsedOmitted.success) {
        expect(parsedOmitted.data.role).toBe('assistant');
        expect(parsedOmitted.data.content).toBeUndefined();
        expect(parsedOmitted.data.tool_calls).toHaveLength(1);
      }
    });

    it('rejects messages without content unless assistant provides tool_calls', () => {
      // 1. User without content
      expect(BatchMessageSchema.safeParse({ role: 'user' }).success).toBe(false);
      expect(BatchMessageSchema.safeParse({ role: 'user', content: null }).success).toBe(false);

      // 2. Tool without content
      expect(BatchMessageSchema.safeParse({ role: 'tool', tool_call_id: 'call_1' }).success).toBe(false);
      expect(BatchMessageSchema.safeParse({ role: 'tool', content: null, tool_call_id: 'call_1' }).success).toBe(false);

      // 3. System without content
      expect(BatchMessageSchema.safeParse({ role: 'system' }).success).toBe(false);

      // 4. Assistant without content and without tool_calls
      expect(BatchMessageSchema.safeParse({ role: 'assistant' }).success).toBe(false);
      expect(BatchMessageSchema.safeParse({ role: 'assistant', content: null }).success).toBe(false);
      expect(BatchMessageSchema.safeParse({ role: 'assistant', tool_calls: [] }).success).toBe(false);
    });
  });

  describe('BatchRequestItemSchema', () => {
    it('successfully parses a valid request item', () => {
      const valid = {
        custom_id: 'req-001',
        body: {
          messages: [{ role: 'user', content: 'Hello OpenRouter' }],
          temperature: 0.7,
        },
      };

      const result = BatchRequestItemSchema.safeParse(valid);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.custom_id).toBe('req-001');
        expect(result.data.body.messages[0]?.content).toBe('Hello OpenRouter');
      }
    });

    it('rejects an empty custom_id', () => {
      const invalid = {
        custom_id: '',
        body: {
          messages: [{ role: 'user', content: 'Hello' }],
        },
      };

      const result = BatchRequestItemSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('rejects an empty messages array', () => {
      const invalid = {
        custom_id: 'req-001',
        body: {
          messages: [],
        },
      };

      const result = BatchRequestItemSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe('CreateBatchParamsSchema', () => {
    it('applies default endpoint if not specified', () => {
      const params = {
        model: 'openai/gpt-6-sol',
        requests: [
          {
            custom_id: 'req-1',
            body: {
              messages: [{ role: 'user', content: 'test' }],
            },
          },
        ],
      };

      const result = CreateBatchParamsSchema.safeParse(params);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.endpoint).toBe('/v1/chat/completions');
        expect(result.data.model).toBe('openai/gpt-6-sol');
      }
    });

    it('rejects empty or whitespace-only model or empty requests list', () => {
      expect(
        CreateBatchParamsSchema.safeParse({
          model: '',
          requests: [{ custom_id: '1', body: { messages: [{ role: 'user', content: 'a' }] } }],
        }).success,
      ).toBe(false);
      expect(
        CreateBatchParamsSchema.safeParse({
          model: '   ',
          requests: [{ custom_id: '1', body: { messages: [{ role: 'user', content: 'a' }] } }],
        }).success,
      ).toBe(false);
      expect(CreateBatchParamsSchema.safeParse({ model: 'gpt-4o', requests: [] }).success).toBe(false);
    });
  });

  describe('BatchResponseSchema', () => {
    it('validates a standard in_progress response', () => {
      const payload = {
        id: 'batch_xyz123',
        object: 'batch',
        endpoint: '/v1/chat/completions',
        model: 'openai/gpt-6-sol',
        status: 'in_progress',
        created_at: 1790100000,
        request_counts: {
          total: 10,
          completed: 4,
          failed: 0,
        },
      };

      const result = BatchResponseSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe('batch_xyz123');
        expect(result.data.status).toBe('in_progress');
        expect(result.data.request_counts?.completed).toBe(4);
      }
    });

    it('validates a completed response with inlined results', () => {
      const payload = {
        id: 'batch_xyz123',
        status: 'completed',
        request_counts: {
          total: 2,
          completed: 2,
          failed: 0,
        },
        results: [
          {
            custom_id: 'req-1',
            response: { choices: [{ message: { content: 'Answer 1' } }] },
          },
          {
            custom_id: 'req-2',
            response: { choices: [{ message: { content: 'Answer 2' } }] },
          },
        ],
      };

      const result = BatchResponseSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results?.length).toBe(2);
        expect(result.data.results?.[0]?.custom_id).toBe('req-1');
      }
    });

    it('validates a finalizing response', () => {
      const payload = {
        id: 'batch_xyz123',
        status: 'finalizing',
        created_at: 1790100000,
      };

      const result = BatchResponseSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('finalizing');
      }
    });

    it('rejects an invalid batch status', () => {
      const payload = {
        id: 'batch_xyz123',
        status: 'unknown_status',
      };

      const result = BatchResponseSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });
  });
});
