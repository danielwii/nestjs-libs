import { Catch, HttpException } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

import { getAppLogger } from '@app/utils/app-logger';

import { OOPS_ERROR_METADATA_KEY } from './error-codes';
import { toErrorDescriptor } from './error-descriptor';
import { Oops } from './oops';
import { OopsError } from './oops-error';

import { Metadata as GrpcMetadata, status } from '@grpc/grpc-js';
import * as Sentry from '@sentry/nestjs';
import { Observable, of, throwError } from 'rxjs';
import { ZodError } from 'zod';

import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';

const MIN_GRPC_STATUS_CODE: number = status.OK;
const MAX_GRPC_STATUS_CODE: number = status.UNAUTHENTICATED;

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

interface RpcExceptionPayload {
  code?: unknown;
  status?: unknown;
  details?: unknown;
  message?: unknown;
}

/**
 * gRPC 异常过滤器
 *
 * ## 业务异常契约（熵减）
 * - **唯一**业务异常类型：`OopsError`（`instanceof` 识别）
 * - 手搓 / 自定义「长得像」的异常：不走 Oops 路径，走 unexpected / 协议映射
 *
 * 传输语义：
 * - Oops (422, isFatal=false) → gRPC OK + x-oops-error-bin metadata  
 *   传输层视角：服务正常处理了请求，Istio metrics 不计为错误  
 *   客户端通过 middleware 读取 header 还原业务错误
 * - Oops.Block (4xx) → 具体 gRPC status + details JSON
 * - Oops.Panic (5xx) → gRPC 错误 status + Sentry
 *
 * @example
 * // 在 grpc-bootstrap.ts 中注册
 * app.useGlobalFilters(new GrpcExceptionFilter('marsgate'));
 */

@Catch()
export class GrpcExceptionFilter implements ExceptionFilter {
  private readonly logger = getAppLogger('GrpcExceptionFilter');

  constructor(private readonly provider: string) {}

  catch(exception: unknown, host: ArgumentsHost): Observable<unknown> {
    if (exception instanceof OopsError) {
      return this.handleOopsError(exception, host);
    }

    // Zod 验证错误
    if (exception instanceof ZodError) {
      return this.handleZodError(exception);
    }

    if (exception instanceof RpcException) {
      return this.handleRpcException(exception);
    }

    if (exception instanceof HttpException) {
      return this.handleHttpException(exception, host);
    }

    // 其他未知错误
    return this.handleUnexpectedError(exception, host);
  }

  /**
   * 从 gRPC 入站参数提取调用方用户上下文，用于 Sentry 影响面归因。
   * 来源优先级：入站 metadata（x-user-id / x-device-id，由调用方 userContextMiddleware 注入）
   * → 回退到请求体字段（部分 gRPC 方法的 payload 自带 userId/deviceId）。
   */
  private extractUserContext(host: ArgumentsHost): { userId?: string; deviceId?: string } {
    try {
      const data = host.getArgByIndex(0);
      const metadata = host.getArgByIndex(1);
      const fromMeta = (key: string): string | undefined => {
        const v = metadata?.get?.(key);
        const first = Array.isArray(v) ? v[0] : v;
        return typeof first === 'string' ? first : undefined;
      };
      const userId = fromMeta('x-user-id') ?? (typeof data?.userId === 'string' ? data.userId : undefined);
      const deviceId = fromMeta('x-device-id') ?? (typeof data?.deviceId === 'string' ? data.deviceId : undefined);
      return { userId, deviceId };
    } catch {
      return {};
    }
  }

  /**
   * 上报 fatal 异常到 Sentry，并附带调用方用户上下文（修复 "Users Impacted=0"）。
   * 拿不到任何上下文时退回裸上报，保持原行为。
   */
  private captureFatalToSentry(exception: unknown, host: ArgumentsHost): void {
    const { userId, deviceId } = this.extractUserContext(host);
    if (!userId && !deviceId) {
      Sentry.captureException(exception);
      return;
    }
    Sentry.withScope((scope) => {
      if (userId) scope.setUser({ id: userId });
      if (deviceId) scope.setTag('deviceId', deviceId);
      scope.setTag('provider', this.provider);
      Sentry.captureException(exception);
    });
  }

