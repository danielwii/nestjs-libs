import { Oops } from '@app/nest/exceptions/oops';

import type { OopsError } from '@app/nest/exceptions/oops-error';

function sdkErrorName(error: unknown): string {
  if (!(error instanceof Error)) return '';
  return error.name || error.constructor.name;
}

export function classifyTypeSafeError(error: unknown, model: string): OopsError {
  if (error instanceof Oops || error instanceof Oops.Block || error instanceof Oops.Panic) {
    return error;
  }

  const name = sdkErrorName(error);
  const message = error instanceof Error ? error.message : String(error);

  // instanceof across ESM import vs createRequire can fail; classify by error name.
  if (name === 'RateLimitError') {
    return Oops.Block.AIModelRateLimited(model, { cause: error });
  }
  if (name === 'AuthenticationError') {
    return Oops.Panic.Config(`TypeSafe authentication failed: ${message}`, { cause: error });
  }
  if (name === 'APITimeoutError' || name === 'APIUserAbortError' || name === 'AbortError' || name === 'TimeoutError') {
    return Oops.Panic.AIModelError(model, `Timeout: ${message}`, { cause: error });
  }
  if (
    name === 'TypeSafeError' ||
    name === 'APIError' ||
    name === 'BadRequestError' ||
    name === 'PermissionDeniedError' ||
    name === 'NotFoundError' ||
    name === 'UnprocessableEntityError' ||
    name === 'InternalServerError' ||
    name === 'APIConnectionError'
  ) {
    return Oops.Panic.AIModelError(model, message, { cause: error });
  }
  if (error instanceof Error) {
    return Oops.Panic.ExternalService('typesafe', error.message, { cause: error });
  }
  return Oops.Panic.ExternalService('typesafe', `Non-Error thrown: ${String(error)}`, { cause: error });
}
