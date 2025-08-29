export type ApiFailRes = {
  message: string;
  code?: string;
  errors?: any;
};

export type ApiRes<Data = unknown> =
  | {
      success: true;
      message?: string;
      data?: Data;
    }
  | ApiFailRes;

export const ApiRes = {
  success: <Data>(data?: Data, message?: string): ApiRes<Data> => ({
    success: true as const,
    message,
    data,
  }),

  ok: (message: string): ApiRes => ({
    success: true as const,
    message,
  }),

  failure: ({ code, message, errors }: { code: string; message: string; errors?: any }) => ({
    success: false,
    code,
    message,
    errors: message === errors ? undefined : errors,
  }),
};
