import { LangfuseToolCallSpan } from './span-helper';

import { trace } from '@opentelemetry/api';
import { describe, expect, it, mock, spyOn } from 'bun:test';

/* eslint-disable @typescript-eslint/unbound-method */
describe('SpanHelper', () => {
  describe('LangfuseToolCallSpan', () => {
    it('should create span with correct attributes and handle result', () => {
      // Mock span
      const mockSpan = {
        setAttributes: mock(),
        setStatus: mock(),
        end: mock(),
      };

      // Mock tracer
      const mockTracer = {
        startSpan: mock(() => mockSpan),
      };

      // Mock trace.getTracer
      spyOn(trace, 'getTracer').mockReturnValue(mockTracer as unknown as ReturnType<typeof trace.getTracer>);

      const toolName = 'test-tool';
      const toolCallId = 'call-123';

      const spanHelper = new LangfuseToolCallSpan(toolName, toolCallId);

      // Verify span creation
      expect(trace.getTracer).toHaveBeenCalledWith('ai');
      expect(mockTracer.startSpan).toHaveBeenCalled();
      const startSpanArgs = (mockTracer.startSpan.mock.calls as unknown as unknown[][])[0]!;
      expect(startSpanArgs[0]).toBe(`ai.toolCall ${toolName}`);

      // Verify initial attributes
      expect(mockSpan.setAttributes).toHaveBeenCalled();
      expect((mockSpan.setAttributes.mock.calls as unknown as Record<string, unknown>[][])[0]![0]).toEqual({
        'ai.toolCall.id': toolCallId,
      });

      // Test setResult
      spanHelper.setResult({ arg: 1 }, { res: 2 }, { extra: 'meta' });

      // Verify result attributes
      expect(mockSpan.setAttributes).toHaveBeenCalledTimes(2);
      const resultArgs = (mockSpan.setAttributes.mock.calls as unknown as Record<string, string>[][])[1]![0]!;
      expect(resultArgs['ai.toolCall.args']).toBe('{"arg":1}');
      expect(resultArgs['ai.toolCall.result']).toBe('{"res":2}');
      expect(resultArgs.extra).toBe('meta');

      // Test end
      spanHelper.end();
      expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: 1 }); // SpanStatusCode.OK = 1
      expect(mockSpan.end).toHaveBeenCalled();
    });
  });
});
