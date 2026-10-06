import 'reflect-metadata';

import {
  openRouterStrictToolsMiddleware,
  strictSubset,
  STRUCTURED_OUTPUTS_BETA,
} from './openrouter-strict-tools.middleware';

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText, jsonSchema, streamText, tool, wrapLanguageModel } from 'ai';
import { describe, expect, it } from 'bun:test';

import type { LanguageModelV4CallOptions, LanguageModelV4FunctionTool } from '@ai-sdk/provider';

type Params = LanguageModelV4CallOptions;
type Schema = LanguageModelV4FunctionTool['inputSchema'];

const ANTHROPIC = 'anthropic/claude-sonnet-4.5';
const BETA = 'x-anthropic-beta';

const schema = (extra: Record<string, unknown> = {}): Schema =>
  ({ type: 'object', properties: { value: { type: 'string' } }, required: ['value'], ...extra }) as Schema;

const fn = (name: string, over: Partial<LanguageModelV4FunctionTool> = {}): LanguageModelV4FunctionTool => ({
  type: 'function',
  name,
  description: `${name} description`,
  inputSchema: schema(),
  ...over,
});

const params = (over: Partial<Params> = {}): Params => ({ prompt: [], ...over }) as Params;

const run = async (modelId: string, p: Params): Promise<Params> => {
  const middleware = openRouterStrictToolsMiddleware(modelId);
  return (await middleware.transformParams!({ type: 'generate', params: p, model: {} as never })) as Params;
};

describe('openRouterStrictToolsMiddleware: strict tool is forwarded (M8 / T12)', () => {
  it('sends the strict tool with strict:true and the beta header; a plain tool in the same call stays plain', async () => {
    const out = await run(
      ANTHROPIC,
      params({ tools: [fn('A', { strict: true }), fn('B')], toolChoice: { type: 'auto' } }),
    );

    expect(out.headers?.[BETA]).toBe(STRUCTURED_OUTPUTS_BETA);
    expect(out.providerOptions?.openrouter?.tools as unknown).toEqual([
      {
        type: 'function',
        function: { name: 'A', description: 'A description', parameters: schema(), strict: true },
      },
      { type: 'function', function: { name: 'B', description: 'B description', parameters: schema() } },
    ]);
    // Everything else the SDK will build the body from is untouched.
    expect(out.tools).toEqual(params({ tools: [fn('A', { strict: true }), fn('B')] }).tools);
    expect(out.toolChoice).toEqual({ type: 'auto' });
  });

  it('comma-joins an existing x-anthropic-beta value, keeps its casing, and does not repeat the beta', async () => {
    const out = await run(
      ANTHROPIC,
      params({ tools: [fn('A', { strict: true })], headers: { 'X-Anthropic-Beta': 'other-beta' } }),
    );
    expect(out.headers).toEqual({ 'X-Anthropic-Beta': `other-beta,${STRUCTURED_OUTPUTS_BETA}` });

    const again = await run(
      ANTHROPIC,
      params({ tools: [fn('A', { strict: true })], headers: { [BETA]: STRUCTURED_OUTPUTS_BETA, other: 'kept' } }),
    );
    expect(again.headers).toEqual({ [BETA]: STRUCTURED_OUTPUTS_BETA, other: 'kept' });
  });

  it("keeps the other openrouter options, other providers' options and carries eager_input_streaming through", async () => {
    const out = await run(
      ANTHROPIC,
      params({
        tools: [fn('A', { strict: true, providerOptions: { openrouter: { eager_input_streaming: true } } })],
        providerOptions: { openrouter: { reasoning: { effort: 'low' } }, other: { keep: true } },
      }),
    );
    expect(out.providerOptions?.openrouter?.reasoning).toEqual({ effort: 'low' });
    expect(out.providerOptions?.other).toEqual({ keep: true });
    expect((out.providerOptions?.openrouter?.tools as Array<Record<string, unknown>>)[0]?.eager_input_streaming).toBe(
      true,
    );
  });

  it('does not mutate the params it was given', async () => {
    const input = params({
      tools: [fn('A', { strict: true, inputSchema: schema({ properties: { n: { type: 'integer', minimum: 1 } } }) })],
    });
    const snapshot = structuredClone(input);
    await run(ANTHROPIC, input);
    expect(input).toEqual(snapshot);
  });
});

describe('openRouterStrictToolsMiddleware: untouched otherwise (M9 / T13)', () => {
  it('returns the same params for a non-Anthropic model', async () => {
    const p = params({ tools: [fn('A', { strict: true })] });
    expect(await run('google/gemini-2.5-flash', p)).toBe(p);
  });

  it('returns the same params when no function tool is strict (absent or false) or there are no tools', async () => {
    for (const p of [params({ tools: [fn('A'), fn('B', { strict: false })] }), params({ tools: [] }), params()]) {
      expect(await run(ANTHROPIC, p)).toBe(p);
    }
  });

  it('returns the same params when a provider-defined tool is present', async () => {
    const p = params({
      tools: [fn('A', { strict: true }), { type: 'provider', id: 'x.search', name: 'search', args: {} } as never],
    });
    expect(await run(ANTHROPIC, p)).toBe(p);
  });
});

