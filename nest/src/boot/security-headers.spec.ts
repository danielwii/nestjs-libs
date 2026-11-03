/**
 * applySecurityHeaders / API_SECURITY_HEADERS: the api-mode HTTP security response headers.
 *
 * Covers: the default headers on a plain response and on a CORS preflight (the middleware must sit before enableCors);
 * `defaults` replaces the default as a whole (helmet's own defaults still apply when `useDefaults` is left alone);
 * `routes` prefix matching (equal, below, not a longer sibling, query string ignored) and first-match-wins on overlap;
 * every malformed prefix is refused at start-up with Oops.Panic.Config naming the prefix; a controller's own header wins.
 *
 * Each case runs against a real minimal Nest app (listen(0), fetch). The non-api modes are not tested here: the call site is
 * inside `if (isApi)` in bootstrap.ts, which a review checks.
 */
import { Controller, Get, Module, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { Oops } from '@app/nest/exceptions/oops';

import { API_SECURITY_HEADERS, applySecurityHeaders } from './security-headers';

import { afterEach, describe, expect, it } from 'bun:test';

import type { SecurityHeadersOptions } from './security-headers';
import type { INestApplication } from '@nestjs/common';
import type { Response } from 'express';

@Controller()
class ProbeController {
  @Get(['json', 'graphql', 'graphql/x', 'graphqlx', 'api/a', 'a/b/c'])
  json() {
    return { ok: true };
  }

  @Get('override')
  override(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src data:");
    res.setHeader('Referrer-Policy', 'same-origin');
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

const ALLOWED_ORIGIN = 'https://allowed.example';

let running: INestApplication | undefined;

/** Starts the probe app with the headers applied first and CORS enabled after, the order bootstrap uses. */
async function start(options?: SecurityHeadersOptions): Promise<string> {
  const app = await NestFactory.create(ProbeModule, { logger: false });
  applySecurityHeaders(app, options);
  app.enableCors({ origin: ALLOWED_ORIGIN, credentials: true });
  await app.listen(0, '127.0.0.1');
  running = app;
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('the probe app did not bind a TCP port');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await running?.close();
  running = undefined;
});

/** `default-src 'none';frame-ancestors 'none'` → { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] } (separator spelling is helmet's). */
function directivesOf(response: { headers: Headers }): Record<string, string[]> {
  const csp = response.headers.get('content-security-policy');
  if (csp === null) throw new Error('no content-security-policy header');
  return Object.fromEntries(
    csp
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/);
        return [name as string, values];
      }),
  );
}

