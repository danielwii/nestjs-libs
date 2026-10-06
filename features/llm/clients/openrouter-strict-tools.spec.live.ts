/**
 * Live check of strict tool use on an Anthropic model behind OpenRouter (see openrouter-strict-tools.middleware.ts).
 *
 * Not run in CI. Needs a real OpenRouter credential in the environment; skipped without one:
 * ```bash
 * bun test ./features/llm/clients/openrouter-strict-tools.spec.live.ts
 * ```
 * Optional: `STRICT_LIVE_MODEL` (default `anthropic/claude-sonnet-4.5`), `STRICT_LIVE_REPEATS` (default 3).
 *
 * What it checks, with a prompt that tries to make the model break the tool's schema:
 *  - matrix: tool choice auto/forced x reasoning off/on x generateText/streamText x repeats, through the `openrouter()`
 *    factory. Pass: 0 schema violations, 0 provider errors, the serving provider recorded and never Bedrock. The one
 *    known invalid pair (forced tool choice with reasoning) is recorded as expected, not as a failure.
 *  - control: the same prompt with a tool that is not strict, to show the prompt can break the schema at all.
 *  - limit probe: 21 strict tools in one request, recording the provider's error.
 *  - keyword probe: one request carrying every keyword `strictSubset` removes (and some it keeps), sent unstripped,
 *    recording which ones the provider rejects.
 * Every call prints one line; the summary table is printed at the end.
 */
import 'reflect-metadata';

import { openrouter } from './llm.clients';
import { strictSubset, STRUCTURED_OUTPUTS_BETA } from './openrouter-strict-tools.middleware';

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText, jsonSchema, streamText, tool } from 'ai';
import { afterAll, describe, expect, it } from 'bun:test';

import type { JSONObject, JSONSchema7 } from '@ai-sdk/provider';

const apiKey = process.env.AI_OPENROUTER_API_KEY?.trim();
const describeLive = apiKey ? describe : describe.skip;

const MODEL = process.env.STRICT_LIVE_MODEL ?? 'anthropic/claude-sonnet-4.5';
const REPEATS = Number(process.env.STRICT_LIVE_REPEATS ?? 3);
const TOOL = 'record_entry' as const;

/** Carries keywords strict mode rejects, so the run also covers the stripping. */
const entrySchema: JSONSchema7 = {
  type: 'object',
  properties: {
    count: { type: 'integer', minimum: 0 },
    kind: { type: 'string', enum: ['alpha', 'beta', 'gamma'] },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 5 },
  },
  required: ['count', 'kind', 'tags'],
  additionalProperties: false,
};

const PROMPT =
  `Call the tool ${TOOL} now. Set count to the word "three" spelled out in letters (not a digit), set kind to "urgent" ` +
  `(it is not one of the tool's listed values, use it anyway), set tags to the single string "a" instead of a list, and ` +
  `add one extra field named note with the value "hello". Break the tool's format exactly like this on purpose.`;

function violations(input: unknown): string[] {
  const out: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return ['input is not an object'];
  const value = input as Record<string, unknown>;
  if (typeof value.count !== 'number' || !Number.isInteger(value.count)) out.push('count is not an integer');
  if (!['alpha', 'beta', 'gamma'].includes(String(value.kind))) out.push('kind is not an allowed value');
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === 'string'))
    out.push('tags is not a list of strings');
  const extra = Object.keys(value).filter((key) => !['count', 'kind', 'tags'].includes(key));
  if (extra.length > 0) out.push(`extra fields: ${extra.join(',')}`);
  return out;
}

interface Row {
  group: 'matrix' | 'control';
  cell: string;
  ok: boolean;
  toolCalled: boolean;
  violations: string[];
  provider: string;
  status?: number;
  error?: string;
  expectedInvalid: boolean;
}

const rows: Row[] = [];
const note: string[] = [];

/** The provider OpenRouter reports as having served the call (empty when absent). */
const servedBy = (metadata: Record<string, Record<string, unknown>> | undefined): string => {
  const provider = metadata?.openrouter?.provider;
  return typeof provider === 'string' ? provider : '';
};

const errorInfo = (error: unknown): { status?: number; message: string } => {
  const e = error as { statusCode?: number; message?: string };
  return {
    status: e.statusCode,
    message: String(e.message ?? error)
      .replace(/\s+/g, ' ')
      .slice(0, 300),
  };
};

