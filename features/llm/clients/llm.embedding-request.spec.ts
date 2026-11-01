import 'reflect-metadata';

import { SysEnv } from '@app/env';

import { LLM } from './llm.class';

import { configure, reset } from '@logtape/logtape';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { LogRecord } from '@logtape/logtape';

const sysEnvMut = SysEnv as unknown as Record<string, string | undefined>;
const KEY_PROBE = 'probe-embedding-key-9d2b';

interface Captured {
  url: string;
  headers: Headers;
}

describe('Gemini embedding request', () => {
  const originalFetch = globalThis.fetch;
  const originalKey = sysEnvMut.AI_GOOGLE_API_KEY;
  let captured: Captured[] = [];
  let records: LogRecord[] = [];

  beforeEach(async () => {
    captured = [];
    records = [];
    sysEnvMut.AI_GOOGLE_API_KEY = KEY_PROBE;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({
        url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
        headers: new Headers(init?.headers),
      });
      return new Response(JSON.stringify({ embedding: { values: [0.1, 0.2, 0.3] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    await configure({
      reset: true,
      sinks: { memory: (record) => void (record.category[0] !== 'logtape' && records.push(record)) },
      loggers: [{ category: [], sinks: ['memory'], lowestLevel: 'debug' }],
    });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    sysEnvMut.AI_GOOGLE_API_KEY = originalKey;
    await reset();
  });

  it('sends the API key in a request header and keeps it out of the URL and the debug logs', async () => {
    const result = await LLM.embedding({
      id: 'embedding-request',
      model: 'gemini:gemini-embedding-001',
      text: 'plain input',
      task: 'retrieval.query',
    });

    expect(result.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(captured).toHaveLength(1);
    const request = captured[0]!;
    expect(request.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent',
    );
    expect(request.url).not.toContain(KEY_PROBE);
    expect(new URL(request.url).search).toBe('');
    expect(request.headers.get('x-goog-api-key')).toBe(KEY_PROBE);

    const fetchLogs = records.filter((record) => record.message.join('').includes('#fetch'));
    expect(fetchLogs.length).toBeGreaterThan(0);
    expect(JSON.stringify(records.map((record) => [record.message, record.properties]))).not.toContain(KEY_PROBE);
  });
});
