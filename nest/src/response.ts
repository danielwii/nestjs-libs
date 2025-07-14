import { ErrorCodes } from './error-codes';

export type ApiFailRes = {
  // statusCode: ErrorHttpStatusCode;
  message: string;
  code?: string;
  errors?: any;
};

export type ApiRes<Data = any> =
  | {
      // statusCode: 200;
      data?: Data;
    }
  | ApiFailRes;

export const ApiRes = {
  success: <Data>(data?: Data): ApiRes<Data> => ({
    data,
    // statusCode: 200,
  }),
  failure: ({
    code,
    message,
    errors,
    // statusCode,
  }: {
    code: ErrorCodes;
    message: string;
    // statusCode?: ErrorHttpStatusCode;
    errors?: any;
  }): ApiRes => ({
    code,
    message,
    // statusCode: statusCode ?? HttpStatus.UNPROCESSABLE_ENTITY,
    errors: message === errors ? undefined : errors,
  }),
};
