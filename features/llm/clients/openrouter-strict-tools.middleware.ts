/**
 * Strict tool use for Anthropic models behind OpenRouter, as a LanguageModel middleware.
 *
 * Purpose: a tool marked `strict: true` gets grammar-constrained arguments on `anthropic/*` models routed through
 *   OpenRouter. The AI SDK's standard `tool({ strict: true })` is the only caller interface; there is no libs option.
 * Why a middleware: `@openrouter/ai-sdk-provider` 3.1.0 builds the request `tools` list from name, description and
 *   schema only, so `strict` never reaches the wire (upstream issue OpenRouterTeam/ai-sdk-provider#543, fix PR #548,
 *   unreleased when this was written). OpenRouter also drops `strict` unless the request carries the header
 *   `x-anthropic-beta: structured-outputs-2025-11-13`. The provider spreads `providerOptions.openrouter` over its body,
 *   so a `tools` list placed there replaces the one it built. This file is the single home of that provider rule; it is
 *   attached once, in the `openrouter(modelId)` factory, so generateText, streamText, step-wise model switches and
 *   fallbacks all pass through it. No fetch interception and no package patch.
 * Scope: only `anthropic/*` model ids (the only route verified with strict tools). Anything else, any call without a
 *   strict function tool, and any call that also carries provider-defined tools is returned unchanged (the last case is
 *   logged: the tools list cannot be rebuilt without the SDK's own provider-tool mapping).
 * Routing: Amazon Bedrock answers HTTP 400 to `strict`. A strict call therefore adds `amazon-bedrock` to
 *   `provider.ignore` (merged into any existing list). If routing is pinned to Bedrock alone (`provider.only` lists
 *   nothing else) the call is returned unchanged and logged, which keeps today's behaviour on that route.
 * Schema: `strictSubset` deletes the JSON Schema keywords Anthropic's strict mode rejects, from strict tools only. It
 *   adds and rewrites nothing (`additionalProperties`, `oneOf` and the like are the caller's schema builder's job);
 *   the caller's own validator still enforces what was removed. Callers relying on a removed constraint must validate
 *   locally (a zod `inputSchema`, or `jsonSchema(schema, { validate })`); this layer cannot detect a missing validator.
 *   `pattern` is kept as is: unsupported regex features in it (a lookahead was verified live) make the provider answer
 *   HTTP 400, a visible error and not a silent one; the caller's schema builder owns pattern compatibility, like
 *   `additionalProperties`. This layer does not judge regex syntax.
 * Exit: when #548 is released the `tools` override goes; this file then shrinks to the header rule, the Bedrock rule and
 *   the keyword stripping, which have no upstream home. SDK bump checklist: re-check the SDK's own tool mapping
 *   (name, description, parameters, eager_input_streaming), which the override duplicates, and the keyword list against
 *   the provider's strict-mode documentation.
 */
import { getAppLogger } from '@app/utils/app-logger';

import type { JSONValue, LanguageModelV4FunctionTool } from '@ai-sdk/provider';
import type { LanguageModelMiddleware } from 'ai';

const log = getAppLogger('features', 'LLM', 'openrouter-strict-tools');

export const STRUCTURED_OUTPUTS_BETA = 'structured-outputs-2025-11-13';
const BETA_HEADER = 'x-anthropic-beta';
const BEDROCK_SLUG = 'amazon-bedrock';

type FunctionTool = LanguageModelV4FunctionTool;
type Schema = FunctionTool['inputSchema'];
type Headers = Record<string, string | undefined>;

// ---------------------------------------------------------------------------------------------------------------------
// strictSubset
// ---------------------------------------------------------------------------------------------------------------------

/** Keywords strict mode rejects wherever they appear. `minItems` (above 1) and `format` (outside the supported list) are
 * handled separately below because only some values are rejected. */
const UNSUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'maxItems',
  'uniqueItems',
  'contains',
  'minContains',
  'maxContains',
]);

const SUPPORTED_FORMATS: ReadonlySet<string> = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

/** Keywords whose value is a map of name -> schema (the names are data, not keywords). */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);

