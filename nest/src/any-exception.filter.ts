import {
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SentryExceptionCaptured } from '@sentry/nestjs';
import { ThrottlerException } from '@nestjs/throttler';
import { HttpStatus } from '@nestjs/common/enums';
import { GraphQLError } from 'graphql';
import { ZodError } from 'zod';
import _ from 'lodash';

import { Prisma } from '@/generated/prisma/client';
import { ErrorCodes } from '@app/nest/error-codes';
import { errorStack, f } from '@app/utils';
import { ApiRes } from '@app/nest';
import { IBusinessException } from './business-exception.interface';
import { II18nService } from './i18n.interface';
import { GqlExecutionContext } from '@nestjs/graphql';

import type { ArgumentsHost, ExceptionFilter, INestApplication, ExecutionContext } from '@nestjs/common';
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
  private i18nService: II18nService | null = null;
  private i18nServiceRetrieved = false;

  constructor(
    private readonly app?: INestApplication // 应用实例，用于延迟获取服务
  ) {}

  async catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response: Response = ctx.getResponse();
    const isGraphqlRequest = typeof response?.status !== 'function';

    let request: (Request & { uid?: string }) | undefined = ctx.getRequest();

    if (!request?.headers && host.getType<'http' | 'graphql'>() === 'graphql') {
      const executionContext = host as unknown as ExecutionContext;
      const gqlCtx = GqlExecutionContext.create(executionContext).getContext<Record<string, any>>();
      request = (gqlCtx?.req || gqlCtx?.request || gqlCtx?.expressReq || {}) as Request & { uid?: string };
    }

    if (isGraphqlRequest) {
      if (this.isBusinessException(exception)) {
        return this.handleGraphqlBusinessException(exception, request);
      }

      this.logger.error(f`(${request?.uid})[${request?.ip}] ${exception.name} ${exception}`, exception.stack);
      throw exception;
    }

    // 处理 BusinessException（优先级最高）- 不触发 Sentry
    if (this.isBusinessException(exception)) {
      return this.handleBusinessException(exception, request, response);
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

    if (exception instanceof HttpException) {
      const status =
        typeof exception.getStatus === 'function'
          ? exception.getStatus()
          : (exception as any)?.status ?? HttpStatus.INTERNAL_SERVER_ERROR;
      const responseBody =
        typeof exception.getResponse === 'function' ? exception.getResponse() : exception.message;
      const message = typeof responseBody === 'string' ? responseBody : _.get(responseBody, 'message', exception.message);

      if (status < HttpStatus.INTERNAL_SERVER_ERROR) {
        this.logger.warn(
          f`(${request?.uid})[${request?.ip}] HttpException(${status}) ${exception.name} ${message}`,
          errorStack(exception),
        );

        return response.status(status).json(
          ApiRes.failure({
            code: ErrorCodes.CLIENT_INPUT_ERROR,
            message,
            errors: typeof responseBody === 'object' ? _.get(responseBody, 'message') : undefined,
          }),
        );
      }
    }

    // 只有未被识别的异常才交给 Sentry
    this.captureExceptionBySentry(exception, host);

    this.logger.error(f`(${request?.uid})[${request?.ip}] ${exception.name} ${exception}`, exception.stack);

    // unexpected error, each error should be handled
    const status = exception.status || 500;
    const message = exception.message || 'Internal Server Error';

    response.status(status).json({
      statusCode: status,
      message,
    });
  }

  /**
   * 判断是否为 BusinessException
   */
  private isBusinessException(exception: any): exception is IBusinessException {
    return exception &&
           typeof exception.httpStatus === 'number' &&
           typeof exception.userMessage === 'string' &&
           typeof exception.getCombinedCode === 'function';
  }

  /**
   * 选择性捕获异常到 Sentry
   * 业务异常（422）不应该被 Sentry 捕获，因为这些是预期的业务逻辑
   */
  @SentryExceptionCaptured()
  private captureExceptionBySentry(exception: any, host: ArgumentsHost): void {
    // 该方法仅用于触发 @SentryExceptionCaptured 装饰器
    // 实际的异常处理逻辑在 catch 方法中继续执行
  }

  /**
   * 处理 BusinessException，支持国际化翻译
   */
  private async handleBusinessException(
    exception: IBusinessException,
    request: (Request & { uid?: string }) | undefined,
    response: Response,
  ) {
    this.logger.warn(
      f`(${request?.uid})[${request?.ip}] BusinessException ${exception.getCombinedCode()} ${exception.userMessage}`
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
    request?: Request & { uid?: string },
  ): Promise<never> {
    this.logger.warn(
      f`(${request?.uid})[${request?.ip}] GraphQL BusinessException ${exception.getCombinedCode()} ${exception.userMessage}`
    );

    const translatedMessage = await this.getTranslatedMessage(exception, request);

    const extensions: Record<string, unknown> = {
      code: exception.getCombinedCode(),
      httpStatus: exception.httpStatus,
      userMessage: translatedMessage,
    };

    if ('errorCode' in exception) {
      extensions.errorCode = (exception as any).errorCode;
    }
    if ('businessCode' in exception) {
      extensions.businessCode = (exception as any).businessCode;
    }

    throw new GraphQLError(translatedMessage, { extensions });
  }

  /**
   * 延迟获取 I18nService
   */
  private getI18nService(): II18nService | null {
    if (this.i18nServiceRetrieved) {
      return this.i18nService;
    }

    this.i18nServiceRetrieved = true;
    
    if (!this.app) {
      return null;
    }

    try {
      // 使用字符串 token 获取服务，因为我们不想直接导入具体类
      const I18nServiceToken = 'I18nService';
      this.i18nService = this.app.get(I18nServiceToken, { strict: false });
      this.logger.debug('I18nService successfully retrieved for error translation');
      return this.i18nService;
    } catch (error) {
      this.logger.warn(`Failed to retrieve I18nService: ${error instanceof Error ? error.message : String(error)} - error translation disabled`);
      return null;
    }
  }

  /**
   * 获取翻译后的错误消息（智能翻译机制）
   */
  private async getTranslatedMessage(
    exception: IBusinessException,
    request?: Request
  ): Promise<string> {
    let locale = this.getDefaultLocale();
    let errorKey = '';

    try {
      this.logger.debug(f`#getTranslatedMessage called for code=${exception.getCombinedCode()}`);

      locale = this.getLocaleFromRequest(request);
      this.logger.debug(f`#getTranslatedMessage resolved locale=${locale}`);

      // 如果是默认语言，直接返回原消息
      if (locale === this.getDefaultLocale()) {
        this.logger.debug(f`#getTranslatedMessage locale is default, returning original message`);
        return exception.userMessage;
      }

      // 延迟获取 i18n 服务
      const i18nService = this.getI18nService();
      if (!i18nService) {
        this.logger.debug(f`#getTranslatedMessage i18nService not available, returning original message`);
        return exception.userMessage;
      }

      errorKey = `errors.${exception.getCombinedCode()}`;
      this.logger.debug(f`#getTranslatedMessage errorKey=${errorKey}`);

      // 1. 尝试从缓存获取翻译
      const messages = await i18nService.getMessagesByLocale(locale);
      // 使用 lodash get 方法来处理嵌套对象访问
      const cachedTranslation = _.get(messages, errorKey);

      if (cachedTranslation) {
        this.logger.debug(f`#getTranslatedMessage found cached translation for ${errorKey}`);
        return cachedTranslation;
      }

      this.logger.debug(f`#getTranslatedMessage no cached translation, starting background translation`);

      // 2. 没有缓存，启动后台翻译任务（不等待）
      this.translateInBackground(errorKey, exception.userMessage, locale);

      // 3. 立即返回原始消息，不阻塞错误响应
      return exception.userMessage;

    } catch (error) {
      const reason =
        error instanceof Error ? `${error.message} ${error.stack ?? ''}` : JSON.stringify(error);
      this.logger.warn(f`#getTranslatedMessage Translation check failed key=${errorKey || 'n/a'} locale=${locale || 'n/a'} reason=${reason}`);
      return exception.userMessage;
    }
  }

  /**
   * 后台异步翻译和缓存
   */
  private translateInBackground(
    errorKey: string,
    originalMessage: string,
    locale: string
  ): void {
    this.logger.debug(f`#translateInBackground called with key=${errorKey} locale=${locale} original="${originalMessage}"`);

    // 后台异步翻译，不影响当前请求
    setImmediate(async () => {
      try {
        const i18nService = this.getI18nService();
        if (!i18nService) {
          this.logger.debug(f`#translateInBackground i18nService not available`);
          return;
        }

        this.logger.debug(f`#translateInBackground 开始后台翻译: key=${errorKey} locale=${locale} original="${originalMessage}"`);

        const translated = await i18nService.translateMessage({
          key: errorKey,
          description: '错误消息翻译',
          sourceMessage: originalMessage,
          targetLanguage: locale,
        });

        // 翻译完成后缓存
        await this.cacheTranslation(errorKey, originalMessage, translated, locale);

        this.logger.debug(f`#translateInBackground 后台翻译完成: key=${errorKey} locale=${locale} translated="${translated}"`);

      } catch (error) {
        this.logger.warn(f`#translateInBackground 后台翻译失败: ${errorKey} locale=${locale} - ${error}`);
      }
    });
  }

  /**
   * 缓存翻译结果到数据库
   */
  private async cacheTranslation(
    errorKey: string,
    originalMessage: string,
    translatedMessage: string,
    locale: string
  ): Promise<void> {
    this.logger.debug(f`#cacheTranslation called with key=${errorKey} locale=${locale} translated="${translatedMessage}"`);

    try {
      const i18nService = this.getI18nService();
      if (!i18nService) {
        this.logger.debug(f`#cacheTranslation i18nService not available`);
        return;
      }

      this.logger.debug(f`#cacheTranslation upserting translation key: ${errorKey}`);

      // 确保翻译键存在
      await i18nService.prisma.i18nTranslationKey.upsert({
        where: { key: errorKey },
        create: {
          key: errorKey,
          description: f`自动生成: ${originalMessage}`
        },
        update: {}
      });

      this.logger.debug(f`#cacheTranslation upserting message: key=${errorKey} languageCode=${locale}`);

      // 保存翻译
      await i18nService.prisma.i18nMessage.upsert({
        where: { key_languageCode: { key: errorKey, languageCode: locale } },
        create: {
          key: errorKey,
          languageCode: locale,
          content: translatedMessage,
          isAIGenerated: true,
        },
        update: {
          content: translatedMessage,
          isAIGenerated: true,
        }
      });

      this.logger.debug(f`#cacheTranslation 缓存错误翻译成功: ${errorKey} -> ${locale}`);

    } catch (error) {
      this.logger.warn(f`#cacheTranslation 缓存翻译失败: key=${errorKey} locale=${locale} error=${error}`);
    }
  }

  private getDefaultLocale(): string {
    const value = process.env.APP_I18N_DEFAULT_LOCALE;
    return value && value.trim().length > 0 ? value.trim() : 'zh-Hans';
  }

  /**
   * 从请求中获取用户语言偏好
   */
  private getLocaleFromRequest(request?: Request): string {
    if (!request || typeof request.headers !== 'object') {
      const defaultLocale = this.getDefaultLocale();
      this.logger.debug(f`#getLocaleFromRequest no request/headers, returning default=${defaultLocale}`);
      return defaultLocale;
    }

    // 1. 优先从自定义头获取
    const customLocale = request.headers['x-locale'] as string;
    this.logger.debug(f`#getLocaleFromRequest customLocale=${customLocale}`);
    if (customLocale && customLocale !== '*') {
      this.logger.debug(f`#getLocaleFromRequest using customLocale=${customLocale}`);
      return customLocale;
    }

    // 2. 从 Accept-Language 头解析
    const acceptLanguage = request.headers['accept-language'];
    this.logger.debug(f`#getLocaleFromRequest acceptLanguage=${acceptLanguage}`);
    if (acceptLanguage && acceptLanguage !== '*') {
      // 解析 Accept-Language: "en-US,en;q=0.9,zh-CN;q=0.8" -> "en"
      const primaryLanguage = acceptLanguage.split(',')[0]?.split('-')[0]?.trim();
      this.logger.debug(f`#getLocaleFromRequest primaryLanguage=${primaryLanguage}`);
      if (primaryLanguage && primaryLanguage !== '*') {
        const resolvedLocale = primaryLanguage === 'zh' ? 'zh-Hans' : primaryLanguage;
        this.logger.debug(f`#getLocaleFromRequest using primaryLanguage, resolved=${resolvedLocale}`);
        return resolvedLocale;
      }
    }

    // 3. 默认语言
    const defaultLocale = this.getDefaultLocale();
    this.logger.debug(f`#getLocaleFromRequest falling back to default=${defaultLocale}`);
    return defaultLocale;
  }
}
