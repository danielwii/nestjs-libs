/**
 * otelTraceMiddleware 单元测试
 *
 * 关注点：
 * 1. 非 Sentry 模式：自建 span，X-Trace-Id / traceparent 在 next() 之前就写到 response header 上
 *    ——这是 Bug 2 的核心修复，确保 guard 抛异常路径也能带 trace 信息
 * 2. traceId 格式合法（W3C 32 字符 hex）
 * 3. 健康检查路径：不建 span 也不写 header（next 直接调用）
 * 4. Sentry 模式（SENTRY_DSN 已配置）：不自建 span，读取 active span（Sentry 建的）后写 header
 * 5. span 名与请求内日志的 spanName 用路由模板，不带原始 URL 里的 token / 查询串（真实 Nest app，子进程跑）
 */
import { otelTraceMiddleware } from './otel-trace.middleware';

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

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

    it('无 active span 时：fall through 自建 span，header 仍然写上（errors-only Sentry 不建 HTTP span）', () => {
      // 自 Sentry/OTel 分家（skipOpenTelemetrySetup + tracesSampleRate:0）起，Sentry 的
      // httpIntegration 自动 spans:false —— Sentry 模式下 active context 里【永远】没有
      // SERVER span。旧契约「无 active span → 不写 header」让 X-Trace-Id 在所有配置了
      // SENTRY_DSN 的环境静默消失（staging 实测断了半个月无人察觉）。新契约：读不到
      // Sentry span 就走自建 span 分支，任何配置组合响应都必须带 trace header。
      const req = createMockReq('/graphql');
      const res = createMockRes();
      const next: NextFunction = mock(() => undefined);

      otelTraceMiddleware(req, res as unknown as Response, next);

      expect(next).toHaveBeenCalled();
      expect(res._headers['X-Trace-Id']).toMatch(/^[0-9a-f]{32}$/);
      expect(res._headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
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

describe('otelTraceMiddleware span name (real Nest app, real tracer provider)', () => {
  // A credential in a path segment (calo's 32-hex invite token) and another in the query string.
  const PATH_TOKEN = '5f0c2a9e8d7b46c1a3e2f1d0c9b8a7e6';
  const QUERY_TOKEN = 'b1c2d3e4f5a6978877665544332211ff';

  interface FixtureOutput {
    statuses: number[];
    spans: Array<{ name: string; attributes: Record<string, unknown> }>;
    logs: Array<{ message: string; spanName?: string }>;
  }

  // 子进程：注册全局 tracer provider 会污染同一进程里的其它 spec
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dir, 'otel-trace.middleware.fixture.ts'), PATH_TOKEN, QUERY_TOKEN],
    { cwd: join(import.meta.dir, '../../..'), encoding: 'utf8' },
  );
  const output = (): FixtureOutput => {
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout.trim()) as FixtureOutput;
  };

  it('names the span after the route template once the route is matched', () => {
    const { statuses, spans } = output();

    expect(statuses).toEqual([200, 401, 404, 404, 404]);
    expect(spans.map((span) => span.name)).toEqual([
      'GET /api/invites/:token',
      // guard 拒绝：interceptor 没跑，finish 时改名
      'POST /api/members/:token/withdraw-invite',
      // 未匹配（Nest 前缀下的 catch-all / 前缀外）：去掉查询串的路径
      'GET /api/unknown/segment',
      'GET /outside/segment',
      'GET /api/members/:id',
    ]);
    expect(spans[0]?.attributes['http.route']).toBe('/api/invites/:token');
    expect(spans[0]?.attributes['http.status_code']).toBe(200);
    expect(spans[2]?.attributes['http.route']).toBeUndefined();
  });

  it('keeps the token in the path and the query string out of span names, attributes and log spanName', () => {
    const { spans, logs } = output();

    const handlerLog = logs.find((log) => log.message === 'handler ran');
    expect(handlerLog?.spanName).toBe('GET /api/invites/:token');
    // guard 先于 interceptor：路由模板还没写进 span，只有 method
    const guardLog = logs.find((log) => log.message === 'guard ran');
    expect(guardLog?.spanName).toBe('POST');

    const everything = JSON.stringify({ spans, logs });
    expect(everything).not.toContain(PATH_TOKEN);
    expect(everything).not.toContain(QUERY_TOKEN);
  });

  it("writes Nest's route 404 to the log without the query string (AnyExceptionFilter)", () => {
    const { logs } = output();

    // Nest 抛的是 `Cannot GET /api/unknown/segment?token=…`；过滤器的 warning 写不带查询串的路径
    const notFound = logs.filter((log) => log.message.includes('NotFoundException(404)'));
    expect(notFound.map((log) => log.message.match(/Cannot GET \S+/)?.[0])).toContain(
      'Cannot GET /api/unknown/segment',
    );
    expect(JSON.stringify(notFound)).not.toContain(QUERY_TOKEN);
    // 应用自己抛的 404 不是 Nest 的路由 404：保留自己的文字
    expect(notFound.some((log) => log.message.includes('Member not found'))).toBe(true);
  });
});
