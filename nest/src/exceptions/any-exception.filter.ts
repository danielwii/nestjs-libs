import { HttpStatus } from '@nestjs/common/enums';
import { GqlExecutionContext } from '@nestjs/graphql';

import { SysEnv } from '@app/env';
import { ApiRes } from '@app/nest/common/response';
import { ErrorCodes } from '@app/nest/exceptions/error-codes';
import { getAppLogger } from '@app/utils/app-logger';
import { getErrorMessage, getErrorName } from '@app/utils/error';

import { isServerError, toErrorDescriptor } from './error-descriptor';
import { OopsError } from './oops-error';

import { SentryExceptionCaptured } from '@sentry/nestjs';
import { GraphQLError } from 'graphql';
import * as _ from 'radash';

import type { IdentityRequest } from '../types/identity.interface';
import type { HttpErrorDescriptor } from './error-descriptor';
import type { II18nService } from '@app/nest/common/i18n.interface';
import type { ArgumentsHost, ExceptionFilter, ExecutionContext, INestApplication } from '@nestjs/common';
import type { Response } from 'express';

export { toErrorDescriptor } from './error-descriptor';
export type { HttpErrorDescriptor } from './error-descriptor';

type LocaleRequestLike = Omit<IdentityRequest, 'headers'> & {
  headers?: IdentityRequest['headers'];
};

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

/**
 * 全局异常边界（HTTP / GraphQL）。
 *
 * ## 业务异常契约（熵减）
 * - **唯一**业务异常类型：`OopsError`（`Oops` / `Oops.Block` / `Oops.Panic`）
 * - 识别方式：**仅** `instanceof OopsError`（共享同一 class 身份）
 * - 手搓 plain object / 自定义「长得像」的异常：**不**走业务路径，走 descriptor 或 500 兜底
 *
 * 调用方应 `throw Oops.*` / `throw new Oops.Block(...)`，不要依赖形状兼容。
 */
// @Catch() // or app.useGlobalFilters(new AnyExceptionFilter())
export class AnyExceptionFilter implements ExceptionFilter {
  private readonly logger = getAppLogger('AnyExceptionFilter');
  private i18nService: II18nService | null = null;
  private i18nServiceRetrieved = false;

  constructor(
    private readonly app?: INestApplication, // 应用实例，用于延迟获取服务
  ) {}

  async catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    // GraphQL 场景 getResponse() 可能返回空对象，而非完整 Express Response
    const rawResponse = ctx.getResponse<Response | Record<string, never>>();
    const isGraphqlRequest = !('status' in rawResponse) || typeof rawResponse.status !== 'function';

    let request: IdentityRequest | undefined = ctx.getRequest();

    if (!request?.headers && host.getType<'http' | 'graphql'>() === 'graphql') {
      const executionContext = host as unknown as ExecutionContext;
      const gqlCtx = GqlExecutionContext.create(executionContext).getContext<Record<string, unknown>>();
      request = (gqlCtx.req ?? gqlCtx.request ?? gqlCtx.expressReq ?? {}) as IdentityRequest;
    }

    if (host.getType<'http' | 'graphql' | 'ws'>() === 'ws') {
      const ws = host.switchToWs();
      const client = ws.getClient<{ connectionParams?: Record<string, unknown> }>();

      const params = (client as typeof client | undefined)?.connectionParams ?? {};

      this.logger.error`WS error ${{ transport: 'ws', connectionParams: maskConnectionParams(params) }} ${exception}`;
    }

    if (isGraphqlRequest) {
      if (exception instanceof OopsError) {
        return this.handleGraphqlOopsError(exception, request, host);
      }

      // 非 Oops：toErrorDescriptor 映射成带 extensions 的 GraphQLError
      // iOS 依赖 extensions.httpStatus 做自动登出等；裸 throw 不会带 httpStatus。
      const descriptor = toErrorDescriptor(exception);
      if (descriptor) {
        this.logMappedException(exception, request, descriptor, true);
        if (isServerError(descriptor.httpStatus)) {
          this.captureExceptionBySentry(exception, host);
        }
        throw new GraphQLError(descriptor.message, {
          extensions: {
            code: descriptor.code,
            httpStatus: descriptor.httpStatus,
            userMessage: descriptor.message,
            ...(descriptor.errors !== undefined ? { errors: descriptor.errors } : {}),
          },
        });
      }

      // 未识别异常：兜底 500 + Sentry
      this.captureExceptionBySentry(exception, host);
      const fallbackMessage = getErrorMessage(exception) || 'Internal server error';
      this.logger
        .error`<GraphqlRequest> (${request?.user?.uid})[${request?.ip}] ${getErrorName(exception)} ${fallbackMessage} ${exception}`;
      throw new GraphQLError(fallbackMessage, {
        extensions: {
          code: ErrorCodes.SYSTEM_INTERNAL_ERROR,
          httpStatus: HttpStatus.INTERNAL_SERVER_ERROR,
          userMessage: fallbackMessage,
        },
      });
    }