  /**
   * OopsError 处理（唯一业务异常路径）
   *
   * - Panic (500): gRPC 错误 status + Sentry
   * - Block (4xx): 映射到具体 gRPC status（客户端错误，不用 OK pattern）
   * - Oops (422): gRPC OK + metadata（业务拒绝，Istio 不计为错误）
   */
  private handleOopsError(exception: OopsError, host: ArgumentsHost): Observable<unknown> {
    const grpcError: GrpcError = {
      httpStatus: exception.httpStatus,
      errorCode: exception.errorCode,
      businessCode: exception.oopsCode,
      userMessage: exception.userMessage,
      internalDetails: exception.internalDetails,
      provider: exception.provider ?? this.provider,
    };

    const details = JSON.stringify(grpcError);

    if (exception.isFatal()) {
      // 直接抛出 { code, details } 而非 RpcException
      // 原因：@grpc/grpc-js 的 serverErrorToStatus() 检查 error.code（顶层属性）
      this.logger
        .error`[${exception.getCombinedCode()}] Oops.Panic ${exception.userMessage} | ${exception.internalDetails} ${exception}`;
      this.captureFatalToSentry(exception, host);

      const grpcStatus = this.httpStatusToGrpcStatus(exception.httpStatus);
      return throwError(() => ({ code: grpcStatus, details }));
    }

    if (exception instanceof Oops.Block) {
      this.logger
        .warning`[${exception.getCombinedCode()}] Oops.Block(${exception.httpStatus}) ${exception.userMessage} | ${exception.internalDetails}`;

      const grpcStatus = this.httpStatusToGrpcStatus(exception.httpStatus);
      return throwError(() => ({ code: grpcStatus, details }));
    }

    // Oops (422): OK pattern + metadata
    // 客户端 middleware 读取 x-oops-error-bin → 还原业务错误
    this.logger.warning`[${exception.getCombinedCode()}] Oops ${exception.userMessage} | ${exception.internalDetails}`;

    // host.getArgByIndex(2) = gRPC call 对象，NestJS 适配层传递 [request, metadata, call]
    const call = host.getArgByIndex(2);
    if (call?.sendMetadata) {
      const metadata = new GrpcMetadata();
      metadata.set(OOPS_ERROR_METADATA_KEY, Buffer.from(details, 'utf-8'));
      call.sendMetadata(metadata);
    }

    return of({});
  }

  private handleZodError(exception: ZodError): Observable<never> {
    const firstIssue = exception.issues.at(0);
    const grpcError: GrpcError = {
      httpStatus: 400,
      errorCode: '0x0101', // CLIENT_INPUT_ERROR
      businessCode: 'VALIDATION_ERROR',
      userMessage: firstIssue?.message ?? '请求参数验证失败',
      internalDetails: JSON.stringify(exception.issues),
      provider: this.provider,
    };

    this.logger.warning`[ZodError] ${firstIssue?.path.join('.')}: ${firstIssue?.message}`;

    return throwError(() => ({ code: status.INVALID_ARGUMENT, details: JSON.stringify(grpcError) }));
  }

  private handleHttpException(exception: HttpException, host: ArgumentsHost): Observable<never> {
    const descriptor = toErrorDescriptor(exception);
    if (!descriptor) {
      return this.handleUnexpectedError(exception, host);
    }

    const grpcError: GrpcError = {
      httpStatus: descriptor.httpStatus,
      errorCode: descriptor.code,
      businessCode: descriptor.code,
      userMessage: descriptor.message,
      provider: this.provider,
    };

    if (descriptor.errors !== undefined) {
      grpcError.internalDetails = this.stringifyRpcExceptionDetails(descriptor.errors);
    }

    const grpcStatus = this.httpStatusToGrpcStatus(descriptor.httpStatus);
    const details = JSON.stringify(grpcError);

    if (descriptor.logLevel === 'error') {
      this.logger.error`[HttpException] ${descriptor.httpStatus} ${descriptor.code} ${descriptor.message} ${exception}`;
      this.captureFatalToSentry(exception, host);
    } else {
      this.logger.warning`[HttpException] ${descriptor.httpStatus} ${descriptor.code} ${descriptor.message}`;
    }

    return throwError(() => ({ code: grpcStatus, details }));
  }

