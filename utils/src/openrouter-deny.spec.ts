import { applyOpenRouterDeny, isOpenRouterUrl, openRouterDeniedInit, withOpenRouterDeny } from './openrouter-deny';

import { describe, expect, it } from 'bun:test';

describe('applyOpenRouterDeny', () => {
  it('sets data_collection to deny and keeps the other provider keys', () => {
    const body = { model: 'a/b', provider: { order: ['x', 'y'], allow_fallbacks: false } };
    expect(applyOpenRouterDeny(body)).toEqual({
      model: 'a/b',
      provider: { order: ['x', 'y'], allow_fallbacks: false, data_collection: 'deny' },
    });
  });

  it('overwrites a data_collection the caller wrote', () => {
    expect(applyOpenRouterDeny({ provider: { data_collection: 'allow', order: ['x'] } }).provider).toEqual({
      data_collection: 'deny',
      order: ['x'],
    });
  });

  it('adds provider when the body has none, or has one that is not an object', () => {
    expect(applyOpenRouterDeny({ model: 'a/b' })).toEqual({ model: 'a/b', provider: { data_collection: 'deny' } });
    expect(applyOpenRouterDeny({ provider: 'allow' as unknown }).provider).toEqual({ data_collection: 'deny' });
    expect(applyOpenRouterDeny({ provider: null as unknown }).provider).toEqual({ data_collection: 'deny' });
  });

  it('does not change the body it was given', () => {
    const body = { provider: { order: ['x'] } };
    applyOpenRouterDeny(body);
    expect(body).toEqual({ provider: { order: ['x'] } });
  });
});

describe('isOpenRouterUrl', () => {
  it('matches the OpenRouter host by its parsed host name', () => {
    expect(isOpenRouterUrl('https://openrouter.ai/api/v1/chat/completions')).toBe(true);
    expect(isOpenRouterUrl(new URL('https://OpenRouter.ai/api/v1/embeddings'))).toBe(true);
    expect(isOpenRouterUrl(new Request('https://openrouter.ai/api/v1/chat/completions'))).toBe(true);
  });

  it('does not match a host that only contains the name', () => {
    expect(isOpenRouterUrl('https://openrouter.ai.example.com/api/v1')).toBe(false);
    expect(isOpenRouterUrl('https://example.com/?u=openrouter.ai')).toBe(false);
    expect(isOpenRouterUrl('https://example.com/openrouter.ai')).toBe(false);
    expect(isOpenRouterUrl('https://user:openrouter.ai@example.com/')).toBe(false);
    expect(isOpenRouterUrl('not a url')).toBe(false);
  });
});

describe('openRouterDeniedInit', () => {
  const url = 'https://openrouter.ai/api/v1/chat/completions';

  it('rewrites a JSON object body and drops the caller content-length in every header shape', () => {
    const body = JSON.stringify({ model: 'a/b', provider: { order: ['x'] } });
    const length = String(body.length);
    for (const headers of [
      { 'Content-Type': 'application/json', 'Content-Length': length },
      new Headers({ 'content-type': 'application/json', 'content-length': length }),
      [
        ['content-type', 'application/json'],
        ['Content-Length', length],
      ] as Array<[string, string]>,
    ]) {
      const init = openRouterDeniedInit(url, { method: 'POST', headers, body });
      expect(JSON.parse(init?.body as string)).toEqual({
        model: 'a/b',
        provider: { order: ['x'], data_collection: 'deny' },
      });
      expect(new Headers(init?.headers).get('content-length')).toBeNull();
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    }
  });

  it('keeps a plain-object headers value a plain object, so a reader that indexes it still works', () => {
    const init = openRouterDeniedInit(url, { headers: { Authorization: 'Bearer k' }, body: '{}' });
    expect(init?.headers).toEqual({ Authorization: 'Bearer k' });
  });

  it('leaves a request that is not for OpenRouter, has no body, or has a body it cannot read as a JSON object', () => {
    const post = { method: 'POST', body: '{"provider":{"data_collection":"allow"}}' };
    expect(openRouterDeniedInit('https://api.example.com/v1/x', post)).toBe(post);
    const noBody = { method: 'GET' };
    expect(openRouterDeniedInit(url, noBody)).toBe(noBody);
    expect(openRouterDeniedInit(url, undefined)).toBeUndefined();
    for (const body of ['not json', '[1,2]', '"text"', 'null']) {
      const init = { method: 'POST', body };
      expect(openRouterDeniedInit(url, init)).toBe(init);
    }
    const stream = { method: 'POST', body: new ReadableStream() };
    expect(openRouterDeniedInit(url, stream)).toBe(stream);
  });
});

describe('withOpenRouterDeny', () => {
  it('hands the wrapped fetch the denied body', async () => {
    const seen: Array<{ input: unknown; init?: RequestInit }> = [];
    const wrapped = withOpenRouterDeny((async (input: unknown, init?: RequestInit) => {
      seen.push({ input, init });
      return new Response('{}');
    }) as typeof fetch);
    await wrapped('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ provider: { data_collection: 'allow' } }),
    });
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0]?.init?.body as string)).toEqual({ provider: { data_collection: 'deny' } });
  });
});
