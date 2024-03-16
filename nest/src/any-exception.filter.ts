import { Prisma } from '@prisma/client';

import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common/enums';
import { ThrottlerException } from '@nestjs/throttler';

import { ApiRes } from '@app/nest/response';
import { f } from '@app/utils';

import _ from 'lodash';
import { ZodError } from 'zod';

import { ErrorCodes } from './error-codes';

export class AnyExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(this.constructor.name);

  catch(exception: any, host: ArgumentsHost): any {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest();
    const response = ctx.getResponse();

    // throw directly if it is a graphql request
    if (!response.status) throw exception;

    if (exception instanceof ZodError) {
      const errors = exception.errors;
      this.logger.warn(f`(${request?.uid})[${request?.ip}] ZodError ${errors}`, exception.stack);
      return response.status(HttpStatus.BAD_REQUEST).json(
        ApiRes.failureV2({
          code: ErrorCodes.ZodError,
          message: 'invalid parameters',
          statusCode: HttpStatus.BAD_REQUEST,
          errors,
        }),
      );
    }
    if (exception instanceof BadRequestException) {
      this.logger.warn(
        f`(${request?.uid})[${request?.ip}] BadRequestException ${exception.message} ${exception.getResponse()}`,
        exception.stack,
      );
      return response.status(HttpStatus.BAD_REQUEST).json(
        ApiRes.failureV2({
          code: ErrorCodes.BadRequest,
          message: exception.message,
          statusCode: HttpStatus.BAD_REQUEST,
          errors: _.get(exception.getResponse(), 'message'),
        }),
      );
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      this.logger.warn(f`(${request?.uid})[${request?.ip}] PrismaClientKnownRequestError ${exception.message}`);
      return response.status(HttpStatus.UNPROCESSABLE_ENTITY).json(
        ApiRes.failureV2({
          code: ErrorCodes.PrismaClientKnownRequestError,
          message: 'cannot process your request',
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        }),
      );
    }
    if (exception instanceof ThrottlerException) {
      this.logger.warn(f`(${request?.uid})[${request?.ip}] ThrottlerException ${exception.message}`);
      return response.status(HttpStatus.TOO_MANY_REQUESTS).json(
        ApiRes.failureV2({
          code: ErrorCodes.TooManyRequests,
          message: exception.message,
          statusCode: HttpStatus.TOO_MANY_REQUESTS as any,
          errors: _.get(exception.getResponse(), 'message'),
        }),
      );
    }
    if (exception instanceof NotFoundException) {
      this.logger.warn(f`(${request?.uid})[${request?.ip}] NotFoundException ${exception.message}`);
      return response.status(HttpStatus.NOT_FOUND).json(
        ApiRes.failureV2({
          code: ErrorCodes.NotFound,
          message: exception.message,
          statusCode: HttpStatus.NOT_FOUND,
          errors: _.get(exception.getResponse(), 'message'),
        }),
      );
    }
    if (exception.name === 'FetchError') {
      this.logger.warn(f`(${request?.uid})[${request?.ip}] FetchError ${exception}`);
      return response.status(HttpStatus.UNPROCESSABLE_ENTITY).json(
        ApiRes.failureV2({
          code: ErrorCodes.FetchError,
          message: `FetchError ${exception.type}`,
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        }),
      );
    }
    if (exception instanceof UnauthorizedException) {
      this.logger.warn(f`(${request?.uid})[${request?.ip}] UnauthorizedException ${exception.message}`);
      return response.status(HttpStatus.UNAUTHORIZED).json(
        ApiRes.failureV2({
          code: ErrorCodes.Unauthorized,
          message: exception.message,
          statusCode: HttpStatus.UNAUTHORIZED,
          errors: _.get(exception.getResponse(), 'message'),
        }),
      );
    }
    if (exception instanceof ConflictException) {
      this.logger.warn(f`(${request?.uid})[${request?.ip}] ConflictException ${exception.message}`);
      return response.status(HttpStatus.CONFLICT).json(
        ApiRes.failureV2({
          code: ErrorCodes.Conflict,
          message: exception.message,
          statusCode: HttpStatus.CONFLICT,
          errors: _.get(exception.getResponse(), 'message'),
        }),
      );
    }
    if (exception instanceof UnprocessableEntityException) {
      const cause = (exception.cause as ErrorCodes) ?? ErrorCodes.Undefined;
      this.logger[[ErrorCodes.Outdated].includes(exception.cause as ErrorCodes) ? 'warn' : 'error'](
        f`(${request?.uid})[${request?.ip}] UnprocessableEntityException(${cause}) ${exception.message}`,
        exception.stack,
      );
      return response.status(HttpStatus.UNPROCESSABLE_ENTITY).json(
        ApiRes.failureV2({
          code: cause,
          message: exception.message,
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          errors: _.get(exception.getResponse(), 'message'),
        }),
      );
    }

    this.logger.error(f`(${request?.uid})[${request?.ip}] ${exception.name} ${exception}`, exception.stack);

    // unexpected error, each error should be handled
    const status = exception.status || 500;
    const message = exception.message || 'Internal Server Error';

    response.status(status).json({
      statusCode: status,
      message,
    });
  }
}