describe('openRouterStrictToolsMiddleware: Bedrock rejects strict', () => {
  const strict = [fn('A', { strict: true })];
  const ignoreOf = (out: Params) =>
    (out.providerOptions?.openrouter?.provider as { ignore?: string[] } | undefined)?.ignore;

  it('adds amazon-bedrock to provider.ignore when there is no routing', async () => {
    expect(ignoreOf(await run(ANTHROPIC, params({ tools: strict })))).toEqual(['amazon-bedrock']);
  });

  it('merges into an existing ignore list without a duplicate, and keeps the other routing fields', async () => {
    const out = await run(
      ANTHROPIC,
      params({
        tools: strict,
        providerOptions: {
          openrouter: { provider: { ignore: ['a', 'amazon-bedrock'], sort: 'latency', allow_fallbacks: false } },
        },
      }),
    );
    expect(out.providerOptions?.openrouter?.provider).toEqual({
      ignore: ['a', 'amazon-bedrock'],
      sort: 'latency',
      allow_fallbacks: false,
    });
  });

  it('still routes when only lists Bedrock and something else', async () => {
    const out = await run(
      ANTHROPIC,
      params({
        tools: strict,
        providerOptions: { openrouter: { provider: { only: ['amazon-bedrock', 'anthropic'] } } },
      }),
    );
    expect(out.providerOptions?.openrouter?.provider).toEqual({
      only: ['amazon-bedrock', 'anthropic'],
      ignore: ['amazon-bedrock'],
    });
  });

  it('returns the params unchanged when routing is pinned to Bedrock alone', async () => {
    const p = params({
      tools: strict,
      providerOptions: { openrouter: { provider: { only: ['amazon-bedrock'], allow_fallbacks: false } } },
    });
    expect(await run(ANTHROPIC, p)).toBe(p);
  });
});

describe('strictSubset: delete-only (M10 / T14)', () => {
  const only = (keyword: string, value: unknown) => ({
    type: 'object',
    properties: { f: { type: 'string', [keyword]: value } },
  });

  for (const [keyword, value] of [
    ['minimum', 1],
    ['maximum', 9],
    ['exclusiveMinimum', 0],
    ['exclusiveMaximum', 10],
    ['multipleOf', 2],
    ['minLength', 1],
    ['maxLength', 9],
    ['maxItems', 3],
    ['uniqueItems', true],
    ['contains', { type: 'string' }],
    ['minContains', 1],
    ['maxContains', 2],
    ['minItems', 2],
    ['format', 'regex'],
  ] as const)
    it(`drops ${keyword} (${JSON.stringify(value)}) and nothing else`, () => {
      const { schema: out, removed } = strictSubset(only(keyword, value) as Schema);
      expect(out).toEqual({ type: 'object', properties: { f: { type: 'string' } } });
      expect(removed).toEqual([`properties.f.${keyword}`]);
    });

  for (const [keyword, value] of [
    ['minItems', 1],
    ['minItems', 0],
    ['format', 'date-time'],
    ['format', 'uuid'],
    ['pattern', '^a+$'],
    ['enum', ['a', 'b']],
    ['default', 'x'],
  ] as const)
    it(`keeps ${keyword} (${JSON.stringify(value)})`, () => {
      const input = only(keyword, value) as Schema;
      expect(strictSubset(input)).toEqual({ schema: input, removed: [] });
    });

  it('reaches nested schemas: items, anyOf, $defs, additionalProperties and arrays of them', () => {
    const { schema: out, removed } = strictSubset({
      type: 'object',
      properties: {
        list: { type: 'array', maxItems: 5, items: { type: 'integer', minimum: 0 } },
        either: {
          anyOf: [
            { type: 'string', maxLength: 3 },
            { type: 'number', multipleOf: 0.5 },
          ],
        },
        bag: { type: 'object', additionalProperties: { type: 'string', minLength: 1 } },
      },
      $defs: { Id: { type: 'string', format: 'regex' } },
    } as Schema);
    expect(out).toEqual({
      type: 'object',
      properties: {
        list: { type: 'array', items: { type: 'integer' } },
        either: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        bag: { type: 'object', additionalProperties: { type: 'string' } },
      },
      $defs: { Id: { type: 'string' } },
    });
    expect(removed.sort()).toEqual(
      [
        '$defs.Id.format',
        'properties.bag.additionalProperties.minLength',
        'properties.either.anyOf[0].maxLength',
        'properties.either.anyOf[1].multipleOf',
        'properties.list.items.minimum',
        'properties.list.maxItems',
      ].sort(),
    );
  });

  it('treats a property that is named like a keyword as data, and leaves enum, const and default values alone', () => {
    const input = {
      type: 'object',
      properties: { minimum: { type: 'integer' }, maxLength: { type: 'string', default: { maxLength: 1 } } },
      required: ['minimum'],
      const: { minimum: 1 },
    } as Schema;
    expect(strictSubset(input)).toEqual({ schema: input, removed: [] });
  });

  it('removes keywords from strict tools only, inside the middleware', async () => {
    const constrained = schema({ properties: { n: { type: 'integer', minimum: 1, maximum: 5 } } });
    const out = await run(
      ANTHROPIC,
      params({ tools: [fn('S', { strict: true, inputSchema: constrained }), fn('P', { inputSchema: constrained })] }),
    );
    const wire = out.providerOptions?.openrouter?.tools as Array<{ function: { parameters: unknown } }>;
    expect(wire[0]?.function.parameters).toEqual(schema({ properties: { n: { type: 'integer' } } }));
    expect(wire[1]?.function.parameters).toEqual(constrained);
  });

  it('does not mutate its input', () => {
    const input = only('minLength', 1) as Schema;
    const snapshot = structuredClone(input);
    strictSubset(input);
    expect(input).toEqual(snapshot);
  });
});

