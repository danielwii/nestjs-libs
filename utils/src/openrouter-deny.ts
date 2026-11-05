/**
 * Every request this library sends to OpenRouter carries `provider.data_collection: 'deny'`, and the caller cannot
 * switch it off.
 *
 * Why: the prompts and attachments that go through this library must not reach an upstream provider that is allowed
 * to train on them. A policy that lives only in an account setting leaves no evidence in code (owner decision
 * 2026-11-05). The rule is the same for every application that uses this library and has no
 * switch: an application that needs another data policy does not use this layer and writes its own client.
 *
 * Where it is written: once, at the lowest layer. The AI SDK provider merges everything the caller passed (routing,
 * `providerOptions`, `extraBody`) into the JSON body before it calls `fetch`, so a wrapper on the `fetch` it is given
 * sees the final body, whichever layer the caller wrote `provider` from. `ApiFetcher.fetch` and `createOpenRouterClient`
 * both apply it; `applyOpenRouterDeny` is exported for the one caller that builds its own streamed body.
 *
 * Not covered, on purpose:
 *  - A body that is not a JSON string (a stream, `FormData`, bytes) or not a JSON object is sent unchanged. The caller
 *    that streams (a PDF upload built chunk by chunk) calls `applyOpenRouterDeny` on its body object before it
 *    splits the body into a stream.
 *  - A `Request` object passed as the first argument is sent unchanged, because its body cannot be read here without
 *    consuming it. The AI SDK provider passes a URL string and an init object.
 *  - Only the host is checked, not the path: a JSON object posted to any `openrouter.ai` endpoint gets `provider`.
 *    The batch endpoint receives it on the envelope, not on each request inside it; nothing in this repository
 *    submits a batch from application code.
 *  - Zero-data-retention (`zdr`) is a stricter policy that is not applied here.
 */

const OPENROUTER_HOST = 'openrouter.ai';

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns a copy of `body` whose `provider.data_collection` is `'deny'`. Other keys of `provider` (for example
 * `order`) are kept; a `data_collection` the caller wrote, `allow` included, is overwritten.
 */
export function applyOpenRouterDeny<T extends JsonObject>(body: T): Omit<T, 'provider'> & { provider: JsonObject } {
  const provider = isJsonObject(body.provider) ? body.provider : {};
  return { ...body, provider: { ...provider, data_collection: 'deny' } };
}

function urlOf(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/** The host is parsed, so `https://openrouter.ai.example.com/` and `https://example.com/?u=openrouter.ai` do not match. */
export function isOpenRouterUrl(input: string | URL | Request): boolean {
  try {
    return new URL(urlOf(input)).hostname.toLowerCase() === OPENROUTER_HOST;
  } catch {
    return false;
  }
}

function parseJsonObject(text: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The body is rewritten, so the length the caller computed for the original body is no longer true. */
function withoutContentLength(headers: RequestInit['headers']): RequestInit['headers'] {
  if (headers === undefined) return undefined;
  const isContentLength = (name: string) => name.toLowerCase() === 'content-length';
  if (headers instanceof Headers) {
    const copy = new Headers(headers);
    copy.delete('content-length');
    return copy;
  }
  if (Array.isArray(headers)) return headers.filter((pair) => !isContentLength(String(pair[0])));
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !isContentLength(name)));
}

/**
 * The init to send for `input`: unchanged unless the request goes to OpenRouter with a JSON-object string body, in
 * which case the body gets `provider.data_collection: 'deny'` and the caller's `content-length` is dropped.
 */
export function openRouterDeniedInit(
  input: string | URL | Request,
  init: RequestInit | undefined,
): RequestInit | undefined {
  if (typeof init?.body !== 'string' || !isOpenRouterUrl(input)) return init;
  const body = parseJsonObject(init.body);
  if (body === undefined) return init;
  const headers = withoutContentLength(init.headers);
  return {
    ...init,
    body: JSON.stringify(applyOpenRouterDeny(body)),
    ...(headers !== undefined ? { headers } : {}),
  };
}

/** Wraps a `fetch` so that every request it sends to OpenRouter is denied (see the file comment). */
export function withOpenRouterDeny(fetchFn: typeof fetch): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    fetchFn(input, openRouterDeniedInit(input, init))) as typeof fetch;
}