  private handleRpcException(exception: RpcException): Observable<never> {
    const serialized = this.serializeRpcException(exception);

    this.logger.warning`[RpcException] ${serialized.details}`;

    return throwError(() => serialized);
  }

  private serializeRpcException(exception: RpcException): { code: number; details: string; message: string } {
    const error = exception.getError();

    if (typeof error === 'object') {
      const payload = error as RpcExceptionPayload;
      const details = this.stringifyRpcExceptionDetails(payload.details ?? payload.message ?? exception.message);

      return {
        code: this.normalizeGrpcStatusCode(payload.code ?? payload.status),
        details,
        message: details,
      };
    }

    const details = this.stringifyRpcExceptionDetails(error);
    return { code: status.UNKNOWN, details, message: details };
  }

  private normalizeGrpcStatusCode(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value)) return status.UNKNOWN;
    if (value < MIN_GRPC_STATUS_CODE || value > MAX_GRPC_STATUS_CODE) return status.UNKNOWN;
    return value;
  }

  private stringifyRpcExceptionDetails(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.message;

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private handleUnexpectedError(exception: unknown, host: ArgumentsHost): Observable<never> {
    this.logger.error`[UnknownError] ${exception}`;
    this.captureFatalToSentry(exception, host);

    const grpcError: GrpcError = {
      httpStatus: 500,
      errorCode: '0x0401', // SYSTEM_INTERNAL_ERROR
      businessCode: 'INTERNAL_ERROR',
      userMessage: '服务内部错误，请稍后重试',
      internalDetails: exception instanceof Error ? exception.message : String(exception),
      provider: this.provider,
    };

    return throwError(() => ({ code: status.INTERNAL, details: JSON.stringify(grpcError) }));
  }

  private httpStatusToGrpcStatus(httpStatus: number): number {
    // HTTP → gRPC status 映射
    //
    // 关键区分：
    // - 400 INVALID_ARGUMENT: 请求参数本身有问题（格式错、缺字段），修改参数才能成功
    // - 422 FAILED_PRECONDITION: 请求合法但当前条件不满足（设备不在线、余额不足），换个时机/条件可能成功
    // - 502/503 UNAVAILABLE: 上游依赖不可用，区别于本服务内部故障
    if (httpStatus === 502) return status.UNAVAILABLE;
    if (httpStatus === 503) return status.UNAVAILABLE;
    if (httpStatus === 504) return status.DEADLINE_EXCEEDED;
    if (httpStatus >= 500) return status.INTERNAL;
    if (httpStatus === 400) return status.INVALID_ARGUMENT;
    if (httpStatus === 401) return status.UNAUTHENTICATED;
    if (httpStatus === 403) return status.PERMISSION_DENIED;
    if (httpStatus === 404) return status.NOT_FOUND;
    if (httpStatus === 408) return status.DEADLINE_EXCEEDED;
    if (httpStatus === 409) return status.ALREADY_EXISTS;
    if (httpStatus === 413) return status.RESOURCE_EXHAUSTED;
    if (httpStatus === 415) return status.INVALID_ARGUMENT;
    if (httpStatus === 422) return status.FAILED_PRECONDITION;
    if (httpStatus === 429) return status.RESOURCE_EXHAUSTED;
    if (httpStatus >= 400 && httpStatus < 500) return status.INVALID_ARGUMENT;
    return status.UNKNOWN;
  }
}