/** Keywords whose value is a schema or a list of schemas. */
const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'items',
  'prefixItems',
  'additionalItems',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'anyOf',
  'allOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'propertyNames',
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function stripNode(node: unknown, path: string, removed: string[]): unknown {
  if (Array.isArray(node)) return node.map((item, index) => stripNode(item, `${path}[${index}]`, removed));
  if (!isPlainObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    const here = path ? `${path}.${key}` : key;
    if (UNSUPPORTED_KEYWORDS.has(key)) {
      removed.push(here);
    } else if (key === 'minItems' && typeof value === 'number' && value > 1) {
      removed.push(here);
    } else if (key === 'format' && typeof value === 'string' && !SUPPORTED_FORMATS.has(value)) {
      removed.push(here);
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && isPlainObject(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, stripNode(child, `${here}.${name}`, removed)]),
      );
    } else if (SCHEMA_KEYWORDS.has(key)) {
      out[key] = stripNode(value, here, removed);
    } else {
      // enum, const, default, examples, type, required, description, $ref ...: data or structure, kept as is.
      out[key] = structuredClone(value);
    }
  }
  return out;
}

/** A deep copy of `schema` without the keywords strict mode rejects, plus the paths that were removed. */
export function strictSubset(schema: Schema): { schema: Schema; removed: string[] } {
  const removed: string[] = [];
  return { schema: stripNode(schema, '', removed) as Schema, removed };
}

// ---------------------------------------------------------------------------------------------------------------------
// request shaping
// ---------------------------------------------------------------------------------------------------------------------

/** Adds `beta` to `x-anthropic-beta`, comma-joined with any value already there; the existing key's casing is kept. */
function appendBeta(headers: Headers | undefined, beta: string): Headers {
  const existingKey = Object.keys(headers ?? {}).find((key) => key.toLowerCase() === BETA_HEADER);
  const existing = existingKey ? (headers?.[existingKey] ?? '') : '';
  const values = existing
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.includes(beta)) values.push(beta);
  return { ...headers, [existingKey ?? BETA_HEADER]: values.join(',') };
}

const isBedrock = (slug: unknown): boolean => typeof slug === 'string' && slug.toLowerCase().startsWith(BEDROCK_SLUG);

const eagerInputStreaming = (tool: FunctionTool): { eager_input_streaming: JSONValue } | Record<string, never> => {
  const value = (tool.providerOptions?.openrouter as Record<string, JSONValue> | undefined)?.eager_input_streaming;
  return value == null ? {} : { eager_input_streaming: value };
};

const loggedStrictSubset = new Set<string>();

function toWireTool(tool: FunctionTool): JSONValue {
  let parameters: Schema = tool.inputSchema;
  if (tool.strict) {
    const { schema, removed } = strictSubset(tool.inputSchema);
    parameters = schema;
    if (removed.length > 0 && !loggedStrictSubset.has(tool.name)) {
      loggedStrictSubset.add(tool.name);
      log.debug`[strictSubset] tool=${tool.name} removed keywords: ${removed.join(', ')}`;
    }
  }
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      parameters: parameters as JSONValue,
      ...(tool.strict ? { strict: true } : {}),
    },
    ...eagerInputStreaming(tool),
  };
}

/** `provider` routing with Bedrock excluded; `undefined` when routing is pinned to Bedrock alone. */
function routingWithoutBedrock(routing: JSONValue | undefined): Record<string, JSONValue> | undefined {
  const current = isPlainObject(routing) ? (routing as Record<string, JSONValue>) : {};
  const only = Array.isArray(current.only) ? current.only : undefined;
  if (only && only.length > 0 && only.every(isBedrock)) return undefined;
  const ignore = Array.isArray(current.ignore) ? current.ignore : [];
  return { ...current, ignore: [...new Set<JSONValue>([...ignore, BEDROCK_SLUG])] };
}

export function openRouterStrictToolsMiddleware(modelId: string): LanguageModelMiddleware {
  return {
    transformParams: async ({ params }) => {
      if (!modelId.startsWith('anthropic/')) return params;
      const tools = params.tools ?? [];
      const functionTools = tools.filter((tool): tool is FunctionTool => tool.type === 'function');
      if (!functionTools.some((tool) => tool.strict === true)) return params;
      if (functionTools.length !== tools.length) {
        log.warning`[strict] ignored: provider-defined tools are present (model=${modelId})`;
        return params;
      }
      const openrouterOptions = params.providerOptions?.openrouter;
      const provider = routingWithoutBedrock(openrouterOptions?.provider);
      if (!provider) {
        log.warning`[strict] ignored: routing is pinned to ${BEDROCK_SLUG}, which rejects strict (model=${modelId})`;
        return params;
      }
      return {
        ...params,
        headers: appendBeta(params.headers, STRUCTURED_OUTPUTS_BETA),
        providerOptions: {
          ...params.providerOptions,
          openrouter: {
            ...openrouterOptions,
            provider,
            // The provider spreads providerOptions.openrouter over its built body, so this list replaces `tools`.
            tools: functionTools.map(toWireTool),
          },
        },
      };
    },
  };
}