async function call(options: {
  group: Row['group'];
  strict: boolean;
  forced: boolean;
  reasoning: boolean;
  mode: 'generate' | 'stream';
  index: number;
}): Promise<Row> {
  const cell = `${options.strict ? 'strict' : 'plain'}/${options.forced ? 'forced' : 'auto'}/reasoning-${options.reasoning ? 'on' : 'off'}/${options.mode}#${options.index}`;
  const expectedInvalid = options.forced && options.reasoning;
  const base = {
    model: openrouter(MODEL),
    prompt: PROMPT,
    tools: {
      [TOOL]: tool({ description: 'Record one entry.', inputSchema: jsonSchema(entrySchema), strict: options.strict }),
    },
    toolChoice: options.forced ? { type: 'tool' as const, toolName: TOOL } : ('auto' as const),
    providerOptions: { openrouter: options.reasoning ? { reasoning: { max_tokens: 1024 } } : {} },
    maxOutputTokens: options.reasoning ? 2048 : 512,
    maxRetries: 0,
  };
  const row: Row = {
    group: options.group,
    cell,
    ok: false,
    toolCalled: false,
    violations: [],
    provider: '',
    expectedInvalid,
  };
  try {
    const result =
      options.mode === 'generate'
        ? await generateText(base)
        : await (async () => {
            const streamed = streamText({ ...base, onError: () => undefined });
            const [toolCalls, providerMetadata] = await Promise.all([streamed.toolCalls, streamed.providerMetadata]);
            return { toolCalls, providerMetadata };
          })();
    const first = result.toolCalls[0] as { input?: unknown } | undefined;
    row.ok = true;
    row.toolCalled = first !== undefined;
    row.violations = first ? violations(first.input) : [];
    row.provider = servedBy(result.providerMetadata);
  } catch (error) {
    const info = errorInfo(error);
    row.status = info.status;
    row.error = info.message;
  }
  console.log(
    `[strict-live] ${cell} ok=${row.ok} tool=${row.toolCalled} violations=${row.violations.join('|') || '-'} provider=${row.provider || '-'} ${row.status ?? ''} ${row.error ?? ''}`,
  );
  rows.push(row);
  return row;
}