describe('through the provider SDK: the request that leaves (generate and stream)', () => {
  type Captured = { headers: Record<string, string>; body: Record<string, unknown> };

  const completion = JSON.stringify({
    id: 'c1',
    model: ANTHROPIC,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const sse = [
    {
      id: 'c1',
      model: ANTHROPIC,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
    },
    {
      id: 'c1',
      model: ANTHROPIC,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ]
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join('')
    .concat('data: [DONE]\n\n');

  const model = (captured: Captured[], stream: boolean) =>
    wrapLanguageModel({
      model: createOpenRouter({
        apiKey: 'test-key',
        fetch: (async (_url: unknown, init: RequestInit) => {
          captured.push({
            headers: Object.fromEntries(
              new Headers(init.headers as ConstructorParameters<typeof Headers>[0]).entries(),
            ),
            body: JSON.parse(String(init.body)) as Record<string, unknown>,
          });
          return new Response(stream ? sse : completion, {
            headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' },
          });
        }) as unknown as typeof fetch,
      })(ANTHROPIC),
      middleware: openRouterStrictToolsMiddleware(ANTHROPIC),
    });

  const tools = {
    strictOne: tool({
      description: 'strict one',
      inputSchema: jsonSchema(schema({ properties: { n: { type: 'integer', minimum: 1 } } })),
      strict: true,
    }),
    plainOne: tool({ description: 'plain one', inputSchema: jsonSchema(schema()) }),
  };

  const assertWire = ({ headers, body }: Captured) => {
    expect(headers[BETA]).toBe(STRUCTURED_OUTPUTS_BETA);
    const sent = body.tools as Array<{ function: { name: string; strict?: boolean; parameters: unknown } }>;
    expect(sent.map((t) => t.function.name)).toEqual(['strictOne', 'plainOne']);
    expect(sent[0]?.function.strict).toBe(true);
    expect(sent[0]?.function.parameters).toEqual(schema({ properties: { n: { type: 'integer' } } }));
    expect(sent[1]?.function.strict).toBeUndefined();
    expect((body.provider as { ignore: string[] }).ignore).toEqual(['amazon-bedrock']);
  };

  it("keeps the wrapped model's modelId and provider, which telemetry and cost lookups read", () => {
    const bare = createOpenRouter({ apiKey: 'test-key' })(ANTHROPIC);
    const wrapped = model([], false);
    expect(wrapped.modelId).toBe(bare.modelId);
    expect(wrapped.modelId).toBe(ANTHROPIC);
    expect(wrapped.provider).toBe(bare.provider);
    expect(wrapped.specificationVersion).toBe('v4');
  });

  it('generateText', async () => {
    const captured: Captured[] = [];
    await generateText({ model: model(captured, false), prompt: 'hi', tools });
    expect(captured).toHaveLength(1);
    assertWire(captured[0]!);
  });

  it('streamText', async () => {
    const captured: Captured[] = [];
    const result = streamText({ model: model(captured, true), prompt: 'hi', tools });
    await result.consumeStream();
    expect(captured).toHaveLength(1);
    assertWire(captured[0]!);
  });

  it('a call without a strict tool leaves with no beta header and the SDK-built tools', async () => {
    const captured: Captured[] = [];
    await generateText({ model: model(captured, false), prompt: 'hi', tools: { plainOne: tools.plainOne } });
    expect(captured[0]?.headers[BETA]).toBeUndefined();
    expect(captured[0]?.body.provider).toBeUndefined();
    const sent = captured[0]?.body.tools as Array<{ function: Record<string, unknown> }>;
    expect(sent[0]?.function.strict).toBeUndefined();
  });
});
