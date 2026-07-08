export type OtlpTraceExportConfig =
  | { enabled: false; warning?: string }
  | {
      enabled: true;
      protocol: 'http/protobuf';
      endpoint: string;
      headers: Record<string, string>;
    };

export type OtlpTraceExporterConstructor<TExporter> = new (opts: {
  url: string;
  headers?: Record<string, string>;
}) => TExporter;
export type BatchSpanProcessorConstructor<TExporter, TProcessor> = new (exporter: TExporter) => TProcessor;
export type EnvMap = Record<string, string | undefined>;
export type OtlpTraceProtocolResolution =
  { supported: true; protocol: 'http/protobuf' } | { supported: false; protocol: string; warning: string };

export function resolveOtelServiceName(env: EnvMap = process.env): string {
  return env.OTEL_SERVICE_NAME ?? env.APP_NAME ?? env.SERVICE_NAME ?? 'unknown_service';
}

export function parseOtlpHeaders(headersEnv: string | undefined): Record<string, string> {
  if (!headersEnv?.trim()) return {};
  const headers: Record<string, string> = {};
  for (const pair of headersEnv.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = decodeOtlpHeaderPart(trimmed.slice(0, idx).trim());
    const value = decodeOtlpHeaderPart(trimmed.slice(idx + 1).trim());
    if (key === null || value === null) continue;
    if (key) headers[key] = value;
  }
  return headers;
}

function decodeOtlpHeaderPart(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

export function describeOtlpEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return endpoint.replace(/\/\/[^/@]+@/, '//***@');
  }
}

export function resolveOtlpTraceEndpoint(env: EnvMap = process.env): string | undefined {
  const traceEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (traceEndpoint) return normalizeOtlpTraceEndpoint(traceEndpoint, 'trace');

  const baseEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!baseEndpoint) return undefined;
  return normalizeOtlpTraceEndpoint(baseEndpoint, 'base');
}

function normalizeOtlpTraceEndpoint(endpoint: string, source: 'base' | 'trace'): string {
  if (source === 'trace') return endpoint;

  try {
    const url = new URL(endpoint);
    url.pathname = appendTracePath(url.pathname);
    return url.toString();
  } catch {
    return appendTracePath(endpoint);
  }
}

function appendTracePath(pathOrEndpoint: string): string {
  const trimmed = pathOrEndpoint.replace(/\/+$/, '');
  if (trimmed.endsWith('/v1/traces')) return trimmed;
  return `${trimmed}/v1/traces`;
}

export function resolveOtlpTraceHeaders(env: EnvMap = process.env): Record<string, string> {
  const traceHeaders = env.OTEL_EXPORTER_OTLP_TRACES_HEADERS?.trim();
  return parseOtlpHeaders(traceHeaders ? env.OTEL_EXPORTER_OTLP_TRACES_HEADERS : env.OTEL_EXPORTER_OTLP_HEADERS);
}

export function resolveOtlpTraceProtocol(env: EnvMap = process.env): OtlpTraceProtocolResolution {
  const rawProtocol =
    resolveNonEmptyEnvValue(env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL) ??
    resolveNonEmptyEnvValue(env.OTEL_EXPORTER_OTLP_PROTOCOL);
  if (!rawProtocol) return { supported: true, protocol: 'http/protobuf' };

  const protocol = rawProtocol.toLowerCase();
  if (protocol === 'http/protobuf') return { supported: true, protocol };

  if (protocol === 'grpc' || protocol === 'http/json') {
    return {
      supported: false,
      protocol,
      warning: `OTLP trace protocol ${protocol} is configured but this preload only supports http/protobuf; OTLP trace exporter disabled`,
    };
  }

  return {
    supported: false,
    protocol: rawProtocol,
    warning: `OTLP trace protocol ${rawProtocol} is not recognized; this preload only supports http/protobuf; OTLP trace exporter disabled`,
  };
}

function resolveNonEmptyEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

export function resolveOtlpTraceExportConfig(env: EnvMap = process.env): OtlpTraceExportConfig {
  const endpoint = resolveOtlpTraceEndpoint(env);
  if (!endpoint) return { enabled: false };
  const protocol = resolveOtlpTraceProtocol(env);
  if (!protocol.supported) return { enabled: false, warning: protocol.warning };
  return {
    enabled: true,
    protocol: protocol.protocol,
    endpoint,
    headers: resolveOtlpTraceHeaders(env),
  };
}

export function createOtlpTraceProcessor<TExporter, TProcessor>(
  config: OtlpTraceExportConfig,
  deps: {
    OTLPTraceExporter?: OtlpTraceExporterConstructor<TExporter> | null;
    BatchSpanProcessor?: BatchSpanProcessorConstructor<TExporter, TProcessor> | null;
  },
): TProcessor | null {
  if (!config.enabled) return null;
  if (!deps.OTLPTraceExporter || !deps.BatchSpanProcessor) return null;

  const exporter = new deps.OTLPTraceExporter({
    url: config.endpoint,
    headers: config.headers,
  });
  return new deps.BatchSpanProcessor(exporter);
}