    const response = rawResponse as Response;

    if (exception instanceof OopsError) {
      return this.handleOopsError(exception, request, response, host);
    }

    // 非 Oops：toErrorDescriptor 统一映射（与 GraphQL 分支共享规则）
    const descriptor = toErrorDescriptor(exception);
    if (descriptor) {
      this.logMappedException(exception, request, descriptor, false);
      if (isServerError(descriptor.httpStatus)) {
        this.captureExceptionBySentry(exception, host);
      }
      return response.status(descriptor.httpStatus).json(
        ApiRes.failure({
          code: descriptor.code,
          message: descriptor.message,
          errors: descriptor.errors,
        }),
      );
    }

    // 只有未被识别的异常才交给 Sentry
    this.captureExceptionBySentry(exception, host);

    // 使用 type guard helpers 安全提取 unknown 异常的属性
    this.logger
      .error`(${request?.user?.uid})[${request?.ip}] ${getErrorName(exception)} ${getErrorMessage(exception)} ${exception}`;

    // unexpected error, each error should be handled
    // Unknown errors have no authority to choose their public HTTP status.
    // Framework-native exceptions are normalized above by toErrorDescriptor;
    // anything reaching this branch must fail closed as 500 even if a raw or
    // forged object happens to expose a numeric `status` field.
    const status = HttpStatus.INTERNAL_SERVER_ERROR;
    const message = getErrorMessage(exception);

