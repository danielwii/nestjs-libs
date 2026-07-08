import {
  normalizeAuthorizationHeader,
  normalizeCookieHeader,
  normalizeHeadersForLog,
  normalizePayloadForLog,
} from './log-redaction';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

const ORIGINAL_KEY = process.env.LOG_REDACTION_KEY;

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function validJwt(): string {
  return `${b64urlJson({ alg: 'HS256', typ: 'JWT' })}.${b64urlJson({ sub: 'u1' })}.signature`;
}

describe('log redaction normalizers', () => {
  beforeEach(() => {
    process.env.LOG_REDACTION_KEY = 'test-redaction-key';
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) {
      delete process.env.LOG_REDACTION_KEY;
    } else {
      process.env.LOG_REDACTION_KEY = ORIGINAL_KEY;
    }
  });

  it('normalizes a valid Bearer JWT without preserving raw token text', () => {
    const token = validJwt();
    const out = normalizeAuthorizationHeader(`Bearer ${token}`);

    expect(out.present).toBe(true);
    expect(out.scheme).toBe('Bearer');
    expect(out.credential).toMatchObject({
      present: true,
      kind: 'jwt',
      length: token.length,
      fingerprintScope: 'hmac-v1',
      formatStatus: 'ok',
    });
    expect(JSON.stringify(out)).not.toContain(token);
    expect((out.credential as { fingerprint: string }).fingerprint.startsWith('hmac:v1:')).toBe(true);
  });

  it('distinguishes malformed Bearer JWT shape without logging the malformed value', () => {
    const out = normalizeAuthorizationHeader('Bearer abc.def');

    expect(out.credential).toMatchObject({
      present: true,
      kind: 'jwt',
      formatStatus: 'malformed',
      formatError: 'jwt_wrong_segment_count',
    });
    expect(JSON.stringify(out)).not.toContain('abc.def');
  });

  it('marks unsupported authorization schemes without losing safe correlation', () => {
    const out = normalizeAuthorizationHeader('Basic raw-secret');

    expect(out.scheme).toBe('Basic');
    expect(out.credential).toMatchObject({
      present: true,
      kind: 'opaque',
      formatStatus: 'unsupported',
      formatError: 'unsupported_authorization_scheme',
      fingerprintScope: 'hmac-v1',
    });
    expect(JSON.stringify(out)).not.toContain('raw-secret');
  });

  it('keeps opaque API keys diagnosable with stable fingerprints', () => {
    const first = normalizeHeadersForLog({ 'x-api-key': 'sk-live-secret' })['x-api-key'];
    const second = normalizeHeadersForLog({ 'x-api-key': 'sk-live-secret' })['x-api-key'];

    expect(first).toMatchObject({
      present: true,
      kind: 'api_key',
      length: 'sk-live-secret'.length,
      formatStatus: 'ok',
    });
    expect((first as { fingerprint: string }).fingerprint).toBe((second as { fingerprint: string }).fingerprint);
    expect(JSON.stringify(first)).not.toContain('sk-live-secret');
  });

  it('redacts explicit token header names without logging raw header values', () => {
    const out = normalizeHeadersForLog({
      'x-access-token': 'access-secret',
      'x-refresh-token': 'refresh-secret',
      'x-csrf-token': 'csrf-secret',
    });

    expect(out['x-access-token']).toMatchObject({ present: true, kind: 'opaque', formatStatus: 'ok' });
    expect(out['x-refresh-token']).toMatchObject({ present: true, kind: 'opaque', formatStatus: 'ok' });
    expect(out['x-csrf-token']).toMatchObject({ present: true, kind: 'opaque', formatStatus: 'ok' });
    expect(JSON.stringify(out)).not.toContain('access-secret');
    expect(JSON.stringify(out)).not.toContain('refresh-secret');
    expect(JSON.stringify(out)).not.toContain('csrf-secret');
  });

  it('parses cookie names and redacts cookie values', () => {
    const out = normalizeCookieHeader('sid=secret-session; theme=dark; malformed');

    expect(out.present).toBe(true);
    expect(out.names).toEqual(['sid', 'theme']);
    expect(out.malformedPairs).toBe(1);
    expect(out.values.sid).toMatchObject({ present: true, kind: 'cookie_value', formatStatus: 'ok' });
    expect(JSON.stringify(out)).not.toContain('secret-session');
  });

  it('redacts sensitive short payload fields as descriptors', () => {
    const out = normalizePayloadForLog({ password: 'short-secret', nested: { apiKey: 'sk-123' } }) as Record<
      string,
      unknown
    >;

    expect(out.password).toMatchObject({ redacted: true, kind: 'secret', reason: 'sensitive_field' });
    expect(JSON.stringify(out)).not.toContain('short-secret');
    expect(JSON.stringify(out)).not.toContain('sk-123');
  });

  it('redacts long nested strings instead of preserving prefixes', () => {
    const sensitiveContext = 'home address: 123 Secret St\n' + 'x'.repeat(500);
    const out = normalizePayloadForLog({ environment: { enhancements: { careContext: sensitiveContext } } }) as {
      environment: { enhancements: { careContext: unknown } };
    };

    expect(out.environment.enhancements.careContext).toMatchObject({
      redacted: true,
      kind: 'long_string',
      reason: 'log_budget_exceeded',
      length: sensitiveContext.length,
    });
    expect(JSON.stringify(out)).not.toContain('Secret St');
  });

  it('summarizes large arrays and caps object depth', () => {
    expect(normalizePayloadForLog({ values: [1, 2, 3, 4, 5, 6] })).toEqual({
      values: { redacted: true, kind: 'large_array', reason: 'large_array', length: 6 },
    });

    expect(normalizePayloadForLog({ a: { b: { c: { d: { e: 'too deep' } } } } })).toEqual({
      a: { b: { c: { d: { redacted: true, kind: 'object_depth', reason: 'max_depth_exceeded' } } } },
    });
  });

  it('summarizes binary payloads before recursing into byte entries', () => {
    const buffer = Buffer.from('raw-secret');
    const bytes = new Uint8Array([1, 2, 3]);
    const arrayBuffer = new Uint8Array([4, 5, 6, 7]).buffer;
    const out = normalizePayloadForLog({ buffer, nested: { bytes, arrayBuffer } }) as {
      buffer: Record<string, unknown>;
      nested: {
        bytes: Record<string, unknown>;
        arrayBuffer: Record<string, unknown>;
      };
    };

    expect(out.buffer).toEqual({
      redacted: true,
      kind: 'binary',
      reason: 'binary_payload',
      byteLength: buffer.byteLength,
      valueType: 'Buffer',
    });
    expect(out.nested.bytes).toEqual({
      redacted: true,
      kind: 'binary',
      reason: 'binary_payload',
      byteLength: bytes.byteLength,
      valueType: 'Uint8Array',
    });
    expect(out.nested.arrayBuffer).toEqual({
      redacted: true,
      kind: 'binary',
      reason: 'binary_payload',
      byteLength: arrayBuffer.byteLength,
      valueType: 'ArrayBuffer',
    });
    expect(Object.keys(out.buffer)).not.toContain('0');
    expect(Object.keys(out.nested.bytes)).not.toContain('0');
    expect(JSON.stringify(out)).not.toContain('raw-secret');
  });

  it('handles circular references without throwing', () => {
    const value: { self?: unknown } = {};
    value.self = value;

    expect(normalizePayloadForLog(value)).toEqual({
      self: { redacted: true, kind: 'circular_reference', reason: 'circular_reference' },
    });
  });
});
