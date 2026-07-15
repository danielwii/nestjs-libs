export type StreamTerminalState = 'pending' | 'success' | 'failure' | 'abort';

type MaybePromise = void | PromiseLike<void>;

export interface StreamLifecycleCallbacks<ERROR_EVENT, END_EVENT, ABORT_EVENT> {
  onError?: (event: ERROR_EVENT) => MaybePromise;
  onEnd?: (event: END_EVENT) => MaybePromise;
  onAbort?: (event: ABORT_EVENT) => MaybePromise;
}

export interface StreamLifecycleEffects<ERROR_EVENT, END_EVENT, ABORT_EVENT> {
  cleanup: () => void;
  logErrorEvent: (event: ERROR_EVENT) => void;
  logSuccess: (event: END_EVENT) => void;
  logAbort: (event: ABORT_EVENT) => void;
  logFailure: (error: unknown) => void;
}

export interface StreamLifecycle<ERROR_EVENT, END_EVENT, ABORT_EVENT> {
  onError: (event: ERROR_EVENT) => Promise<void>;
  onEnd: (event: END_EVENT) => Promise<void>;
  onAbort: (event: ABORT_EVENT) => Promise<void>;
  fail: (error: unknown) => boolean;
  getState: () => StreamTerminalState;
}

/**
 * Owns one stream's terminal state. Error events remain non-terminal; the first
 * success, abort, or failure claim owns cleanup and terminal summary logging.
 */
export function createStreamLifecycle<ERROR_EVENT, END_EVENT, ABORT_EVENT>(
  callbacks: StreamLifecycleCallbacks<ERROR_EVENT, END_EVENT, ABORT_EVENT>,
  effects: StreamLifecycleEffects<ERROR_EVENT, END_EVENT, ABORT_EVENT>,
): StreamLifecycle<ERROR_EVENT, END_EVENT, ABORT_EVENT> {
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
      try {
        await callbacks.onError?.(event);
      } finally {
        effects.logErrorEvent(event);
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
