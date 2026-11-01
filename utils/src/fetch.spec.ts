import { urlForLog } from './fetch';

import { describe, expect, it } from 'bun:test';

describe('urlForLog', () => {
  it('keeps origin and path and drops query, fragment and user info', () => {
    expect(urlForLog('https://user:pw@api.example.com:8443/v1/models/m:embed?key=probe-secret&x=1#frag')).toBe(
      'https://api.example.com:8443/v1/models/m:embed',
    );
  });

  it('returns a URL without a query unchanged', () => {
    expect(urlForLog('https://api.example.com/v1/items')).toBe('https://api.example.com/v1/items');
  });

  it('cuts a relative or malformed URL at the first query or fragment delimiter', () => {
    expect(urlForLog('/v1/items?token=probe-secret')).toBe('/v1/items');
    expect(urlForLog('not a url#probe-secret')).toBe('not a url');
    expect(urlForLog('?token=probe-secret')).toBe('');
  });
});
