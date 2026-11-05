/**
 * What `instrument.ts` lets leave the process through Sentry: structure only.
 *
 * Why: an error report is written by whoever threw, and an exception message, a provider error or a breadcrumb can
 * hold request text (an email, something a user said). One filter at the single `Sentry.init` blocks every call site
 * at once, including the ones written later (owner decision 2026-11-05; the OpenRouter half is in
 * utils/src/openrouter-deny.ts).
 *
 * What an event keeps: the exception class names along the `cause` chain, an error code that passed a shape check
 * (read from `hint.originalException` through `describeErrorParts`, so no reporting site changes), stack frames
 * without their variables or source lines, opaque identifiers (a user id, trace ids, short tags), the fixed runtime
 * contexts, and breadcrumb type, category and level. Everything else is dropped: exception values, messages,
 * request data, `extra`, free-text contexts such as `llm.providerError`, user fields other than `id`, the
 * transaction name, the fingerprint. The event is rebuilt from an allowlist, so a field the SDK adds later is dropped
 * until it is added here.
 *
 * Not covered: transactions and Sentry Logs. They are not enabled (`tracesSampleRate`, `tracesSampler` and
 * `enableLogs` are left out of the options), and `beforeSendTransaction` and `beforeSendLog` drop everything so that
 * turning one on later does not send text (`beforeSendTransaction` only takes effect with `traceLifecycle: 'static'`). The noise filter is matched on the original event, before text is removed.
 */
import { describeErrorParts } from '@app/utils/describe-error';

type Json = Record<string, unknown>;

/** Events that are noise, not failures; matched against the message and exception texts before they are dropped. */
const NOISY_PATTERNS = [
  /MISSING_ENV_FILE/i,
  /injecting env/i,
  /#shutdownTracing/,
  /TimeoutNegativeWarning/,
  /DeprecationWarning/,
  /^[DI] \d{4}-\d{2}-\d{2}T.+\| v\d+\.\d+\.\d+ \d+ \|/, // @grpc/grpc-js debug/info logs written to stderr
];

/** Identifiers and short labels are released by shape alone (the same idea as the error code check in describe-error). */
const OPAQUE_VALUE = /^[A-Za-z0-9_.:-]{1,64}$/;
const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/;

const EVENT_KEYS = [
  'event_id',
  'timestamp',
  'platform',
  'level',
  'release',
  'environment',
  'server_name',
  'sdk',
  'type',
];
/**
 * The contexts that stay, each with the fixed keys the SDK itself fills (@sentry/bun 11.10: the runtime from the Bun integration,
 * the rest from the node context integration). A key outside the list is dropped, so a context another piece of code set under one
 * of these names cannot carry text, and only a primitive value stays under a listed key.
 */
const CONTEXT_KEYS: Record<string, readonly string[]> = {
  runtime: ['name', 'version'],
  os: ['name', 'version', 'kernel_version', 'build'],
  device: [
    'arch',
    'boot_time',
    'memory_size',
    'free_memory',
    'processor_count',
    'cpu_description',
    'processor_frequency',
  ],
  app: ['app_start_time', 'app_memory', 'free_memory'],
  culture: ['locale', 'timezone'],
  cloud_resource: ['cloud.provider', 'cloud.region', 'cloud.platform'],
};
const TRACE_KEYS = ['trace_id', 'span_id', 'parent_span_id', 'op', 'status', 'origin'];
const FRAME_KEYS = ['filename', 'abs_path', 'module', 'function', 'lineno', 'colno', 'in_app', 'platform', 'package'];
const MECHANISM_KEYS = ['type', 'handled', 'source', 'exception_id', 'parent_id', 'is_exception_group'];

/** Shown where a message was: the event had text, and the text was removed. */
export const REMOVED_TEXT = '[text removed]';

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function pick(source: Json, keys: readonly string[]): Json {
  const picked: Json = {};
  for (const key of keys) if (source[key] !== undefined) picked[key] = source[key];
  return picked;
}

function opaque(value: unknown): string | undefined {
  const text = typeof value === 'number' ? String(value) : value;
  return typeof text === 'string' && OPAQUE_VALUE.test(text) ? text : undefined;
}

function textOf(event: Json): string {
  const logentry = isJson(event.logentry) ? event.logentry : {};
  const exception = isJson(event.exception) ? event.exception : {};
  const values = Array.isArray(exception.values) ? exception.values : [];
  const texts = values.filter(isJson).map((v) => [v.type, v.value].filter((x) => typeof x === 'string' && x).join(':'));
  return [event.message, logentry.formatted, logentry.message, ...texts]
    .filter((x): x is string => typeof x === 'string' && x !== '')
    .join('\n');
}

function structureOfFrame(frame: unknown): Json {
  return isJson(frame) ? pick(frame, FRAME_KEYS) : {};
}