    response.status(status).json({
      statusCode: status,
      message,
    });
    return;
  }

  /**
   * 统一日志入口：用 `toErrorDescriptor` 映射过的异常都走这里。
   *
   * - logLevel=error 时把原始 exception 附在末尾，保留 stack trace 便于排障
   * - 4xx (warning) 不带 stack，避免日志噪音
   * - GraphQL 上下文加 `<GraphqlRequest>` 前缀，方便在日志里按协议过滤
   */
  private logMappedException(
    exception: unknown,
    request: IdentityRequest | undefined,
    descriptor: HttpErrorDescriptor,
    isGraphql: boolean,
  ): void {
    const tag = isGraphql
      ? `<GraphqlRequest> (${request?.user?.uid})[${request?.ip}]`
      : `(${request?.user?.uid})[${request?.ip}]`;
    const name = getErrorName(exception);

    if (descriptor.logLevel === 'error') {
      this.logger
        .error`${tag} ${name}(${descriptor.httpStatus}) ${descriptor.message} code=${descriptor.code} ${exception}`;
    } else {
      this.logger.warning`${tag} ${name}(${descriptor.httpStatus}) ${descriptor.message} code=${descriptor.code}`;
    }
  }

  /**
   * 选择性捕获异常到 Sentry
   * 业务异常（4xx Oops / Block）不应该被 Sentry 捕获，因为这些是预期的业务逻辑
   */
  @SentryExceptionCaptured()
  private captureExceptionBySentry(_exception: unknown, _host: ArgumentsHost): void {
    // 该方法仅用于触发 @SentryExceptionCaptured 装饰器
    // 实际的异常处理逻辑在 catch 方法中继续执行
  }

  /**
   * 处理 OopsError，支持国际化翻译
   *
   * - httpStatus < 500: Oops / Block，warn 日志，不触发 Sentry
   * - httpStatus >= 500: Panic，error 日志，触发 Sentry
   */
  private async handleOopsError(
    exception: OopsError,
    request: IdentityRequest | undefined,
    response: Response,
    host: ArgumentsHost,
  ) {
    if (exception.isFatal()) {
      this.captureExceptionBySentry(exception, host);
      this.logger
        .error`(${request?.user?.uid})[${request?.ip}] Oops.Panic ${exception.getCombinedCode()} ${exception.userMessage} | ${exception.getInternalDetails()}`;
    } else if (exception.httpStatus !== 422) {
      this.logger
        .warning`(${request?.user?.uid})[${request?.ip}] Oops.Block(${exception.httpStatus}) ${exception.getCombinedCode()} ${exception.userMessage} | ${exception.getInternalDetails()}`;
    } else {
      this.logger
        .warning`(${request?.user?.uid})[${request?.ip}] Oops ${exception.getCombinedCode()} ${exception.userMessage} | ${exception.getInternalDetails()}`;
    }

    const translatedMessage = await this.getTranslatedMessage(exception, request);

    return response.status(exception.httpStatus).json(
      ApiRes.failure({
        code: exception.getCombinedCode(),
        message: translatedMessage,
      }),
    );
  }

  /**
   * GraphQL extensions 契约（所有 GraphQL 错误路径都遵循）：
   * `{ code: string, httpStatus: number, userMessage: string, ...extras }`
   * iOS 客户端统一通过 extensions.httpStatus 判断登出/重试等行为，不依赖具体异常类型。
   * Oops 路径额外带 errorCode / businessCode（= oopsCode）；non-Oops 路径可能带 errors。
   */
  private async handleGraphqlOopsError(
    exception: OopsError,
    request: IdentityRequest | undefined,
    host: ArgumentsHost,
  ): Promise<never> {
    if (exception.isFatal()) {
      this.captureExceptionBySentry(exception, host);
      this.logger
        .error`(${request?.user?.uid})[${request?.ip}] GraphQL Oops.Panic ${exception.getCombinedCode()} ${exception.userMessage} | ${exception.getInternalDetails()}`;
    } else if (exception.httpStatus !== 422) {
      this.logger
        .warning`(${request?.user?.uid})[${request?.ip}] GraphQL Oops.Block(${exception.httpStatus}) ${exception.getCombinedCode()} ${exception.userMessage} | ${exception.getInternalDetails()}`;
    } else {
      this.logger
        .warning`(${request?.user?.uid})[${request?.ip}] GraphQL Oops ${exception.getCombinedCode()} ${exception.userMessage} | ${exception.getInternalDetails()}`;
    }

    const translatedMessage = await this.getTranslatedMessage(exception, request);

    throw new GraphQLError(translatedMessage, {
      extensions: {
        code: exception.getCombinedCode(),
        httpStatus: exception.httpStatus,
        userMessage: translatedMessage,
        errorCode: exception.errorCode,
        businessCode: exception.oopsCode,
      },
    });
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
      this.logger.debug`#getI18nService I18nService已启用`;
      return this.i18nService;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.warning`#getI18nService 获取失败: ${errorMsg}`;
      return null;
    }
  }

  /**
   * 获取翻译后的错误消息
   *
   * 【设计意图】
   * - 框架层只负责选择语言信号源和调用 i18nService
   * - 不做任何语言判断、规范化
   * - 所有语言逻辑交给 i18nService.translateErrorMessage 统一处理
   */
  private async getTranslatedMessage(exception: OopsError, request?: LocaleRequestLike): Promise<string> {
    try {
      const i18nService = this.getI18nService();
      if (!i18nService) {
        return exception.userMessage;
      }

      const locale = this.getLocaleFromRequest(request);

      // 直接传给 i18nService，让它处理一切（语言解析、缓存、翻译、fallback）
      return await i18nService.translateErrorMessage({
        key: `errors.${exception.getCombinedCode()}`,
        sourceMessage: exception.userMessage,
        targetLanguage: locale, // null / 'zh-Hans' / 'en' / 任意格式
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warning`#getTranslatedMessage 翻译失败: ${reason}`;
      return exception.userMessage;
    }
  }

  /**
   * 从请求中提取用户语言偏好
   *
   * 【设计意图】
   * - 优先 x-locale 请求头
   * - 兜底 authenticated identity claim: request.user.preferredLocale
   * - 不读取产品特定字段，如 request.user.language
   * - 不做任何 locale 规范化或验证
   * - 返回 null 表示没有可用语言信号
   * - 所有语言逻辑交给 i18nService 处理
   */
  private getLocaleFromRequest(request?: LocaleRequestLike): string | null {
    if (!request) {
      return null;
    }

    const headers = request.headers ?? {};
    const xLocale = headers['x-locale'];

    if (typeof xLocale === 'string') {
      const trimmed = xLocale.trim();

      // 过滤空字符串和通配符
      if (trimmed && trimmed !== '*') {
        return trimmed; // 原样返回：'zh-Hans', 'zh-hans', 'en', 'zh', ...
      }
    }

    const preferredLocale = request.user?.preferredLocale;
    if (typeof preferredLocale === 'string') {
      const trimmed = preferredLocale.trim();
      if (trimmed && trimmed !== '*') {
        return trimmed;
      }
    }

    return null;
  }
}

function maskConnectionParams(params: Record<string, unknown>) {
  const clone: Record<string, unknown> = { ...params };
  for (const key of Object.keys(clone)) {
    if (/authorization/i.test(key) && typeof clone[key] === 'string') {
      const value = clone[key];
      clone[key] = value.length > 20 ? `${value.slice(0, 20)}…` : value;
    }
  }
  return clone;
}
