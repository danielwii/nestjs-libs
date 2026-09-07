import 'reflect-metadata';

import {
  configurePrivateHttpPaths,
  redactHttpRequestForTelemetry,
  redactHttpUrl,
  redactHttpUrlForPath,
} from './http-url-redaction';
import { configureSensitivePayloadKeys, normalizePayloadForLog } from './log-redaction';
import { LoggerInterceptor } from './logger.interceptor';
import { PRIVATE_PAYLOAD } from './private-payload.decorator';

import { afterEach, expect, it } from 'bun:test';
import { of } from 'rxjs';

afterEach(() => {
  configurePrivateHttpPaths([]);
  configureSensitivePayloadKeys([]);
});

it('private endpoints never inspect URLs, payloads or errors through the generic logger', () => {
  const handler = () => undefined;
  Reflect.defineMetadata(PRIVATE_PAYLOAD, true, handler);
  const result = of('private result');
  const context = {
    getHandler: () => handler,
    getClass: () => Object,
    switchToHttp: () => {
      throw new Error('must not read sensitive request');
    },
  };
  expect(new LoggerInterceptor().intercept(context as never, { handle: () => result } as never)).toBe(result);
});

it('an app declares its own private field names; the library ships none', () => {
  const payload = { fromAddress: 'PRIVATE_EMAIL', subject: 'PRIVATE_SUBJECT' };
  expect(JSON.stringify(normalizePayloadForLog(payload))).toContain('PRIVATE_EMAIL');

  configureSensitivePayloadKeys(['fromAddress', 'subject']);
  const safe = JSON.stringify(normalizePayloadForLog(payload));
  expect(safe).not.toContain('PRIVATE_');
  expect(safe).toContain('sensitive_field');
});

it('ordinary URLs stay legible; only credential query values are replaced', () => {
  expect(redactHttpUrl('/api/events?limit=20&cursor=abc&sort=desc')).toBe('/api/events?limit=20&cursor=abc&sort=desc');
  expect(redactHttpUrl('https://app.example/oauth/callback?code=SECRET&state=SECRET&provider=google')).toBe(
    'https://app.example/oauth/callback?code=[redacted]&state=[redacted]&provider=google',
  );
  // A long path segment is not a credential unless the app says the path is private.
  expect(redactHttpUrl('/api/objects/' + 'a'.repeat(43))).toBe('/api/objects/' + 'a'.repeat(43));
});

it('declared private paths drop the query and opaque path segments entirely', () => {
  configurePrivateHttpPaths(['/api/email-connections']);
  expect(redactHttpUrlForPath('/api/email-connections/link/' + 's'.repeat(43))).toBe(
    '/api/email-connections/link/[redacted]',
  );
  expect(redactHttpUrlForPath('/api/email-connections/google/callback?code=SECRET#SECRET')).toBe(
    '/api/email-connections/google/callback',
  );
  // A referrer pointing at a private page is judged by where it points.
  expect(redactHttpUrlForPath('https://calo.example/api/email-connections/link/' + 's'.repeat(43))).toBe(
    'https://calo.example/api/email-connections/link/[redacted]',
  );
});

it('private HTTP error telemetry drops browser cookies, JWTs and login bodies', () => {
  configurePrivateHttpPaths(['/api/email-connections']);
  const result = redactHttpRequestForTelemetry({
    url: '/api/email-connections/google/callback?code=PRIVATE_CODE',
    method: 'GET',
    headers: { cookie: 'PRIVATE_COOKIE', authorization: 'PRIVATE_JWT' },
    data: 'PRIVATE_BODY',
    cookies: 'PRIVATE_COOKIE',
    query_string: 'code=PRIVATE_CODE',
  });
  expect(result).toEqual({ url: '/api/email-connections/google/callback', method: 'GET' });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_');
});

it('other paths keep their error telemetry, with credential query values replaced', () => {
  const result = redactHttpRequestForTelemetry({
    url: '/api/events?limit=20&token=PRIVATE_TOKEN',
    method: 'POST',
    query_string: 'limit=20&token=PRIVATE_TOKEN',
  });
  expect(result).toMatchObject({
    url: '/api/events?limit=20&token=[redacted]',
    method: 'POST',
    query_string: 'limit=20&token=[redacted]',
  });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_');
});
