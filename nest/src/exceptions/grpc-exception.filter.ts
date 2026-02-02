import { Catch, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

import { status } from '@grpc/grpc-js';
import * as Sentry from '@sentry/nestjs';
import { Observable, throwError } from 'rxjs';
import { ZodError } from 'zod';

import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';

/**
 * OopsException 接口
 * 兼容 contract 层的 BusinessException 和 FatalException
 */
interface IOopsException extends Error {
  httpStatus: number;
  errorCode: string;
  businessCode: string;
  userMessage: string;
  internalDetails?: string;
  provider?: string;
  isFatal(): boolean;
  getCombinedCode(): string;
}

/**
 * GrpcError 结构
 * 与 contract/exceptions/grpc-error.ts 中的 GrpcErrorSchema 保持一致
 */
interface GrpcError {
  httpStatus: number;
  errorCode: string;
  businessCode: string;
  userMessage: string;
  internalDetails?: string;
  provider: string;
}

/**
 * gRPC 异常过滤器
 *
 * 将 OopsException (BusinessException/FatalException) 转换为 gRPC 错误：
 * - 序列化错误信息到 details 字段
 * - FatalException (500) 触发 Sentry 告警
 * - BusinessException (422) 仅记录 warn 日志
 *
 * @example
 * // 在 grpc-bootstrap.ts 中注册
 * app.useGlobalFilters(new GrpcExceptionFilter('marsgate'));
 */
@Catch()
export class GrpcExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GrpcExceptionFilter.name);

  constructor(private readonly provider: string) {}

  catch(exception: unknown, _host: ArgumentsHost): Observable<never> {
    // OopsException 转换为结构化 gRPC 错误
    if (this.isOopsException(exception)) {
      return this.handleOopsException(exception);
    }

    // Zod 验证错误
    if (exception instanceof ZodError) {
      return this.handleZodError(exception);
    }

    // RpcException 直接抛出
    if (exception instanceof RpcException) {
      return throwError(() => exception);
    }

    // 其他未知错误
    return this.handleUnexpectedError(exception);
  }

  private isOopsException(error: unknown): error is IOopsException {
    return (
      typeof error === 'object' &&
      error !== null &&
      'httpStatus' in error &&
      'errorCode' in error &&
      'businessCode' in error &&
      'userMessage' in error &&
      'isFatal' in error &&
      typeof (error as IOopsException).isFatal === 'function'
    );
  }

  private handleOopsException(exception: IOopsException): Observable<never> {
    const isFatal = exception.isFatal();
    const grpcStatus = this.httpStatusToGrpcStatus(exception.httpStatus);

    const grpcError: GrpcError = {
      httpStatus: exception.httpStatus,
      errorCode: exception.errorCode,
      businessCode: exception.businessCode,
      userMessage: exception.userMessage,
      internalDetails: exception.internalDetails,
      provider: exception.provider ?? this.provider,
    };

    const details = JSON.stringify(grpcError);

    if (isFatal) {
      this.logger.error(
        `[${exception.getCombinedCode()}] ${exception.userMessage} | ${exception.internalDetails}`,
        exception.stack,
      );
      Sentry.captureException(exception);
    } else {
      this.logger.warn(`[${exception.getCombinedCode()}] ${exception.userMessage} | ${exception.internalDetails}`);
    }

    return throwError(() => new RpcException({ code: grpcStatus, message: details }));
  }

  private handleZodError(exception: ZodError): Observable<never> {
    const firstIssue = exception.issues[0];
    const grpcError: GrpcError = {
      httpStatus: 400,
      errorCode: '0x0101', // CLIENT_INPUT_ERROR
      businessCode: 'VALIDATION_ERROR',
      userMessage: firstIssue?.message ?? '请求参数验证失败',
      internalDetails: JSON.stringify(exception.issues),
      provider: this.provider,
    };

    this.logger.warn(`[ZodError] ${firstIssue?.path.join('.')}: ${firstIssue?.message}`);

    return throwError(() => new RpcException({ code: status.INVALID_ARGUMENT, message: JSON.stringify(grpcError) }));
  }

  private handleUnexpectedError(exception: unknown): Observable<never> {
    const errorMessage = exception instanceof Error ? exception.message : String(exception);
    const errorStack = exception instanceof Error ? exception.stack : undefined;

    this.logger.error(`[UnknownError] ${errorMessage}`, errorStack);
    Sentry.captureException(exception);

    const grpcError: GrpcError = {
      httpStatus: 500,
      errorCode: '0x0401', // SYSTEM_INTERNAL_ERROR
      businessCode: 'INTERNAL_ERROR',
      userMessage: '服务内部错误，请稍后重试',
      internalDetails: errorMessage,
      provider: this.provider,
    };

    return throwError(() => new RpcException({ code: status.INTERNAL, message: JSON.stringify(grpcError) }));
  }

  private httpStatusToGrpcStatus(httpStatus: number): number {
    // HTTP → gRPC status 映射
    if (httpStatus >= 500) return status.INTERNAL;
    if (httpStatus === 400) return status.INVALID_ARGUMENT;
    if (httpStatus === 401) return status.UNAUTHENTICATED;
    if (httpStatus === 403) return status.PERMISSION_DENIED;
    if (httpStatus === 404) return status.NOT_FOUND;
    if (httpStatus === 409) return status.ALREADY_EXISTS;
    if (httpStatus === 422) return status.FAILED_PRECONDITION;
    if (httpStatus === 429) return status.RESOURCE_EXHAUSTED;
    return status.UNKNOWN;
  }
}
