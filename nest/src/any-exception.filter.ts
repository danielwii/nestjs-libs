import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SentryExceptionCaptured } from '@sentry/nestjs';
import { ThrottlerException } from '@nestjs/throttler';
import { HttpStatus } from '@nestjs/common/enums';
import { ZodError } from 'zod';
import _ from 'lodash';

import { Prisma } from '@/generated/prisma/client';
import { ErrorCodes } from '@app/nest/error-codes';
import { errorStack, f } from '@app/utils';
import { ApiRes } from '@app/nest';

import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { FetchError } from 'node-fetch';

/**
 * ⚠️  ErrorCodes 迁移说明（针对其他项目）
 * 
 * 本文件已更新使用新的维度分类 ErrorCodes。如果你的项目还在使用旧的错误码，
 * 请参考以下迁移对照表：
 * 
 * === 迁移对照表 ===
 * 旧错误码 → 新错误码 (责任方)
 * 
 * BadRequest → CLIENT_INPUT_ERROR (前端开发者)
 * ZodError → CLIENT_VALIDATION_FAILED (前端开发者) 
 * NotFound → CLIENT_AUTH_REQUIRED (前端开发者)
 * Unauthorized → CLIENT_AUTH_REQUIRED (前端开发者)
 * TooManyRequests → CLIENT_RATE_LIMITED (前端开发者)
 * 
 * BusinessError → BUSINESS_RULE_VIOLATION (产品/业务人员)
 * Conflict → BUSINESS_DATA_CONFLICT (产品/业务人员)
 * 
 * FetchError → EXTERNAL_SERVICE_ERROR (运维/DevOps)
 * 
 * PrismaClientKnownRequestError → SYSTEM_DATABASE_ERROR (后端开发者)
 * Unexpected → SYSTEM_INTERNAL_ERROR (后端开发者)
 * 
 * Outdated → DATA_VERSION_MISMATCH (数据管理员)
 * Undefined → 使用具体的错误码替代
 * 
 * === 迁移步骤 ===
 * 1. 更新你项目中的 ErrorCodes 引用
 * 2. 根据错误场景选择合适的新错误码
 * 3. 考虑错误的责任方，选择对应维度的错误码
 * 4. 测试确保错误处理正常工作
 */

// @Catch() // or app.useGlobalFilters(new AnyExceptionFilter())
export class AnyExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(this.constructor.name);

  @SentryExceptionCaptured()
  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request: Request & { uid?: string } = ctx.getRequest();
    const response: Response = ctx.getResponse();

    // throw directly if it is a graphql request
    if (!response.status) {
      this.logger.error(f`(${request?.uid})[${request?.ip}] ${exception.name} ${exception}`, exception.stack);
      throw exception;
    }

    if (exception instanceof ZodError) {
      const errors = exception.issues;
      this.logger.warn(f`(${request?.uid})[${request?.ip}] ZodError ${errors} ${errorStack(exception)}`);
      return response.status(HttpStatus.BAD_REQUEST).json(
        ApiRes.failure({
          code: ErrorCodes.CLIENT_VALIDATION_FAILED,
          message: 'invalid parameters',
          // statusCode: HttpStatus.BAD_REQUEST,
          errors,
        }),
      );
    }
    if (exception instanceof BadRequestException) {
      this.logger.warn(
        f`(${request?.uid})[${request?.ip}] BadRequestException ${exception.message} ${exception.getResponse()} ${errorStack(exception)}`,
      );
      return response.status(HttpStatus.BAD_REQUEST).json(
        ApiRes.failure({
          code: ErrorCodes.CLIENT_INPUT_ERROR,
          message: exception.message,
          // statusCode: HttpStatus.BAD_REQUEST,
          errors: _.get(exception.getResponse(), 'message'),
        }),
      );
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      this.logger.warn(f`(${request?.uid})[${request?.ip}] PrismaClientKnownRequestError ${exception.message}`);
      return response.status(HttpStatus.UNPROCESSABLE_ENTITY).json(
        ApiRes.failure({
          code: ErrorCodes.SYSTEM_DATABASE_ERROR,
          message: 'cannot process your request',
          // statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        }),
      );
    }
    if (exception instanceof ThrottlerException) {
      this.logger.warn(f`(${request?.uid})[${request?.ip}] ThrottlerException ${exception.message}`);
      return response.status(HttpStatus.TOO_MANY_REQUESTS).json(
        ApiRes.failure({
          code: ErrorCodes.CLIENT_RATE_LIMITED,
          message: exception.message,
          // statusCode: HttpStatus.TOO_MANY_REQUESTS as any,
          errors: _.get(exception.getResponse(), 'message'),
        }),
      );
    }
    if (exception instanceof NotFoundException) {
      this.logger.warn(f`(${request?.uid})[${request?.ip}] NotFoundException ${exception.message}`);
      return response.status(HttpStatus.NOT_FOUND).json(
        ApiRes.failure({
          code: ErrorCodes.CLIENT_AUTH_REQUIRED,
          message: exception.message,
          // statusCode: HttpStatus.NOT_FOUND,
          errors: _.get(exception.getResponse(), 'message'),
        }),
      );
    }
    if (exception.name === 'FetchError') {
      this.logger.warn(f`(${request?.uid})[${request?.ip}] FetchError ${exception}`);
      return response.status(HttpStatus.UNPROCESSABLE_ENTITY).json(
        ApiRes.failure({
          code: ErrorCodes.EXTERNAL_SERVICE_ERROR,
          message: `FetchError ${(exception as FetchError).type}`,
          // statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        }),
      );
    }
    if (exception instanceof UnauthorizedException) {
      const path = _.get(request, 'path');
      this.logger.warn(
        f`(${request?.uid})[${request?.ip}] UnauthorizedException ${exception.message} ${path} ${exception.stack}`,
      );
      return response.status(HttpStatus.UNAUTHORIZED).json(
        ApiRes.failure({
          code: ErrorCodes.CLIENT_AUTH_REQUIRED,
          message: exception.message,
          // statusCode: HttpStatus.UNAUTHORIZED,
          errors: _.get(exception.getResponse(), 'message'),
        }),
      );
    }
    if (exception instanceof ConflictException) {
      this.logger.warn(f`(${request?.uid})[${request?.ip}] ConflictException ${exception.message}`);
      return response.status(HttpStatus.CONFLICT).json(
        ApiRes.failure({
          code: ErrorCodes.BUSINESS_DATA_CONFLICT,
          message: exception.message,
          // statusCode: HttpStatus.CONFLICT,
          errors: _.get(exception.getResponse(), 'message'),
        }),
      );
    }
    if (exception instanceof UnprocessableEntityException) {
      const cause = (exception.cause as ErrorCodes) ?? ErrorCodes.SYSTEM_INTERNAL_ERROR;
      const isWarn = [ErrorCodes.DATA_VERSION_MISMATCH, ErrorCodes.BUSINESS_RULE_VIOLATION].includes(cause);
      if (isWarn)
        this.logger.warn(
          f`(${request?.uid})[${request?.ip}] UnprocessableEntityException(${cause}) ${exception.message}`,
        );
      else
        this.logger.error(
          f`(${request?.uid})[${request?.ip}] UnprocessableEntityException(${cause}) ${exception.message}`,
          exception.stack,
        );

      return response.status(HttpStatus.UNPROCESSABLE_ENTITY).json(
        ApiRes.failure({
          code: cause,
          message: exception.message,
          // statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
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
