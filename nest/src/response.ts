export type ApiRes<Data = unknown> =
  | {
      success: true;
      message?: string;
      data?: Data;
      meta?: Record<string, unknown>;
    }
  | {
      success: false;
      message: string;
      code?: string;
      errors?: unknown;
    };

export const ApiRes = {
  success: <Data>(data?: Data, message?: string, meta?: Record<string, unknown>): ApiRes<Data> => ({
    success: true as const,
    message,
    data,
    meta,
  }),

  ok: (message: string, meta?: Record<string, unknown>): ApiRes => ({
    success: true as const,
    message,
    meta,
  }),

  failure: ({ code, message, errors }: { code?: string; message: string; errors?: unknown }): ApiRes<never> => ({
    success: false as const,
    message,
    code,
    errors,
  }),
};
