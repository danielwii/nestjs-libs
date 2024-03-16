import { HttpStatus } from '@nestjs/common/enums';
import type { ErrorHttpStatusCode } from '@nestjs/common/utils/http-error-by-code.util';

import { ErrorCodes } from '@app/nest/error-codes';

export type ApiFailRes = {
  statusCode: ErrorHttpStatusCode;
  message: string;
  code?: string;
  errors?: any;
};

export type ApiRes<Data = any> =
  | {
      statusCode: 200;
      data?: Data;
    }
  | ApiFailRes;

export const ApiRes = {
  success: <Data>(data?: Data): ApiRes<Data> => ({
    data,
    statusCode: 200,
  }),
  /**
   * @deprecated {@see failureV2}
   * @param message
   * @param statusCode
   * @param errors
   */
  failure: (message: string, statusCode?: ErrorHttpStatusCode, errors?: any): ApiRes => ({
    message,
    statusCode: statusCode ?? HttpStatus.UNPROCESSABLE_ENTITY,
    errors: message === errors ? undefined : errors,
  }),
  failureV2: ({
    code,
    message,
    errors,
    statusCode,
  }: {
    code: ErrorCodes;
    message: string;
    statusCode?: ErrorHttpStatusCode;
    errors?: any;
  }): ApiRes => ({
    code,
    message,
    statusCode: statusCode ?? HttpStatus.UNPROCESSABLE_ENTITY,
    errors: message === errors ? undefined : errors,
  }),
};
