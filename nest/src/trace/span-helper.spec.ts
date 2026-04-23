import { LangfuseToolCallSpan } from './span-helper';

import { describe, expect, it, mock } from 'bun:test';

import type { Tracer } from '@opentelemetry/api';

/* eslint-disable @typescript-eslint/unbound-method */
describe('SpanHelper', () => {
  describe('LangfuseToolCallSpan', () => {
    it('should create span with correct attributes and handle result', () => {
      const mockSpan = {
        setAttributes: mock(),
        setStatus: mock(),
        end: mock(),
      };

      // 注入 fake tracer 而不是 spyOn 全局 trace.getTracer：spy 会污染整个进程的 OTel API，
      // 让其他 spec（如 otel-trace.middleware.spec）拿到此 mockTracer 后的 startSpan
      // 返回 mockSpan，后者缺 spanContext() 等方法时 crash。
      const mockTracer = {
        startSpan: mock(() => mockSpan),
      } as unknown as Tracer;

      const toolName = 'test-tool';
      const toolCallId = 'call-123';

      const spanHelper = new LangfuseToolCallSpan(toolName, toolCallId, mockTracer);

      // Verify span creation
      const startSpanMock = mockTracer.startSpan as unknown as ReturnType<typeof mock>;
      expect(startSpanMock).toHaveBeenCalled();
      const startSpanArgs = (startSpanMock.mock.calls as unknown as unknown[][])[0]!;
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