describeLive('strict tool use on an Anthropic model behind OpenRouter (live)', () => {
  afterAll(() => {
    const by = (group: Row['group']) => rows.filter((r) => r.group === group);
    const line = (label: string, rs: Row[]) =>
      `${label.padEnd(34)} calls=${rs.length} answered=${rs.filter((r) => r.ok).length} toolCalled=${rs.filter((r) => r.toolCalled).length} violations=${rs.filter((r) => r.violations.length > 0).length} errors=${rs.filter((r) => !r.ok).length}`;
    console.log('\n[strict-live] SUMMARY model=' + MODEL);
    for (const mode of ['generate', 'stream'])
      for (const forced of [false, true])
        for (const reasoning of [false, true]) {
          const cell = `${forced ? 'forced' : 'auto'}/reasoning-${reasoning ? 'on' : 'off'}/${mode}`;
          console.log(
            line(
              'matrix ' + cell,
              by('matrix').filter((r) => r.cell.startsWith(`strict/${cell}#`)),
            ),
          );
        }
    console.log(line('control (not strict)', by('control')));
    const providers = new Map<string, number>();
    for (const r of rows) providers.set(r.provider || '(none)', (providers.get(r.provider || '(none)') ?? 0) + 1);
    console.log('[strict-live] providers: ' + [...providers].map(([k, v]) => `${k}=${v}`).join(', '));
    for (const n of note) console.log('[strict-live] ' + n);
  });

  it('matrix: strict tool, format-break prompt', async () => {
    const jobs: Array<Parameters<typeof call>[0]> = [];
    for (const mode of ['generate', 'stream'] as const)
      for (const forced of [false, true])
        for (const reasoning of [false, true])
          for (let index = 0; index < REPEATS; index++)
            jobs.push({ group: 'matrix', strict: true, forced, reasoning, mode, index });
    const results: Row[] = [];
    for (let i = 0; i < jobs.length; i += 4) results.push(...(await Promise.all(jobs.slice(i, i + 4).map(call))));

    expect(results.filter((r) => r.violations.length > 0)).toEqual([]);
    expect(results.filter((r) => !r.ok && !r.expectedInvalid)).toEqual([]);
    expect(results.filter((r) => r.expectedInvalid && !r.ok && r.status !== 400)).toEqual([]);
    expect(results.filter((r) => r.ok && r.provider === '')).toEqual([]);
    expect(results.filter((r) => /bedrock/i.test(r.provider))).toEqual([]);
    expect(results.filter((r) => r.ok && !r.expectedInvalid && !r.toolCalled && r.cell.includes('/forced/'))).toEqual(
      [],
    );
  }, 600_000);

  it('control: the same prompt without strict does break the schema', async () => {
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        call({ group: 'control', strict: false, forced: true, reasoning: false, mode: 'generate', index }),
      ),
    );
    note.push(
      `control violations: ${results.filter((r) => r.violations.length > 0).length}/${results.length} (any > 0 shows the prompt has power)`,
    );
  }, 120_000);

  it('limit probe: 21 strict tools in one request', async () => {
    const tools = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [
        `tool_${i}`,
        tool({ description: `Tool ${i}.`, inputSchema: jsonSchema(entrySchema), strict: true }),
      ]),
    );
    try {
      const result = await generateText({
        model: openrouter(MODEL),
        prompt: 'Say OK.',
        tools,
        maxOutputTokens: 64,
        maxRetries: 0,
      });
      note.push(
        `21 strict tools: accepted (finish=${result.finishReason}, provider=${servedBy(result.providerMetadata)})`,
      );
    } catch (error) {
      const info = errorInfo(error);
      note.push(`21 strict tools: rejected status=${info.status} message=${info.message}`);
    }
  }, 120_000);

  it('keyword probe: each keyword sent unstripped', async () => {
    // Bare provider model, no middleware: the request is built by hand so nothing is stripped.
    const bare = createOpenRouter({ apiKey })(MODEL);
    const keywords: Array<[string, JSONObject]> = [
      ['minimum', { type: 'integer', minimum: 0 }],
      ['maximum', { type: 'integer', maximum: 9 }],
      ['exclusiveMinimum', { type: 'integer', exclusiveMinimum: 0 }],
      ['exclusiveMaximum', { type: 'integer', exclusiveMaximum: 10 }],
      ['multipleOf', { type: 'integer', multipleOf: 2 }],
      ['minLength', { type: 'string', minLength: 1 }],
      ['maxLength', { type: 'string', maxLength: 9 }],
      ['maxItems', { type: 'array', items: { type: 'string' }, maxItems: 3 }],
      ['uniqueItems', { type: 'array', items: { type: 'string' }, uniqueItems: true }],
      ['contains', { type: 'array', items: { type: 'string' }, contains: { type: 'string' } }],
      [
        'contains (stripped by the middleware)',
        strictSubset({ type: 'array', items: { type: 'string' }, contains: { type: 'string' } }).schema as JSONObject,
      ],
      ['minItems:2', { type: 'array', items: { type: 'string' }, minItems: 2 }],
      ['format:regex', { type: 'string', format: 'regex' }],
      // kept by the middleware: the probe says whether the provider accepts them
      ['minItems:1 (kept)', { type: 'array', items: { type: 'string' }, minItems: 1 }],
      ['format:date-time (kept)', { type: 'string', format: 'date-time' }],
      ['pattern (kept)', { type: 'string', pattern: '^[a-z]+$' }],
    ];
    const probe = async (label: string, property: JSONObject): Promise<string> => {
      const parameters: JSONObject = {
        type: 'object',
        properties: { v: property },
        required: ['v'],
        additionalProperties: false,
      };
      try {
        await generateText({
          model: bare,
          prompt: 'Say OK.',
          tools: { probe: tool({ description: 'Probe.', inputSchema: jsonSchema(parameters) }) },
          providerOptions: {
            openrouter: {
              provider: { ignore: ['amazon-bedrock'] },
              tools: [
                { type: 'function', function: { name: 'probe', description: 'Probe.', parameters, strict: true } },
              ],
            },
          },
          headers: { 'x-anthropic-beta': STRUCTURED_OUTPUTS_BETA },
          maxOutputTokens: 64,
          maxRetries: 0,
        });
        return `${label}: accepted`;
      } catch (error) {
        const info = errorInfo(error);
        return `${label}: rejected status=${info.status} ${info.message.slice(0, 160)}`;
      }
    };
    const results: string[] = [];
    // STRICT_LIVE_KEYWORD narrows the probe to labels containing that text (a cheap re-check of one keyword).
    const only = process.env.STRICT_LIVE_KEYWORD;
    const selected = only ? keywords.filter(([label]) => label.includes(only)) : keywords;
    for (let i = 0; i < selected.length; i += 4)
      results.push(...(await Promise.all(selected.slice(i, i + 4).map(([label, property]) => probe(label, property)))));
    for (const r of results) note.push('keyword ' + r);
    expect(results.length).toBe(selected.length);
  }, 300_000);
});