describe('applySecurityHeaders defaults (T1)', () => {
  it('sends exactly the two API directives, Referrer-Policy no-referrer and X-Frame-Options DENY on a plain response', async () => {
    const base = await start();

    const res = await fetch(`${base}/json`);

    expect(res.status).toBe(200);
    expect(directivesOf(res)).toEqual({ 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] });
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('also sends them on the 204 answer to a preflight from an allowed origin (the middleware sits before enableCors)', async () => {
    const base = await start();

    const res = await fetch(`${base}/json`, {
      method: 'OPTIONS',
      headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'GET' },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(directivesOf(res)).toEqual({ 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] });
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('keeps the helmet defaults the policy does not set (X-Content-Type-Options)', async () => {
    const base = await start();

    const res = await fetch(`${base}/json`);

    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('API_SECURITY_HEADERS is what an app that passes nothing gets', async () => {
    const base = await start({ defaults: API_SECURITY_HEADERS });

    const res = await fetch(`${base}/json`);

    expect(directivesOf(res)).toEqual({ 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] });
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('securityHeaders.defaults replaces the default as a whole (T2)', () => {
  it('with useDefaults: false the policy has only the given directive, none of API_SECURITY_HEADERS', async () => {
    const base = await start({
      defaults: { contentSecurityPolicy: { useDefaults: false, directives: { 'default-src': ["'self'"] } } },
    });

    const res = await fetch(`${base}/json`);

    expect(directivesOf(res)).toEqual({ 'default-src': ["'self'"] });
    // not merged key by key either: X-Frame-Options is helmet's default (SAMEORIGIN), not the DENY of API_SECURITY_HEADERS
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  it('without useDefaults helmet adds its own defaults, but still not the frame-ancestors of API_SECURITY_HEADERS', async () => {
    const base = await start({ defaults: { contentSecurityPolicy: { directives: { 'default-src': ["'self'"] } } } });

    const directives = directivesOf(await fetch(`${base}/json`));

    expect(directives['default-src']).toEqual(["'self'"]);
    expect(directives['script-src']).toEqual(["'self'"]); // helmet's own default
    expect(directives['frame-ancestors']).toEqual(["'self'"]); // helmet's default, not our "'none'"
  });
});

describe('securityHeaders.routes (T3, T4)', () => {
  const relaxed = {
    contentSecurityPolicy: { useDefaults: false, directives: { 'default-src': ["'self'"] } },
    referrerPolicy: { policy: 'same-origin' },
  } as const;

  it('uses the route policy for the prefix, below it and with a query string; the default for a longer sibling and elsewhere', async () => {
    const base = await start({ routes: [{ prefix: '/graphql', helmet: relaxed }] });

    const cases: Array<[string, 'route' | 'default']> = [
      ['/graphql', 'route'],
      ['/graphql/x', 'route'],
      ['/graphql?query=1', 'route'],
      ['/graphqlx', 'default'],
      ['/api/a', 'default'],
    ];
    for (const [path, expected] of cases) {
      const res = await fetch(`${base}${path}`);
      const label = `${path} → ${expected}`;
      expect([label, directivesOf(res)]).toEqual([
        label,
        expected === 'route'
          ? { 'default-src': ["'self'"] }
          : { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] },
      ]);
      expect([label, res.headers.get('referrer-policy')]).toEqual([
        label,
        expected === 'route' ? 'same-origin' : 'no-referrer',
      ]);
    }
  });

  it('with overlapping prefixes the first one in the array wins, in either order', async () => {
    const x = { referrerPolicy: { policy: 'same-origin' } } as const;
    const y = { referrerPolicy: { policy: 'origin' } } as const;

    const firstGroup = await start({
      routes: [
        { prefix: '/a/b', helmet: x },
        { prefix: '/a', helmet: y },
      ],
    });
    expect((await fetch(`${firstGroup}/a/b/c`)).headers.get('referrer-policy')).toBe('same-origin');
    await running?.close();

    const secondGroup = await start({
      routes: [
        { prefix: '/a', helmet: y },
        { prefix: '/a/b', helmet: x },
      ],
    });
    expect((await fetch(`${secondGroup}/a/b/c`)).headers.get('referrer-policy')).toBe('origin');
  });

  it('a route policy replaces the default as a whole: nothing of API_SECURITY_HEADERS is added to it', async () => {
    const base = await start({
      routes: [{ prefix: '/graphql', helmet: { referrerPolicy: { policy: 'same-origin' } } }],
    });

    const res = await fetch(`${base}/graphql`);

    // helmet's own default CSP applies to this route; the default's frame-ancestors 'none' does not.
    expect(directivesOf(res)['frame-ancestors']).toEqual(["'self'"]);
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN'); // helmet's default, not DENY
  });
});

describe('malformed securityHeaders.routes are refused at start-up (T5)', () => {
  const refused = async (routes: unknown, mentions: RegExp) => {
    const app = await NestFactory.create(ProbeModule, { logger: false });
    try {
      let error: unknown;
      try {
        applySecurityHeaders(app, { routes: routes as SecurityHeadersOptions['routes'] });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Oops.Panic);
      expect((error as Oops.Panic).oopsCode).toBe('GN11');
      expect((error as Oops.Panic).internalDetails).toMatch(mentions);
    } finally {
      await app.close();
    }
  };

  it('a prefix without the leading slash (bypassing the type with a cast)', async () => {
    await refused([{ prefix: 'graphql', helmet: {} }], /"graphql".*must start with "\/"/);
  });

  it('a prefix with a trailing slash', async () => {
    await refused([{ prefix: '/graphql/', helmet: {} }], /"\/graphql\/".*must not end with "\/"/);
  });

  it('the root prefix, which would be the whole site', async () => {
    await refused([{ prefix: '/', helmet: {} }], /"\/".*whole site.*securityHeaders\.defaults/);
  });

  it('the same prefix twice', async () => {
    await refused(
      [
        { prefix: '/graphql', helmet: {} },
        { prefix: '/graphql', helmet: {} },
      ],
      /"\/graphql".*more than once/,
    );
  });

  it('a prefix that is not a string at all', async () => {
    await refused([{ prefix: 42, helmet: {} }], /42.*must start with "\/"/);
  });

  it('refuses before anything is mounted: the app has no security middleware after a failed call', async () => {
    const app = await NestFactory.create(ProbeModule, { logger: false });
    running = app;
    expect(() =>
      applySecurityHeaders(app, { routes: [{ prefix: 'bad' as unknown as `/${string}`, helmet: {} }] }),
    ).toThrow();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('the probe app did not bind a TCP port');

    const res = await fetch(`http://127.0.0.1:${address.port}/json`);

    expect(res.headers.get('content-security-policy')).toBeNull();
  });
});

describe('a controller that sets its own headers (T7)', () => {
  it('its Content-Security-Policy and Referrer-Policy win over the default', async () => {
    const base = await start();

    const res = await fetch(`${base}/override`);

    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'; img-src data:");
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    // the headers it did not set are still the default's
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});
