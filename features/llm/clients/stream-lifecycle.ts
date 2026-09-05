export type StreamTerminalState = 'pending' | 'success' | 'failure' | 'abort';

type MaybePromise<T = void> = T | PromiseLike<T>;

export interface StreamLifecycleCallbacks<ERROR_EVENT, END_EVENT, ABORT_EVENT, ERROR_RESULT = void> {
  onError?: (event: ERROR_EVENT) => MaybePromise<ERROR_RESULT>;
  onEnd?: (event: END_EVENT) => MaybePromise;
  onAbort?: (event: ABORT_EVENT) => MaybePromise;
}

export interface StreamLifecycleEffects<ERROR_EVENT, END_EVENT, ABORT_EVENT, ERROR_RESULT = void> {
  cleanup: () => void;
  /** `result` 是 caller onError 的返回值；caller 抛错时为 `undefined`。 */
  logErrorEvent: (event: ERROR_EVENT, result: ERROR_RESULT | undefined) => void;
  logSuccess: (event: END_EVENT) => void;
  logAbort: (event: ABORT_EVENT) => void;
  logFailure: (error: unknown) => void;
}

export interface StreamLifecycle<ERROR_EVENT, END_EVENT, ABORT_EVENT, ERROR_RESULT = void> {
  onError: (event: ERROR_EVENT) => Promise<ERROR_RESULT | undefined>;
  onEnd: (event: END_EVENT) => Promise<void>;
  onAbort: (event: ABORT_EVENT) => Promise<void>;
  fail: (error: unknown) => boolean;
  getState: () => StreamTerminalState;
}

/**
 * Owns one stream's terminal state. Error events remain non-terminal; the first
 * success, abort, or failure claim owns cleanup and terminal summary logging.
 *
 * `onError` forwards the caller callback's resolved value back to the SDK so
 * directives carried by the return value (e.g. `{ retry: true }`) survive the wrapper,
 * and hands the same value to `logErrorEvent` so the forwarded directive is observable.
 */
export function createStreamLifecycle<ERROR_EVENT, END_EVENT, ABORT_EVENT, ERROR_RESULT = void>(
  callbacks: StreamLifecycleCallbacks<ERROR_EVENT, END_EVENT, ABORT_EVENT, ERROR_RESULT>,
  effects: StreamLifecycleEffects<ERROR_EVENT, END_EVENT, ABORT_EVENT, ERROR_RESULT>,
): StreamLifecycle<ERROR_EVENT, END_EVENT, ABORT_EVENT, ERROR_RESULT> {
  let state: StreamTerminalState = 'pending';

  const claim = (next: Exclude<StreamTerminalState, 'pending'>): boolean => {
    if (state !== 'pending') return false;
    state = next;
    return true;
  };

  const finalize = (log: () => void): void => {
    try {
      effects.cleanup();
    } finally {
      log();
    }
  };

  return {
    onError: async (event) => {
      let result: ERROR_RESULT | undefined;
      try {
        result = await callbacks.onError?.(event);
        return result;
      } finally {
        effects.logErrorEvent(event, result);
      }
    },
    onEnd: async (event) => {
      if (!claim('success')) return;
      try {
        await callbacks.onEnd?.(event);
      } finally {
        finalize(() => {
          effects.logSuccess(event);
        });
      }
    },
    onAbort: async (event) => {
      if (!claim('abort')) return;
      try {
        await callbacks.onAbort?.(event);
      } finally {
        finalize(() => {
          effects.logAbort(event);
        });
      }
    },
    fail: (error) => {
      if (!claim('failure')) return false;
      finalize(() => {
        effects.logFailure(error);
      });
      return true;
    },
    getState: () => state,
  };
}
