/**
 * Sentry sends structure only (data-exposure spec S12, test T44). The first group drives the real `@sentry/bun` with a
 * transport that keeps every envelope, so what is asserted is what would leave the process.
 */
import { Oops } from '@app/nest/exceptions/oops';

import { REMOVED_TEXT, sentryStructureOptions, structureOfBreadcrumb, structureOfEvent } from './sentry-structure';

import * as Sentry from '@sentry/bun';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

const SECRET = 'SECRET-d41d8cd9';

let envelopes: unknown[] = [];

function init(extra: Record<string, unknown> = {}) {
  Sentry.init({
    dsn: 'https://public@example.invalid/1',
    defaultIntegrations: false,
    integrations: [],
    transport: () => ({
      send: async (envelope: unknown) => {
        envelopes.push(envelope);
        return {};
      },
      flush: async () => true,
    }),
    // the options are typed loosely on purpose (the SDK is an optional dependency of this library)
    ...(sentryStructureOptions() as unknown as Partial<Sentry.BunOptions>),
    ...extra,
  });
}

const sentText = () => JSON.stringify(envelopes);
const itemTypes = () =>
  (envelopes as Array<[unknown, Array<[{ type?: string }, unknown]>]>).flatMap(([, items]) =>
    items.map(([header]) => header.type),
  );

beforeEach(() => {
  envelopes = [];
});

afterEach(async () => {
  await Sentry.close(1000);
});

describe('what leaves through the real SDK', () => {
  it('carries no text from an error, its cause, an Oops, a free-text context, a breadcrumb or the user', async () => {
    init();
    Sentry.addBreadcrumb({ category: 'console', message: `${SECRET}-console` });
    Sentry.addBreadcrumb({
      category: 'fetch',
      type: 'http',
      message: `${SECRET}-crumb`,
      data: { url: `https://x.invalid/?k=${SECRET}` },
    });
    Sentry.setUser({ id: 'user-1', email: `${SECRET}@example.invalid`, username: SECRET, ip_address: '203.0.113.9' });
    Sentry.setExtra('payload', `${SECRET}-extra`);
    Sentry.setTag('turn', 'turn-9');
    Sentry.setTag('free', `${SECRET} free text`);
    Sentry.setContext('llm', { providerError: `${SECRET}-provider` });

    Sentry.captureException(new Error(`${SECRET}-message`, { cause: new TypeError(`${SECRET}-cause`) }));
    Sentry.captureException(Oops.Panic.Config(`${SECRET}-oops`, { cause: new RangeError(`${SECRET}-inner`) }));
    await Sentry.flush(1000);

    expect(envelopes.length).toBeGreaterThanOrEqual(2);
    const text = sentText();
    expect(text).not.toContain('SECRET-');
    expect(text).not.toContain('203.0.113.9');
    // structure that must survive
    expect(text).toContain('"user":{"id":"user-1"}');
    expect(text).toContain('turn-9');
    expect(text).toContain('"name":"Error"');
    expect(text).toContain('"causes":["TypeError"]');
    expect(text).toContain('"code":"0x0402GN11"');
    expect(text).toContain('"causes":["RangeError"]');
    expect(text).toContain('TypeError');
  });

  it('keeps dropping the noise events', async () => {
    init();
    Sentry.captureException(new Error('MISSING_ENV_FILE .env not found'));
    Sentry.captureMessage('DeprecationWarning: something');
    await Sentry.flush(1000);
    expect(itemTypes()).not.toContain('event');
  });

  it('sends a captured message without its text', async () => {
    init();
    Sentry.captureMessage(`${SECRET}-captured`);
    await Sentry.flush(1000);
    expect(itemTypes()).toContain('event');
    expect(sentText()).not.toContain('SECRET-');
  });

  it('sends no transaction when tracing is switched on, and no log when Sentry Logs is switched on', async () => {
    init({ tracesSampleRate: 1, enableLogs: true });
    Sentry.startSpan({ name: `${SECRET}-transaction` }, () => undefined);
    Sentry.logger.info(`${SECRET}-log`);
    await Sentry.flush(1000);
    expect(sentText()).not.toContain('SECRET-');
    expect(itemTypes()).not.toContain('transaction');
    expect(itemTypes()).not.toContain('log');
  });
});

describe('the options', () => {
  it('leave tracing and logs out, turn default PII off, and drop transactions and logs', () => {
    const options = sentryStructureOptions();
    expect(Object.keys(options).sort()).toEqual(
      [
        'beforeBreadcrumb',
        'beforeSend',
        'beforeSendLog',
        'beforeSendTransaction',
        'sendDefaultPii',
        'traceLifecycle',
      ].sort(),
    );
    expect(options.sendDefaultPii).toBe(false);
    expect(options.traceLifecycle).toBe('static');
    expect(options.beforeSendTransaction()).toBeNull();
    expect(options.beforeSendLog()).toBeNull();
  });
});

describe('structureOfEvent', () => {
  it('puts a marker where a message-only event had text', () => {
    expect(structureOfEvent({ event_id: 'e1', message: SECRET })).toEqual({
      event_id: 'e1',
      logentry: { message: REMOVED_TEXT },
    });
  });

  it('rebuilds the event from an allowlist: an unknown field is dropped, frames lose variables and source lines', () => {
    const out = structureOfEvent({
      event_id: 'e1',
      level: 'error',
      newField: SECRET,
      request: { url: SECRET, data: SECRET },
      transaction: SECRET,
      fingerprint: [SECRET],
      exception: {
        values: [
          {
            type: 'Error',
            value: SECRET,
            stacktrace: {
              frames: [
                {
                  filename: 'a.ts',
                  function: 'f',
                  lineno: 3,
                  vars: { x: SECRET },
                  context_line: SECRET,
                  pre_context: [SECRET],
                },
              ],
            },
          },
        ],
      },
    });
    expect(JSON.stringify(out)).not.toContain('SECRET-');
    expect(out).toMatchObject({
      event_id: 'e1',
      exception: {
        values: [{ type: 'Error', stacktrace: { frames: [{ filename: 'a.ts', function: 'f', lineno: 3 }] } }],
      },
    });
  });

  it('replaces an exception type that is not a class name, and a tag whose value is free text', () => {
    const out = structureOfEvent({
      exception: { values: [{ type: `has spaces ${SECRET}`, value: 'x' }] },
      tags: { ok: 'a-b_1', free: `${SECRET} text` },
    });
    expect(out).toMatchObject({ exception: { values: [{ type: 'Error' }] }, tags: { ok: 'a-b_1' } });
    expect(JSON.stringify(out)).not.toContain('SECRET-');
  });
});

describe('structureOfBreadcrumb', () => {
  it('drops console breadcrumbs and the text of the others', () => {
    expect(structureOfBreadcrumb({ category: 'console', message: SECRET })).toBeNull();
    expect(
      structureOfBreadcrumb({
        category: 'fetch',
        type: 'http',
        level: 'info',
        message: SECRET,
        data: { url: SECRET },
        timestamp: 1,
      }),
    ).toEqual({
      timestamp: 1,
      type: 'http',
      category: 'fetch',
      level: 'info',
    });
  });
});
