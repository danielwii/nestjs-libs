import { Oops } from '@app/nest/exceptions/oops';

import type { OopsError } from '@app/nest/exceptions/oops-error';

export function classifyOpenAIDecisionsError(error: unknown, model: string): OopsError {
  if (error instanceof Oops || error instanceof Oops.Block || error instanceof Oops.Panic) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';

  if (name === 'AbortError' || name === 'TimeoutError' || /timeout|aborted/i.test(message)) {
    return Oops.Panic.AIModelError(model, `Timeout: ${message}`, { cause: error });
  }

  if (/429|rate limit/i.test(message)) {
    return Oops.Block.AIModelRateLimited(model, { cause: error });
  }

  if (/401|403|unauthorized|forbidden|api key/i.test(message)) {
    return Oops.Panic.Config(`OpenAI authentication failed: ${message}`, { cause: error });
  }

  if (/400|invalid_request_error|bad request/i.test(message)) {
    return Oops.Validation(`OpenAI decisions request invalid: ${message}`);
  }

  if (/500|502|503|504|internal server error/i.test(message)) {
    return Oops.Panic.AIModelError(model, `OpenAI upstream error: ${message}`, { cause: error });
  }

  if (error instanceof Error) {
    return Oops.Panic.ExternalService('openai-decisions', error.message, { cause: error });
  }

  return Oops.Panic.ExternalService('openai-decisions', `Non-Error thrown: ${String(error)}`, { cause: error });
}
