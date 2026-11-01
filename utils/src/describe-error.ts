import { isOopsError } from '@app/nest/exceptions/oops-error';

/** Longest `cause` chain that is followed; deeper layers are dropped. */
const MAX_CAUSE_DEPTH = 8;

/** Class names are written by code, so they only have to look like identifiers. */
const CLASS_NAME_SHAPE = /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/;

/**
 * Error codes are released by shape alone: `oopsCode` and a plain error's `code` are only checked to be non-empty
 * where they are produced, so they can hold arbitrary text. Anything outside this fixed character set is replaced.
 */
const ERROR_CODE_SHAPE = /^[A-Za-z0-9_.-]{1,32}$/;

const FALLBACK_CLASS_NAME = 'Error';
const FALLBACK_CODE = 'other';

function className(error: Error): string {
  // `constructor` can be shadowed by an own property, so it is not assumed to be a function
  const name = (error.constructor as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' && CLASS_NAME_SHAPE.test(name) ? name : FALLBACK_CLASS_NAME;
}

function shapedCode(code: unknown): string {
  return typeof code === 'string' && ERROR_CODE_SHAPE.test(code) ? code : FALLBACK_CODE;
}

function errorCode(error: Error): string | undefined {
  if (isOopsError(error)) {
    try {
      return shapedCode(error.getCombinedCode());
    } catch {
      return FALLBACK_CODE;
    }
  }
  // A getter that throws must not break the logging path that is describing a failure.
  try {
    const code = (error as { code?: unknown }).code;
    return code === undefined ? undefined : shapedCode(code);
  } catch {
    return FALLBACK_CODE;
  }
}

function causeLayers(error: Error): string[] {
  const layers: string[] = [];
  const seen = new Set<unknown>([error]);
  let current: unknown;
  try {
    current = error.cause;
  } catch {
    return layers;
  }
  while (current !== undefined && layers.length < MAX_CAUSE_DEPTH) {
    if (!(current instanceof Error)) {
      layers.push(typeof current);
      break;
    }
    if (seen.has(current)) break;
    seen.add(current);
    layers.push(className(current));
    try {
      current = current.cause;
    } catch {
      break;
    }
  }
  return layers;
}

/** The content-free facts about a thrown value. `name` is the class name, or the `typeof` of a non-Error. */
export interface ErrorDescription {
  name: string;
  code?: string;
  causes: string[];
}

/**
 * Describe a thrown value without its content: only the class name, an error code that passed the shape check, and
 * the class names along the `cause` chain. `message`, `stack`, `internalDetails`, `userMessage`, `providerData` and
 * request values are never read, because they depend on who threw and can hold text from the request.
 *
 * - an `OopsError` reports `getCombinedCode()`; any other error reports its `code` field when it has one;
 * - a value that is not an `Error` is reported as its `typeof` only.
 */
export function describeErrorParts(error: unknown): ErrorDescription {
  if (!(error instanceof Error)) return { name: typeof error, causes: [] };

  const code = errorCode(error);
  return { name: className(error), ...(code !== undefined ? { code } : {}), causes: causeLayers(error) };
}

/** One-line form of {@link describeErrorParts}, e.g. `Panic code=0x0405SYS01 cause=TypeError>RangeError`. */
export function describeError(error: unknown): string {
  const { name, code, causes } = describeErrorParts(error);
  const parts = [name];
  if (code !== undefined) parts.push(`code=${code}`);
  if (causes.length > 0) parts.push(`cause=${causes.join('>')}`);
  return parts.join(' ');
}
