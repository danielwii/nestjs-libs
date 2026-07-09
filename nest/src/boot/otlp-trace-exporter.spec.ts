import {
  createOtlpTraceProcessor,
  describeOtlpEndpoint,
  parseOtlpHeaders,
  resolveOtelServiceName,
  resolveOtlpTraceEndpoint,
  resolveOtlpTraceExportConfig,
  resolveOtlpTraceHeaders,
  resolveOtlpTraceProtocol,
} from './otlp-trace-exporter';

import { describe, expect, it } from 'bun:test';

describe('otlp trace exporter helpers', () => {
  it('resolves service.name from explicit env precedence', () => {
    expect(resolveOtelServiceName({ OTEL_SERVICE_NAME: 'otel', APP_NAME: 'app', SERVICE_NAME: 'svc' })).toBe('otel');
    expect(resolveOtelServiceName({ APP_NAME: 'app', SERVICE_NAME: 'svc' })).toBe('app');
    expect(resolveOtelServiceName({ SERVICE_NAME: 'svc' })).toBe('svc');
    expect(resolveOtelServiceName({})).toBe('unknown_service');
  });

  it('parses standard OTLP comma-separated headers', () => {
    expect(parseOtlpHeaders('Authorization=Bearer token,X-Scope-OrgID=tenant-1, empty = spaced ')).toEqual({
      Authorization: 'Bearer token',
      'X-Scope-OrgID': 'tenant-1',
      empty: 'spaced',
    });
  });

  it('decodes baggage-style percent-encoded OTLP header parts', () => {
    expect(parseOtlpHeaders('Authorization=Bearer%20abc,X-Token=part%2Cone%3Dtwo,X%2DEncoded=value')).toEqual({
      Authorization: 'Bearer abc',
      'X-Token': 'part,one=two',
      'X-Encoded': 'value',
    });
  });

  it('ignores malformed OTLP header pairs', () => {
    expect(parseOtlpHeaders('no-equals,=empty-key,invalid=%E0%A4%A,ok=yes')).toEqual({ ok: 'yes' });
  });

  it('prefers trace-specific OTLP headers over generic OTLP headers', () => {
    expect(
      resolveOtlpTraceHeaders({
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer generic,X-Scope-OrgID=all',
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'Authorization=Bearer traces,X-Scope-OrgID=trace-only',
      }),
    ).toEqual({
      Authorization: 'Bearer traces',
      'X-Scope-OrgID': 'trace-only',
    });
    expect(
      resolveOtlpTraceHeaders({
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer generic',
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'Authorization=Bearer%20traces',
      }),
    ).toEqual({ Authorization: 'Bearer traces' });
    expect(
      resolveOtlpTraceHeaders({
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer%20generic',
      }),
    ).toEqual({ Authorization: 'Bearer generic' });
  });

  it('resolves OTLP trace protocol with signal-specific precedence', () => {
    expect(resolveOtlpTraceProtocol({})).toEqual({ supported: true, protocol: 'http/protobuf' });
    expect(resolveOtlpTraceProtocol({ OTEL_EXPORTER_OTLP_PROTOCOL: 'HTTP/PROTOBUF' })).toEqual({
      supported: true,
      protocol: 'http/protobuf',
    });
    expect(
      resolveOtlpTraceProtocol({
        OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
        OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/protobuf',
      }),
    ).toEqual({ supported: true, protocol: 'http/protobuf' });
  });

  it('disables the HTTP trace exporter for unsupported OTLP protocols', () => {
    expect(resolveOtlpTraceProtocol({ OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' })).toEqual({
      supported: false,
      protocol: 'grpc',
      warning:
        'OTLP trace protocol grpc is configured but this preload only supports http/protobuf; OTLP trace exporter disabled',
    });
    expect(resolveOtlpTraceProtocol({ OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/json' })).toEqual({
      supported: false,
      protocol: 'http/json',
      warning:
        'OTLP trace protocol http/json is configured but this preload only supports http/protobuf; OTLP trace exporter disabled',
    });
    expect(resolveOtlpTraceProtocol({ OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'bogus' })).toEqual({
      supported: false,
      protocol: 'bogus',
      warning:
        'OTLP trace protocol bogus is not recognized; this preload only supports http/protobuf; OTLP trace exporter disabled',
    });
  });

  it('resolves disabled and enabled OTLP configs', () => {
    expect(resolveOtlpTraceExportConfig({})).toEqual({ enabled: false });
    expect(
      resolveOtlpTraceExportConfig({
        OTEL_EXPORTER_OTLP_ENDPOINT: ' http://tempo:4318 ',
        OTEL_EXPORTER_OTLP_HEADERS: 'X-Scope-OrgID=1',
      }),
    ).toEqual({
      enabled: true,
      protocol: 'http/protobuf',
      endpoint: 'http://tempo:4318/v1/traces',
      headers: { 'X-Scope-OrgID': '1' },
    });
    expect(
      resolveOtlpTraceExportConfig({
        OTEL_EXPORTER_OTLP_ENDPOINT: ' http://tempo:4318 ',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer generic',
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'Authorization=Bearer traces',
      }),
    ).toEqual({
      enabled: true,
      protocol: 'http/protobuf',
      endpoint: 'http://tempo:4318/v1/traces',
      headers: { Authorization: 'Bearer traces' },
    });
    expect(
      resolveOtlpTraceExportConfig({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://tempo:4317',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
      }),
    ).toEqual({
      enabled: false,
      warning:
        'OTLP trace protocol grpc is configured but this preload only supports http/protobuf; OTLP trace exporter disabled',
    });
  });

  it('constructs trace endpoints from the standard OTLP base endpoint', () => {
    expect(resolveOtlpTraceEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://tempo:4318' })).toBe(
      'http://tempo:4318/v1/traces',
    );
    expect(resolveOtlpTraceEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://tempo:4318/' })).toBe(
      'http://tempo:4318/v1/traces',
    );
    expect(resolveOtlpTraceEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://tempo:4318/collector' })).toBe(
      'http://tempo:4318/collector/v1/traces',
    );
    expect(resolveOtlpTraceEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://tempo:4318/v1/traces' })).toBe(
      'http://tempo:4318/v1/traces',
    );
  });

  it('prefers the trace-specific OTLP endpoint as an explicit full trace URL', () => {
    expect(
      resolveOtlpTraceEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://tempo:4318',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: ' http://traces:4318/custom-traces ',
      }),
    ).toBe('http://traces:4318/custom-traces');
  });

  it('creates a processor only when enabled and dependencies are present', () => {
    const calls: unknown[] = [];
    class FakeExporter {
      constructor(opts: unknown) {
        calls.push(['exporter', opts]);
      }
    }
    class FakeBatchProcessor {
      constructor(exporter: unknown) {
        calls.push(['processor', exporter instanceof FakeExporter]);
      }
    }

    expect(createOtlpTraceProcessor({ enabled: false }, {})).toBeNull();
    expect(
      createOtlpTraceProcessor(
        { enabled: true, protocol: 'http/protobuf', endpoint: 'http://tempo:4318/v1/traces', headers: {} },
        {},
      ),
    ).toBeNull();

    const processor = createOtlpTraceProcessor(
      {
        enabled: true,
        protocol: 'http/protobuf',
        endpoint: 'http://tempo:4318/v1/traces',
        headers: { Authorization: 'Bearer token' },
      },
      { OTLPTraceExporter: FakeExporter, BatchSpanProcessor: FakeBatchProcessor },
    );

    expect(processor).toBeInstanceOf(FakeBatchProcessor);
    expect(calls[0]).toEqual([
      'exporter',
      { url: 'http://tempo:4318/v1/traces', headers: { Authorization: 'Bearer token' } },
    ]);
    expect(calls[1]).toEqual(['processor', true]);
  });

  it('describes OTLP endpoints without credentials', () => {
    expect(describeOtlpEndpoint('https://user:pass@example.com:4318/v1/traces?secret=1')).toBe(
      'https://example.com:4318/v1/traces',
    );
  });
});
