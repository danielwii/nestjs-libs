type JsonObject = Record<string, unknown>;

export interface VertexFunctionIdStripResult {
  body: unknown;
  stripped: number;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripPartFunctionIds(part: unknown): { part: unknown; stripped: number } {
  if (!isJsonObject(part)) {
    return { part, stripped: 0 };
  }

  let nextPart: JsonObject | undefined;
  let stripped = 0;

  for (const key of ['functionCall', 'functionResponse'] as const) {
    const value = part[key];
    if (!isJsonObject(value) || !Object.hasOwn(value, 'id')) {
      continue;
    }

    nextPart ??= { ...part };
    const nextValue = { ...value };
    delete nextValue.id;
    nextPart[key] = nextValue;
    stripped++;
  }

  return { part: nextPart ?? part, stripped };
}

function stripContentFunctionIds(content: unknown): { content: unknown; stripped: number } {
  if (!isJsonObject(content) || !Array.isArray(content.parts)) {
    return { content, stripped: 0 };
  }

  let stripped = 0;
  let changed = false;
  const parts = content.parts.map((part) => {
    const result = stripPartFunctionIds(part);
    stripped += result.stripped;
    changed ||= result.part !== part;
    return result.part;
  });

  if (!changed) {
    return { content, stripped: 0 };
  }

  return { content: { ...content, parts }, stripped };
}

export function stripUnsupportedVertexFunctionIds(body: unknown): VertexFunctionIdStripResult {
  if (!isJsonObject(body) || !Array.isArray(body.contents)) {
    return { body, stripped: 0 };
  }

  let stripped = 0;
  let changed = false;
  const contents = body.contents.map((content) => {
    const result = stripContentFunctionIds(content);
    stripped += result.stripped;
    changed ||= result.content !== content;
    return result.content;
  });

  if (!changed) {
    return { body, stripped: 0 };
  }

  return { body: { ...body, contents }, stripped };
}

function getUrlPathname(url: string | URL | Request): string | undefined {
  try {
    const urlString = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    return new URL(urlString).pathname;
  } catch {
    return undefined;
  }
}

export function isVertexGenerateContentRequest(url: string | URL | Request): boolean {
  const pathname = getUrlPathname(url);
  return pathname?.endsWith(':generateContent') === true || pathname?.endsWith(':streamGenerateContent') === true;
}

export function normalizeVertexRequestInit(url: string | URL | Request, init?: RequestInit): RequestInit | undefined {
  if (!init || typeof init.body !== 'string' || !isVertexGenerateContentRequest(url)) {
    return init;
  }

  try {
    const parsed = JSON.parse(init.body);
    const result = stripUnsupportedVertexFunctionIds(parsed);
    if (result.stripped === 0) {
      return init;
    }

    return { ...init, body: JSON.stringify(result.body) };
  } catch {
    return init;
  }
}

export function createVertexFetch(baseFetch: typeof fetch): typeof fetch {
  // TODO(vercel/ai#15665): remove after @ai-sdk/google-vertex omits these
  // unsupported Vertex native REST fields itself. Upstream issue:
  // https://github.com/vercel/ai/issues/15664
  return (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    return baseFetch(url, normalizeVertexRequestInit(url, init));
  }) as typeof fetch;
}
