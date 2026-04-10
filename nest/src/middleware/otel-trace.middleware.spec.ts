/**
 * otelTraceMiddleware 单元测试
 *
 * 关注点：
 * 1. 非 Sentry 模式：自建 span，X-Trace-Id / traceparent 在 next() 之前就写到 response header 上
 *    ——这是 Bug 2 的核心修复，确保 guard 抛异常路径也能带 trace 信息
 * 2. traceId 格式合法（W3C 32 字符 hex）
 * 3. 健康检查路径：不建 span 也不写 header（next 直接调用）
 * 4. Sentry 模式（SENTRY_DSN 已配置）：不自建 span，读取 active span（Sentry 建的）后写 header
 */
import { otelTraceMiddleware } from './otel-trace.middleware';

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import type { NextFunction, Request, Response } from 'express';

interface MockRes {
  setHeader: ReturnType<typeof mock>;
  on: ReturnType<typeof mock>;
  statusCode: number;
  _headers: Record<string, string>;
}

function createMockRes(): MockRes {
  const headers: Record<string, string> = {};
  return {
    setHeader: mock((key: string, value: string) => {
      headers[key] = value;
    }),
    on: mock(() => undefined),
    statusCode: 200,
    _headers: headers,
  };
}

function createMockReq(url: string, headers: Record<string, string> = {}): Request {
  return {
    url,
    method: 'GET',
    headers,
  } as unknown as Request;
}

describe('otelTraceMiddleware', () => {
  // 所有测试默认在非 Sentry 模式下运行。Sentry 模式有单独的 describe block。
  const originalSentryDsn = process.env.SENTRY_DSN;
  beforeEach(() => {
    delete process.env.SENTRY_DSN;
  });
  afterEach(() => {
    if (originalSentryDsn !== undefined) {
      process.env.SENTRY_DSN = originalSentryDsn;
    } else {
      delete process.env.SENTRY_DSN;
    }
  });

  it('非健康检查路径：在 next() 之前设置 X-Trace-Id / traceparent', () => {
    const req = createMockReq('/graphql');
    const res = createMockRes();

    // 用 next 作为锚点验证 header 设置时机：next 被调用时 header 已存在
    let headerAtNextCall: Record<string, string> | null = null;
    const next: NextFunction = mock(() => {
      headerAtNextCall = { ...res._headers };
    });

    otelTraceMiddleware(req, res as unknown as Response, next);

    // next 已被调用
    expect(next).toHaveBeenCalled();
    // 验证 setHeader 在 next 执行之前就把 header 写好了
    expect(headerAtNextCall).not.toBeNull();
    expect(headerAtNextCall).toHaveProperty('X-Trace-Id');
    expect(headerAtNextCall).toHaveProperty('traceparent');
  });

  it('X-Trace-Id 是 32 字符 hex (OTel spec)', () => {
    const req = createMockReq('/api/something');
    const res = createMockRes();
    const next: NextFunction = mock(() => undefined);

    otelTraceMiddleware(req, res as unknown as Response, next);

    const traceId = res._headers['X-Trace-Id'];
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('traceparent 格式符合 W3C Trace Context', () => {
    const req = createMockReq('/api/something');
    const res = createMockRes();
    const next: NextFunction = mock(() => undefined);

    otelTraceMiddleware(req, res as unknown as Response, next);

    const traceparent = res._headers.traceparent;
    // 00-{32hex traceId}-{16hex spanId}-{2hex flags}
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
  });

  it('X-Trace-Id 与 traceparent 里的 trace id 一致', () => {
    const req = createMockReq('/api/something');
    const res = createMockRes();
    const next: NextFunction = mock(() => undefined);

    otelTraceMiddleware(req, res as unknown as Response, next);

    const traceId = res._headers['X-Trace-Id'];
    const traceparent = res._headers.traceparent;
    expect(traceparent).toContain(`-${traceId}-`);
  });

  it('健康检查路径 `/` → 不设置 header', () => {
    const req = createMockReq('/');
    const res = createMockRes();
    const next: NextFunction = mock(() => undefined);

    otelTraceMiddleware(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(res._headers['X-Trace-Id']).toBeUndefined();
  });

  it('健康检查路径 `/health` → 不设置 header', () => {
    const req = createMockReq('/health');
    const res = createMockRes();
    const next: NextFunction = mock(() => undefined);

    otelTraceMiddleware(req, res as unknown as Response, next);

    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('健康检查路径 `/health/live` → 不设置 header', () => {
    const req = createMockReq('/health/live');
    const res = createMockRes();
    const next: NextFunction = mock(() => undefined);

    otelTraceMiddleware(req, res as unknown as Response, next);

    expect(res.setHeader).not.toHaveBeenCalled();
  });

  // 注：W3C traceparent 继承的单元测试需要真实 OTel SDK（BasicTracerProvider 等）
  // 才能验证 traceId 透传，本 spec 只覆盖中间件自身行为。传播链路由 OTel 生态保证。

  describe('Sentry 模式 (SENTRY_DSN 已配置)', () => {
    beforeEach(() => {
      process.env.SENTRY_DSN = 'https://dummy@example.com/1';
    });

    it('无 active span 时：不调用 setHeader，正常调用 next（Sentry 未挂 instrumentation 的兜底）', () => {
      const req = createMockReq('/graphql');
      const res = createMockRes();
      const next: NextFunction = mock(() => undefined);

      otelTraceMiddleware(req, res as unknown as Response, next);

      expect(next).toHaveBeenCalled();
      // 无 active span → 不写 header；这是 Sentry 没初始化成功的退化场景，不应崩
      expect(res._headers['X-Trace-Id']).toBeUndefined();
      expect(res._headers.traceparent).toBeUndefined();
    });

    it('健康检查路径仍然跳过（与 Sentry 模式解耦）', () => {
      const req = createMockReq('/health');
      const res = createMockRes();
      const next: NextFunction = mock(() => undefined);

      otelTraceMiddleware(req, res as unknown as Response, next);

      expect(next).toHaveBeenCalled();
      expect(res.setHeader).not.toHaveBeenCalled();
    });
  });
});
