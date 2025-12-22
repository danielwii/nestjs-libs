import {
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { HttpStatus } from '@nestjs/common/enums';
import { GqlExecutionContext } from '@nestjs/graphql';
import { ThrottlerException } from '@nestjs/throttler';

import { SysEnv } from '@app/env';
import { ApiRes } from '@app/nest/common/response';
import { ErrorCodes } from '@app/nest/exceptions/error-codes';
import { errorStack } from '@app/utils/error';
import { f } from '@app/utils/logging';

import { SentryExceptionCaptured } from '@sentry/nestjs';
import { GraphQLError } from 'graphql';
import _ from 'lodash';
import { ZodError } from 'zod';

import type { IdentityRequest } from '../types/identity.interface';
import type { IBusinessException } from './business-exception.interface';
import type { II18nService } from '@app/nest/common/i18n.interface';
import type { ErrorCodeValue } from '@app/nest/exceptions/error-codes';
import type { ArgumentsHost, ExceptionFilter, ExecutionContext, INestApplication } from '@nestjs/common';
import type { Response } from 'express';
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
  private i18nService: II18nService | null = null;
  private i18nServiceRetrieved = false;

  constructor(
    private readonly app?: INestApplication, // 应用实例，用于延迟获取服务
  ) {}

  async catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response: Response = ctx.getResponse();
    const isGraphqlRequest = typeof response?.status !== 'function';

    let request: IdentityRequest | undefined = ctx.getRequest();

    if (!request?.headers && host.getType<'http' | 'graphql'>() === 'graphql') {
      const executionContext = host as unknown as ExecutionContext;
      const gqlCtx = GqlExecutionContext.create(executionContext).getContext<Record<string, unknown>>();
      request = (gqlCtx?.req || gqlCtx?.request || gqlCtx?.expressReq || {}) as IdentityRequest;
    }

    if (host.getType<'http' | 'graphql' | 'ws'>() === 'ws') {
      const ws = host.switchToWs();
      const client = ws.getClient<{ connectionParams?: Record<string, unknown> }>();
      const params = client?.connectionParams ?? {};

      this.logger.error(
        {
          transport: 'ws',
          connectionParams: maskConnectionParams(params),
        },
        exception,
      );
    }

    if (isGraphqlRequest) {
      if (this.isBusinessException(exception)) {
        return this.handleGraphqlBusinessException(exception, request);
      }

      // 认证失败是正常业务行为，不作为系统错误记录
      if (exception instanceof UnauthorizedException) {
        // WARN 日志已在 UserAuthGuard 中记录，此处静默传递
        throw exception;
      }

      this.logger.error(
        f`<GraphqlRequest> (${request?.user?.uid})[${request?.ip}] ${(exception as { name?: string })?.name} ${exception}`,
        errorStack(exception),
      );
      throw exception;
    }

    // 处理 BusinessException（优先级最高）- 不触发 Sentry
    if (this.isBusinessException(exception)) {
      return this.handleBusinessException(exception, request, response);
    }

    if (exception instanceof ZodError) {
      const errors = exception.issues;
      this.logger.warn(f`(${request?.user?.uid})[${request?.ip}] ZodError ${errors} ${errorStack(exception)}`);
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
        f`(${request?.user?.uid})[${request?.ip}] BadRequestException ${(exception as { message?: string })?.message} ${(exception as { getResponse?: () => unknown })?.getResponse?.()} ${errorStack(exception)}`,
      );
      return response.status(HttpStatus.BAD_REQUEST).json(
        ApiRes.failure({
          code: ErrorCodes.CLIENT_INPUT_ERROR,
          message: (exception as { message?: string })?.message ?? '',
          // statusCode: HttpStatus.BAD_REQUEST,
          errors: _.get((exception as { getResponse?: () => unknown })?.getResponse?.(), 'message'),
        }),
      );
    }
    // FIXME 不依赖 Prisma 的类库判断
    // if (exception instanceof Prisma.PrismaClientKnownRequestError) {
    //   this.logger.warn(f`(${request?.user?.uid})[${request?.ip}] PrismaClientKnownRequestError ${ (exception as { message?: string })?.message}`);
    //   return response.status(HttpStatus.UNPROCESSABLE_ENTITY).json(
    //     ApiRes.failure({
    //       code: ErrorCodes.SYSTEM_DATABASE_ERROR,
    //       message: 'cannot process your request',
    //       // statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    //     }),
    //   );
    // }
    if (exception instanceof ThrottlerException) {
      this.logger.warn(
        f`(${request?.user?.uid})[${request?.ip}] ThrottlerException ${(exception as { message?: string })?.message}`,
      );
      return response.status(HttpStatus.TOO_MANY_REQUESTS).json(
        ApiRes.failure({
          code: ErrorCodes.CLIENT_RATE_LIMITED,
          message: (exception as { message?: string })?.message ?? '',
          // statusCode: HttpStatus.TOO_MANY_REQUESTS,
          errors: _.get((exception as { getResponse?: () => unknown })?.getResponse?.(), 'message'),
        }),
      );
    }
    if (exception instanceof NotFoundException) {
      this.logger.warn(
        f`(${request?.user?.uid})[${request?.ip}] NotFoundException ${(exception as { message?: string })?.message}`,
      );
      return response.status(HttpStatus.NOT_FOUND).json(
        ApiRes.failure({
          code: ErrorCodes.CLIENT_AUTH_REQUIRED,
          message: (exception as { message?: string })?.message ?? '',
          // statusCode: HttpStatus.NOT_FOUND,
          errors: _.get((exception as { getResponse?: () => unknown })?.getResponse?.(), 'message'),
        }),
      );
    }
    if ((exception as { name?: string })?.name === 'FetchError') {
      this.logger.warn(f`(${request?.user?.uid})[${request?.ip}] FetchError ${exception}`);
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
        f`(${request?.user?.uid})[${request?.ip}] UnauthorizedException ${(exception as { message?: string })?.message} ${path} ${(exception as { stack?: string })?.stack}`,
      );
      return response.status(HttpStatus.UNAUTHORIZED).json(
        ApiRes.failure({
          code: ErrorCodes.CLIENT_AUTH_REQUIRED,
          message: (exception as { message?: string })?.message ?? '',
          // statusCode: HttpStatus.UNAUTHORIZED,
          errors: _.get((exception as { getResponse?: () => unknown })?.getResponse?.(), 'message'),
        }),
      );
    }
    if (exception instanceof ConflictException) {
      this.logger.warn(
        f`(${request?.user?.uid})[${request?.ip}] ConflictException ${(exception as { message?: string })?.message}`,
      );
      return response.status(HttpStatus.CONFLICT).json(
        ApiRes.failure({
          code: ErrorCodes.BUSINESS_DATA_CONFLICT,
          message: (exception as { message?: string })?.message ?? '',
          // statusCode: HttpStatus.CONFLICT,
          errors: _.get((exception as { getResponse?: () => unknown })?.getResponse?.(), 'message'),
        }),
      );
    }
    if (exception instanceof UnprocessableEntityException) {
      const rawCause = exception.cause;
      const cause = isValidErrorCode(rawCause) ? rawCause : ErrorCodes.SYSTEM_INTERNAL_ERROR;
      const warnCodes: ErrorCodeValue[] = [ErrorCodes.DATA_VERSION_MISMATCH, ErrorCodes.BUSINESS_RULE_VIOLATION];
      const isWarn = warnCodes.includes(cause);
      if (isWarn)
        this.logger.warn(
          f`(${request?.user?.uid})[${request?.ip}] UnprocessableEntityException(${cause}) ${(exception as { message?: string })?.message}`,
        );
      else
        this.logger.error(
          f`(${request?.user?.uid})[${request?.ip}] UnprocessableEntityException(${cause}) ${(exception as { message?: string })?.message}`,
          (exception as { stack?: string })?.stack,
        );

      return response.status(HttpStatus.UNPROCESSABLE_ENTITY).json(
        ApiRes.failure({
          code: cause,
          message: (exception as { message?: string })?.message ?? '',
          // statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          errors: _.get((exception as { getResponse?: () => unknown })?.getResponse?.(), 'message'),
        }),
      );
    }

    if (exception instanceof HttpException) {
      const fallbackStatus = Reflect.get(exception, 'status');
      const status: number =
        typeof exception.getStatus === 'function'
          ? exception.getStatus()
          : typeof fallbackStatus === 'number'
            ? fallbackStatus
            : HttpStatus.INTERNAL_SERVER_ERROR;
      const responseBody =
        typeof exception.getResponse === 'function'
          ? (exception as { getResponse?: () => unknown })?.getResponse?.()
          : (exception as { message?: string })?.message;
      const message =
        typeof responseBody === 'string'
          ? responseBody
          : _.get(responseBody, 'message', (exception as { message?: string })?.message);

      if (status < (HttpStatus.INTERNAL_SERVER_ERROR as number)) {
        this.logger.warn(
          f`(${request?.user?.uid})[${request?.ip}] HttpException(${status}) ${(exception as { name?: string })?.name} ${message}`,
          errorStack(exception),
        );

        return response.status(status).json(
          ApiRes.failure({
            code: ErrorCodes.CLIENT_INPUT_ERROR,
            message: message ?? '',
            errors: typeof responseBody === 'object' ? _.get(responseBody, 'message') : undefined,
          }),
        );
      }
    }

    // 只有未被识别的异常才交给 Sentry
    this.captureExceptionBySentry(exception, host);

    this.logger.error(
      f`(${request?.user?.uid})[${request?.ip}] ${(exception as { name?: string })?.name} ${exception}`,
      (exception as { stack?: string })?.stack,
    );

    // unexpected error, each error should be handled
    const status = (exception as { status?: number })?.status || 500;
    const message = (exception as { message?: string })?.message || 'Internal Server Error';

    response.status(status).json({
      statusCode: status,
      message,
    });
  }

  /**
   * 判断是否为 BusinessException
   */
  private isBusinessException(exception: unknown): exception is IBusinessException {
    return (
      typeof exception === 'object' &&
      exception !== null &&
      'httpStatus' in exception &&
      'userMessage' in exception &&
      'getCombinedCode' in exception &&
      typeof (exception as { getCombinedCode: unknown }).getCombinedCode === 'function'
    );
  }

  /**
   * 选择性捕获异常到 Sentry
   * 业务异常（422）不应该被 Sentry 捕获，因为这些是预期的业务逻辑
   */
  @SentryExceptionCaptured()
  private captureExceptionBySentry(_exception: unknown, _host: ArgumentsHost): void {
    // 该方法仅用于触发 @SentryExceptionCaptured 装饰器
    // 实际的异常处理逻辑在 catch 方法中继续执行
  }

  /**
   * 处理 BusinessException，支持国际化翻译
   */
  private async handleBusinessException(
    exception: IBusinessException,
    request: IdentityRequest | undefined,
    response: Response,
  ) {
    this.logger.warn(
      f`(${request?.user?.uid})[${request?.ip}] BusinessException ${exception.getCombinedCode()} ${exception.userMessage} | ${exception.getInternalDetails()}`,
    );

    // 获取翻译后的错误消息
    const translatedMessage = await this.getTranslatedMessage(exception, request);

    return response.status(exception.httpStatus).json(
      ApiRes.failure({
        code: exception.getCombinedCode(),
        message: translatedMessage,
      }),
    );
  }

  private async handleGraphqlBusinessException(
    exception: IBusinessException,
    request?: IdentityRequest,
  ): Promise<never> {
    this.logger.warn(
      f`(${request?.user?.uid})[${request?.ip}] GraphQL BusinessException ${exception.getCombinedCode()} ${exception.userMessage} | ${exception.getInternalDetails()}`,
    );

    const translatedMessage = await this.getTranslatedMessage(exception, request);

    const extensions: Record<string, unknown> = {
      code: exception.getCombinedCode(),
      httpStatus: exception.httpStatus,
      userMessage: translatedMessage,
    };

    if ('errorCode' in exception) {
      extensions.errorCode = Reflect.get(exception, 'errorCode');
    }
    if ('businessCode' in exception) {
      extensions.businessCode = Reflect.get(exception, 'businessCode');
    }

    throw new GraphQLError(translatedMessage, { extensions: extensions });
  }

  /**
   * 延迟获取 I18nService
   *
   * 【设计意图】
   * - NestJS 的 ExceptionsZone 会拦截异常传播，导致 try-catch 失效
   * - app.get() 在服务不存在时会抛出 UnknownElementException，且无法被 try-catch 捕获
   * - 在 GraphQL 上下文中，该异常会绕过异常处理器直接导致应用崩溃
   * - 通过环境变量开关控制，默认禁用以避免崩溃风险
   * - 异常翻译是辅助功能，失败时降级到原始消息
   */
  private getI18nService(): II18nService | null {
    if (this.i18nServiceRetrieved) {
      return this.i18nService;
    }

    this.i18nServiceRetrieved = true;

    // 检查环境变量开关
    if (!SysEnv.I18N_EXCEPTION_ENABLED) {
      return null;
    }

    if (!this.app) {
      return null;
    }

    try {
      // 使用字符串 token 获取服务，因为我们不想直接导入具体类
      const I18nServiceToken = 'I18nService';
      this.i18nService = this.app.get(I18nServiceToken, { strict: false });
      this.logger.debug(f`#getI18nService I18nService已启用`);
      return this.i18nService;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.warn(f`#getI18nService 获取失败: ${errorMsg}`);
      return null;
    }
  }

  /**
   * 获取翻译后的错误消息
   *
   * 【设计意图】
   * - 框架层只负责提取 x-locale 和调用 i18nService
   * - 不做任何语言判断、规范化、fallback
   * - 所有语言逻辑交给 i18nService.translateErrorMessage 统一处理
   */
  private async getTranslatedMessage(exception: IBusinessException, request?: IdentityRequest): Promise<string> {
    try {
      const i18nService = this.getI18nService();
      if (!i18nService) {
        return exception.userMessage;
      }

      // 提取原始 x-locale（不做任何处理）
      const locale = this.getLocaleFromRequest(request);

      // 直接传给 i18nService，让它处理一切（语言解析、缓存、翻译、fallback）
      return await i18nService.translateErrorMessage({
        key: `errors.${exception.getCombinedCode()}`,
        sourceMessage: exception.userMessage,
        targetLanguage: locale, // null / 'zh-Hans' / 'en' / 任意格式
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(f`#getTranslatedMessage 翻译失败: ${reason}`);
      return exception.userMessage;
    }
  }

  /**
   * 从请求中提取用户语言偏好
   *
   * 【设计意图】
   * - 只提取 x-locale 请求头的原始值
   * - 不做任何规范化、验证、fallback
   * - 返回 null 表示用户未指定语言偏好
   * - 所有语言逻辑交给 i18nService 处理
   */
  private getLocaleFromRequest(request?: IdentityRequest): string | null {
    if (!request?.headers) {
      return null;
    }

    const xLocale = request.headers['x-locale'];

    if (typeof xLocale === 'string') {
      const trimmed = xLocale.trim();

      // 过滤空字符串和通配符
      if (trimmed && trimmed !== '*') {
        return trimmed; // 原样返回：'zh-Hans', 'zh-hans', 'en', 'zh', ...
      }
    }

    return null;
  }
}

function maskConnectionParams(params: Record<string, unknown>) {
  const clone: Record<string, unknown> = { ...params };
  for (const key of Object.keys(clone)) {
    if (/authorization/i.test(key) && typeof clone[key] === 'string') {
      const value = String(clone[key]);
      clone[key] = value.length > 20 ? `${value.slice(0, 20)}…` : value;
    }
  }
  return clone;
}

function isValidErrorCode(code: unknown): code is ErrorCodeValue {
  return Object.values(ErrorCodes).includes(code as ErrorCodes);
}