function structureOfException(value: unknown): Json {
  if (!isJson(value)) return {};
  const type = typeof value.type === 'string' && CLASS_NAME.test(value.type) ? value.type : 'Error';
  const stacktrace =
    isJson(value.stacktrace) && Array.isArray(value.stacktrace.frames) ? value.stacktrace.frames : undefined;
  return {
    type,
    ...(isJson(value.mechanism) ? { mechanism: pick(value.mechanism, MECHANISM_KEYS) } : {}),
    ...(typeof value.module === 'string' && OPAQUE_VALUE.test(value.module) ? { module: value.module } : {}),
    ...(stacktrace ? { stacktrace: { frames: stacktrace.map(structureOfFrame) } } : {}),
  };
}

function structureOfBreadcrumbs(breadcrumbs: unknown): Json[] | undefined {
  if (!Array.isArray(breadcrumbs)) return undefined;
  return breadcrumbs.flatMap((crumb: unknown) => {
    const kept = structureOfBreadcrumb(isJson(crumb) ? crumb : null);
    return kept ? [kept] : [];
  });
}

/**
 * The structure of one breadcrumb, or `null` for a console one. Text (`message`) and `data` (urls, bodies) never
 * stay; what stays says what kind of thing happened and when.
 */
export function structureOfBreadcrumb<T extends Json>(crumb: T | null): Json | null {
  if (crumb === null || crumb.category === 'console') return null;
  const category = opaque(crumb.category);
  const type = opaque(crumb.type);
  return {
    ...(crumb.timestamp !== undefined ? { timestamp: crumb.timestamp } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(crumb.level !== undefined ? { level: crumb.level } : {}),
  };
}

/**
 * `beforeSend`: the event rebuilt from structure only, or `null` for noise.
 *
 * `hint.originalException` is where the error code and the `cause` class names come from; it is never read for its
 * message. An event with text but no exception (a captured message) keeps a fixed marker where the text was.
 */
export function structureOfEvent(event: Json, hint?: { originalException?: unknown }): Json | null {
  const haystack = textOf(event);
  if (haystack && NOISY_PATTERNS.some((pattern) => pattern.test(haystack))) return null;

  const out = pick(event, EVENT_KEYS);

  const exception = isJson(event.exception) ? event.exception : undefined;
  const values = exception && Array.isArray(exception.values) ? exception.values : undefined;
  if (values) out.exception = { values: values.map(structureOfException) };
  else if (haystack) out.logentry = { message: REMOVED_TEXT };

  const tags: Record<string, string> = {};
  if (isJson(event.tags)) {
    for (const [key, value] of Object.entries(event.tags)) {
      const shaped = opaque(value);
      if (OPAQUE_VALUE.test(key) && shaped !== undefined) tags[key] = shaped;
    }
  }

  const contexts: Json = {};
  if (isJson(event.contexts)) {
    for (const [name, keys] of Object.entries(CONTEXT_KEYS)) {
      const context = event.contexts[name];
      if (!isJson(context)) continue;
      const kept = Object.fromEntries(Object.entries(pick(context, keys)).filter(([, value]) => isPrimitive(value)));
      if (Object.keys(kept).length > 0) contexts[name] = kept;
    }
    if (isJson(event.contexts.trace)) {
      contexts.trace = Object.fromEntries(
        Object.entries(pick(event.contexts.trace, TRACE_KEYS)).filter(([, value]) => isPrimitive(value)),
      );
    }
  }
  if (hint?.originalException instanceof Error) {
    const { name, code, causes } = describeErrorParts(hint.originalException);
    contexts.error = { name, ...(code !== undefined ? { code } : {}), causes };
    if (code !== undefined) tags.error_code = code;
  }
  if (Object.keys(contexts).length > 0) out.contexts = contexts;
  if (Object.keys(tags).length > 0) out.tags = tags;

  const userId = isJson(event.user) ? opaque(event.user.id) : undefined;
  if (userId !== undefined) out.user = { id: userId };

  const breadcrumbs = structureOfBreadcrumbs(event.breadcrumbs);
  if (breadcrumbs && breadcrumbs.length > 0) out.breadcrumbs = breadcrumbs;

  return out;
}

/**
 * The part of the `Sentry.init` options that decides what may leave. `instrument.ts` spreads it into `init`; the spec
 * asserts what it contains and what it leaves out.
 */
export function sentryStructureOptions() {
  return {
    sendDefaultPii: false,
    beforeSend: (event: Json, hint?: { originalException?: unknown }) => structureOfEvent(event, hint),
    beforeBreadcrumb: (crumb: Json) => structureOfBreadcrumb(crumb),
    // With the SDK default (`traceLifecycle: 'stream'`) @sentry/bun 11.10 ignores beforeSendTransaction and sends spans
    // as span items that carry the segment name and the user's email, name and IP (found by sentry-structure.spec.ts). 'static'
    // makes the drop below take effect, so switching tracing on later still sends no text.
    traceLifecycle: 'static' as const,
    beforeSendTransaction: () => null,
    beforeSendLog: () => null,
  };
}
