import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';

import { SysEnv } from '@app/env';

import { AnyExceptionFilter, toErrorDescriptor } from './any-exception.filter';
import { ErrorCodes } from './error-codes';
import { Oops } from './oops';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { GraphQLError } from 'graphql';
import { ZodError } from 'zod';

import type { ArgumentsHost } from '@nestjs/common';

// ==================== Test Helpers ====================

const ORIGINAL_I18N_EXCEPTION_ENABLED = SysEnv.I18N_EXCEPTION_ENABLED;

afterEach(() => {
  SysEnv.I18N_EXCEPTION_ENABLED = ORIGINAL_I18N_EXCEPTION_ENABLED;
});

function createMockResponse() {
  const res: Record<string, unknown> = {};
  res.status = mock((code: number) => {
    (res as { _statusCode: number })._statusCode = code;
    return res;
  });
  res.json = mock((body: unknown) => {
    (res as { _body: unknown })._body = body;
    return res;
  });
  return res as { status: ReturnType<typeof mock>; json: ReturnType<typeof mock>; _statusCode: number; _body: unknown };
}

function createMockRequest(
  overrides?: Partial<{
    ip: string;
    uid: string;
    preferredLocale: string;
    headers: Record<string, string>;
    path: string;
  }>,
) {
  return {
    ip: overrides?.ip ?? '127.0.0.1',
    user: { uid: overrides?.uid ?? 'test-user', preferredLocale: overrides?.preferredLocale },
    headers: overrides?.headers ?? {},
    path: overrides?.path ?? '/test',
  };
}

function createHttpHost(overrides?: { request?: ReturnType<typeof createMockRequest> }) {
  const response = createMockResponse();
  const request = overrides?.request ?? createMockRequest();

  const host = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    switchToWs: () => ({ getClient: () => ({}) }),
    getType: () => 'http',
  } as unknown as ArgumentsHost;

  return { host, response, request };
}

function createGraphqlHost(overrides?: { request?: ReturnType<typeof createMockRequest> }) {
  const request = overrides?.request ?? createMockRequest();

  // GraphQL: getResponse() 返回空对象（无 status 方法）
  const host = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
    switchToWs: () => ({ getClient: () => ({}) }),
    getType: () => 'graphql',
  } as unknown as ArgumentsHost;

  return { host, request };
}

function getResponseBody(response: ReturnType<typeof createMockResponse>) {
  return response._body as { success: boolean; code?: string; message?: string; errors?: unknown };
}

function createI18nFilter() {
  SysEnv.I18N_EXCEPTION_ENABLED = true;
  const translateErrorMessage = mock((options: { sourceMessage: string }) => Promise.resolve(options.sourceMessage));
  const app = {
    get: mock(() => ({
      translateErrorMessage,
    })),
  };
  return { filter: new AnyExceptionFilter(app as never), translateErrorMessage };
}

// ==================== Tests ====================

describe('AnyExceptionFilter', () => {
  const filter = new AnyExceptionFilter();

  // ==================== HTTP: OopsError ====================

  describe('HTTP: OopsError', () => {
    it('Oops 422 → warning 级别 + 422 响应', async () => {
      const { host, response } = createHttpHost();
      const exception = new Oops({
        errorCode: ErrorCodes.CLIENT_INPUT_ERROR,
        oopsCode: 'GN01',
        userMessage: '参数不合法',
      });

      await filter.catch(exception, host);

      expect(response.status).toHaveBeenCalledWith(422);
      const body = getResponseBody(response);
      expect(body.success).toBe(false);
      expect(body.code).toContain('GN01');
      expect(body.message).toBe('参数不合法');
    });

    it('Oops.Block 403 → Block warning + 403 响应', async () => {
      const { host, response } = createHttpHost();
      const exception = Oops.Block.Forbidden('admin');

      await filter.catch(exception, host);

      expect(response.status).toHaveBeenCalledWith(403);
      const body = getResponseBody(response);
      expect(body.success).toBe(false);
      expect(body.code).toContain('GN05');
    });

    it('Oops.Block 401 → 401 响应', async () => {
      const { host, response } = createHttpHost();
      const exception = Oops.Block.Unauthorized('token expired');

      await filter.catch(exception, host);

      expect(response.status).toHaveBeenCalledWith(401);
      const body = getResponseBody(response);
      expect(body.success).toBe(false);
    });

    it('Oops.Block 429 → 429 响应', async () => {
      const { host, response } = createHttpHost();
      const exception = Oops.Block.RateLimited('API');

      await filter.catch(exception, host);

      expect(response.status).toHaveBeenCalledWith(429);
    });

    it('Oops.Panic 500 → error 级别 + 500 响应', async () => {
      const { host, response } = createHttpHost();
      const exception = Oops.Panic.Database('insert');

      await filter.catch(exception, host);

      expect(response.status).toHaveBeenCalledWith(500);
      const body = getResponseBody(response);
      expect(body.success).toBe(false);
    });
  });

  describe('Oops observability routing', () => {
    it('does not send expected Oops or Block errors to Sentry', async () => {
      const scopedFilter = new AnyExceptionFilter();
      const captureExceptionBySentry = mock(() => undefined);
      Object.assign(scopedFilter as object, { captureExceptionBySentry });

      await scopedFilter.catch(
        new Oops({
          errorCode: ErrorCodes.BUSINESS_RULE_VIOLATION,
          oopsCode: 'TS05',
          userMessage: 'expected rejection',
        }),
        createHttpHost().host,
      );
      await scopedFilter.catch(Oops.Block.Unauthorized('expired token'), createHttpHost().host);

      expect(captureExceptionBySentry).not.toHaveBeenCalled();
    });

    it('sends HTTP and GraphQL Panic errors to Sentry exactly once per boundary event', async () => {
      const scopedFilter = new AnyExceptionFilter();
      const captureExceptionBySentry = mock(() => undefined);
      Object.assign(scopedFilter as object, { captureExceptionBySentry });

      const httpPanic = Oops.Panic.Database('http query');
      await scopedFilter.catch(httpPanic, createHttpHost().host);
      expect(captureExceptionBySentry).toHaveBeenCalledTimes(1);
      expect(captureExceptionBySentry).toHaveBeenLastCalledWith(httpPanic, expect.anything());

      const graphqlPanic = Oops.Panic.ExternalService('graphql provider');
      await expect(scopedFilter.catch(graphqlPanic, createGraphqlHost().host)).rejects.toBeInstanceOf(GraphQLError);
      expect(captureExceptionBySentry).toHaveBeenCalledTimes(2);
      expect(captureExceptionBySentry).toHaveBeenLastCalledWith(graphqlPanic, expect.anything());
    });
  });

  // ==================== HTTP: 非 OopsError 不走业务路径 ====================

  describe('HTTP: plain shape is not an OopsError', () => {
    it('凑齐字段的 plain object → 不按 422 业务路径处理', async () => {
      const { host, response } = createHttpHost();
      const exception = {
        httpStatus: 422,
        userMessage: 'hand-rolled',
        getCombinedCode: () => '0x0201LEGACY',
        getInternalDetails: () => 'internal',
      };

      await filter.catch(exception, host);

      // 契约：仅 instanceof OopsError 获得业务语义；手搓形状走兜底
      expect(response.status).toHaveBeenCalledWith(500);
    });
  });

  // ==================== HTTP: NestJS 内置异常 ====================

  describe('HTTP: NestJS 内置异常', () => {
    it('BadRequestException → 400 + CLIENT_INPUT_ERROR', async () => {
      const { host, response } = createHttpHost();

      await filter.catch(new BadRequestException('invalid field'), host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      const body = getResponseBody(response);
      expect(body.code).toBe(ErrorCodes.CLIENT_INPUT_ERROR);
    });

    it('UnauthorizedException → 401 + CLIENT_AUTH_REQUIRED', async () => {
      const { host, response } = createHttpHost();

      await filter.catch(new UnauthorizedException('not logged in'), host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
      const body = getResponseBody(response);
      expect(body.code).toBe(ErrorCodes.CLIENT_AUTH_REQUIRED);
    });

    it('NotFoundException → 404 + CLIENT_AUTH_REQUIRED', async () => {
      const { host, response } = createHttpHost();

      await filter.catch(new NotFoundException('resource not found'), host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      const body = getResponseBody(response);
      expect(body.code).toBe(ErrorCodes.CLIENT_AUTH_REQUIRED);
    });

    it('ConflictException → 409 + BUSINESS_DATA_CONFLICT', async () => {
      const { host, response } = createHttpHost();

      await filter.catch(new ConflictException('duplicate'), host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
      const body = getResponseBody(response);
      expect(body.code).toBe(ErrorCodes.BUSINESS_DATA_CONFLICT);
    });

    it('ThrottlerException → 429 + CLIENT_RATE_LIMITED', async () => {
      const { host, response } = createHttpHost();

      await filter.catch(new ThrottlerException('too many requests'), host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.TOO_MANY_REQUESTS);
      const body = getResponseBody(response);
      expect(body.code).toBe(ErrorCodes.CLIENT_RATE_LIMITED);
    });

    it('UnprocessableEntityException + BUSINESS_RULE_VIOLATION cause → warning 级别', async () => {
      const { host, response } = createHttpHost();
      const exception = new UnprocessableEntityException('rule violated');
      (exception as unknown as { cause: string }).cause = ErrorCodes.BUSINESS_RULE_VIOLATION;

      await filter.catch(exception, host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.UNPROCESSABLE_ENTITY);
      const body = getResponseBody(response);
      expect(body.code).toBe(ErrorCodes.BUSINESS_RULE_VIOLATION);
    });

    it('UnprocessableEntityException + 无效 cause → SYSTEM_INTERNAL_ERROR', async () => {
      const { host, response } = createHttpHost();
      const exception = new UnprocessableEntityException('unknown issue');

      await filter.catch(exception, host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.UNPROCESSABLE_ENTITY);
      const body = getResponseBody(response);
      expect(body.code).toBe(ErrorCodes.SYSTEM_INTERNAL_ERROR);
    });

    it('HttpException 4xx → warning，CLIENT_INPUT_ERROR', async () => {
      const { host, response } = createHttpHost();

      await filter.catch(new HttpException('not acceptable', HttpStatus.NOT_ACCEPTABLE), host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.NOT_ACCEPTABLE);
      const body = getResponseBody(response);
      expect(body.code).toBe(ErrorCodes.CLIENT_INPUT_ERROR);
    });

    it('HttpException 5xx → error + SYSTEM_INTERNAL_ERROR', async () => {
      const { host, response } = createHttpHost();

      await filter.catch(new HttpException('gateway timeout', HttpStatus.GATEWAY_TIMEOUT), host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.GATEWAY_TIMEOUT);
      const body = getResponseBody(response);
      expect(body.code).toBe(ErrorCodes.SYSTEM_INTERNAL_ERROR);
    });
  });

  // ==================== HTTP: 第三方异常 ====================

  describe('HTTP: 第三方异常', () => {
    it('ZodError → 400 + VALIDATION_FAILED + issues', async () => {
      const { host, response } = createHttpHost();
      const zodError = new ZodError([
        { code: 'invalid_type', expected: 'string', path: ['name'], message: 'Expected string' } as never,
      ]);

      await filter.catch(zodError, host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      const body = getResponseBody(response);
      expect(body.code).toBe(ErrorCodes.CLIENT_VALIDATION_FAILED);
      expect(body.errors).toBeDefined();
    });

    it('PrismaKnownRequestError（有 clientVersion）→ 422 + DATABASE_ERROR', async () => {
      const { host, response } = createHttpHost();
      const prismaError = Object.assign(new Error('Unique constraint'), {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: { target: ['email'] },
      });

      await filter.catch(prismaError, host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.UNPROCESSABLE_ENTITY);
      const body = getResponseBody(response);
      expect(body.code).toBe(ErrorCodes.SYSTEM_DATABASE_ERROR);
    });

    it('PrismaKnownRequestError（有构造函数名）→ 422 + DATABASE_ERROR', async () => {
      const { host, response } = createHttpHost();

      class PrismaClientKnownRequestError extends Error {
        code = 'P2002';
      }
      const prismaError = new PrismaClientKnownRequestError('Unique constraint');

      await filter.catch(prismaError, host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.UNPROCESSABLE_ENTITY);
      const body = getResponseBody(response);
      expect(body.code).toBe(ErrorCodes.SYSTEM_DATABASE_ERROR);
    });

    it('非 Prisma 错误（code 以 P 开头但无 clientVersion）→ 不走 Prisma 路径', async () => {
      const { host, response } = createHttpHost();
      const fakeError = Object.assign(new Error('not prisma'), { code: 'P9999' });

      await filter.catch(fakeError, host);

      // 走到兜底 500，不是 422 DATABASE_ERROR
      expect(response.status).toHaveBeenCalledWith(500);
    });

    it('FetchError → 422 + EXTERNAL_SERVICE_ERROR', async () => {
      const { host, response } = createHttpHost();
      const fetchError = new Error('connection refused');
      fetchError.name = 'FetchError';

      await filter.catch(fetchError, host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.UNPROCESSABLE_ENTITY);
      const body = getResponseBody(response);
      expect(body.code).toBe(ErrorCodes.EXTERNAL_SERVICE_ERROR);
    });
  });

  // ==================== HTTP: 兜底 ====================

  describe('HTTP: 兜底', () => {
    it('unknown Error → 500', async () => {
      const { host, response } = createHttpHost();

      await filter.catch(new Error('something broke'), host);

      expect(response.status).toHaveBeenCalledWith(500);
    });

    it('unknown Error 即使伪造 status 也仍为 500 + Sentry', async () => {
      const scopedFilter = new AnyExceptionFilter();
      const captureExceptionBySentry = mock(() => undefined);
      Object.assign(scopedFilter as object, { captureExceptionBySentry });
      const { host, response } = createHttpHost();
      const exception = Object.assign(new Error('forged status'), { status: HttpStatus.UNAUTHORIZED });

      await scopedFilter.catch(exception, host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(response._body).toEqual({ statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'forged status' });
      expect(captureExceptionBySentry).toHaveBeenCalledTimes(1);
      expect(captureExceptionBySentry).toHaveBeenCalledWith(exception, host);
    });

    it('非 Error 对象（string）→ 500', async () => {
      const { host, response } = createHttpHost();

      await filter.catch('raw string error', host);

      expect(response.status).toHaveBeenCalledWith(500);
    });

    it('null → 500', async () => {
      const { host, response } = createHttpHost();

      await filter.catch(null, host);

      expect(response.status).toHaveBeenCalledWith(500);
    });
  });

  // ==================== GraphQL ====================

  describe('GraphQL', () => {
    it('OopsError → throw GraphQLError + extensions', async () => {
      const { host } = createGraphqlHost();
      const exception = new Oops({
        errorCode: ErrorCodes.CLIENT_INPUT_ERROR,
        oopsCode: 'GN01',
        userMessage: '参数不合法',
      });

      await expect(filter.catch(exception, host)).rejects.toThrow();

      try {
        await filter.catch(exception, host);
      } catch (e: unknown) {
        const gqlError = e as { message: string; extensions: Record<string, unknown> };
        expect(gqlError.message).toBe('参数不合法');
        expect(gqlError.extensions.code).toContain('GN01');
        expect(gqlError.extensions.httpStatus).toBe(422);
      }
    });

    it('OopsError extensions 包含 errorCode', async () => {
      const { host } = createGraphqlHost();
      const exception = Oops.Validation('test');

      try {
        await filter.catch(exception, host);
      } catch (e: unknown) {
        const gqlError = e as { extensions: Record<string, unknown> };
        expect(gqlError.extensions.errorCode).toBeDefined();
      }
    });

    it('plain shape → GraphQL 兜底 500，不带业务 code', async () => {
      const { host } = createGraphqlHost();
      const exception = {
        httpStatus: 422,
        userMessage: 'hand-rolled graphql',
        getCombinedCode: () => '0x0201LEGACY',
        getInternalDetails: () => 'detail',
      };

      try {
        await filter.catch(exception, host);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(GraphQLError);
        const gqlError = e as GraphQLError;
        expect(gqlError.extensions.httpStatus).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
        expect(gqlError.extensions.code).toBe(ErrorCodes.SYSTEM_INTERNAL_ERROR);
      }
    });

    it('UnauthorizedException → GraphQLError + extensions.httpStatus=401 (iOS auto-logout 依赖)', async () => {
      const { host } = createGraphqlHost();
      const exception = new UnauthorizedException('not authed');

      try {
        await filter.catch(exception, host);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(GraphQLError);
        const gqlError = e as GraphQLError;
        expect(gqlError.extensions.httpStatus).toBe(HttpStatus.UNAUTHORIZED);
        expect(gqlError.extensions.code).toBe(ErrorCodes.CLIENT_AUTH_REQUIRED);
        expect(gqlError.message).toBe('not authed');
      }
    });

    it('BadRequestException → GraphQLError + extensions.httpStatus=400', async () => {
      const { host } = createGraphqlHost();
      const exception = new BadRequestException('invalid field');

      try {
        await filter.catch(exception, host);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(GraphQLError);
        const gqlError = e as GraphQLError;
        expect(gqlError.extensions.httpStatus).toBe(HttpStatus.BAD_REQUEST);
        expect(gqlError.extensions.code).toBe(ErrorCodes.CLIENT_INPUT_ERROR);
      }
    });

    it('ZodError → GraphQLError + extensions.httpStatus=400 + errors', async () => {
      const { host } = createGraphqlHost();
      const zodError = new ZodError([
        { code: 'invalid_type', expected: 'string', path: ['name'], message: 'Expected string' } as never,
      ]);

      try {
        await filter.catch(zodError, host);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(GraphQLError);
        const gqlError = e as GraphQLError;
        expect(gqlError.extensions.httpStatus).toBe(HttpStatus.BAD_REQUEST);
        expect(gqlError.extensions.code).toBe(ErrorCodes.CLIENT_VALIDATION_FAILED);
        expect(gqlError.extensions.errors).toBeDefined();
      }
    });

    it('ThrottlerException → GraphQLError + extensions.httpStatus=429', async () => {
      const { host } = createGraphqlHost();

      try {
        await filter.catch(new ThrottlerException('rate limited'), host);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(GraphQLError);
        const gqlError = e as GraphQLError;
        expect(gqlError.extensions.httpStatus).toBe(HttpStatus.TOO_MANY_REQUESTS);
        expect(gqlError.extensions.code).toBe(ErrorCodes.CLIENT_RATE_LIMITED);
      }
    });

    it('未识别异常 → GraphQLError + extensions.httpStatus=500 + userMessage (兜底)', async () => {
      const { host } = createGraphqlHost();
      const exception = new Error('unexpected graphql error');

      try {
        await filter.catch(exception, host);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(GraphQLError);
        const gqlError = e as GraphQLError;
        expect(gqlError.extensions.httpStatus).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
        expect(gqlError.extensions.code).toBe(ErrorCodes.SYSTEM_INTERNAL_ERROR);
        expect(gqlError.extensions.userMessage).toBe('unexpected graphql error');
        expect(gqlError.message).toBe('unexpected graphql error');
      }
    });
  });

  // ==================== i18n 翻译降级 ====================

  describe('i18n 翻译', () => {
    it('i18nService 不存在 → 返回原始 userMessage', async () => {
      const filterNoApp = new AnyExceptionFilter();
      const { host, response } = createHttpHost();
      const exception = Oops.Validation('原始消息');

      await filterNoApp.catch(exception, host);

      const body = getResponseBody(response);
      expect(body.message).toBe('原始消息');
    });

    it('x-locale 优先于 request.user.preferredLocale', async () => {
      const { filter: filterWithI18n, translateErrorMessage } = createI18nFilter();
      const { host } = createHttpHost({
        request: createMockRequest({
          headers: { 'x-locale': ' en-US ' },
          preferredLocale: 'zh-Hant',
        }),
      });

      await filterWithI18n.catch(Oops.Validation('原始消息'), host);

      expect(translateErrorMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          targetLanguage: 'en-US',
        }),
      );
    });

    it('x-locale 缺失时 fallback 到 typed request.user.preferredLocale', async () => {
      const { filter: filterWithI18n, translateErrorMessage } = createI18nFilter();
      const { host } = createHttpHost({
        request: createMockRequest({
          preferredLocale: ' zh-Hant ',
        }),
      });

      await filterWithI18n.catch(Oops.Validation('原始消息'), host);

      expect(translateErrorMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          targetLanguage: 'zh-Hant',
        }),
      );
    });

    it('headers 缺失时 fallback 到 typed request.user.preferredLocale', async () => {
      const { filter: filterWithI18n, translateErrorMessage } = createI18nFilter();
      const request = createMockRequest({
        preferredLocale: ' zh-Hant ',
      }) as ReturnType<typeof createMockRequest> & { headers?: Record<string, string> };
      Reflect.deleteProperty(request, 'headers');

      await filterWithI18n.catch(Oops.Validation('原始消息'), createHttpHost({ request }).host);

      expect(translateErrorMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          targetLanguage: 'zh-Hant',
        }),
      );
    });

    it('空 x-locale 和 wildcard x-locale fallback 到 preferredLocale', async () => {
      const emptyCase = createI18nFilter();
      await emptyCase.filter.catch(
        Oops.Validation('原始消息'),
        createHttpHost({ request: createMockRequest({ headers: { 'x-locale': ' ' }, preferredLocale: 'ja' }) }).host,
      );
      expect(emptyCase.translateErrorMessage).toHaveBeenCalledWith(expect.objectContaining({ targetLanguage: 'ja' }));

      const wildcardCase = createI18nFilter();
      await wildcardCase.filter.catch(
        Oops.Validation('原始消息'),
        createHttpHost({ request: createMockRequest({ headers: { 'x-locale': '*' }, preferredLocale: 'ko' }) }).host,
      );
      expect(wildcardCase.translateErrorMessage).toHaveBeenCalledWith(
        expect.objectContaining({ targetLanguage: 'ko' }),
      );
    });

    it('空 preferredLocale / wildcard preferredLocale / product-specific user.language 都不作为语言信号', async () => {
      for (const user of [
        { uid: 'u1', preferredLocale: ' ' },
        { uid: 'u1', preferredLocale: '*' },
        { uid: 'u1', language: 'zh-Hans' },
      ]) {
        const { filter: filterWithI18n, translateErrorMessage } = createI18nFilter();
        const request = createMockRequest();
        request.user = user as never;

        await filterWithI18n.catch(Oops.Validation('原始消息'), createHttpHost({ request }).host);

        expect(translateErrorMessage).toHaveBeenCalledWith(expect.objectContaining({ targetLanguage: null }));
      }
    });
  });
});

// ==================== toErrorDescriptor（纯函数，独立测试） ====================

describe('toErrorDescriptor', () => {
  it('ZodError → 400 + CLIENT_VALIDATION_FAILED + issues', () => {
    const zodError = new ZodError([
      { code: 'invalid_type', expected: 'string', path: ['name'], message: 'Expected string' } as never,
    ]);
    const desc = toErrorDescriptor(zodError);
    expect(desc).not.toBeNull();
    expect(desc?.httpStatus).toBe(HttpStatus.BAD_REQUEST);
    expect(desc?.code).toBe(ErrorCodes.CLIENT_VALIDATION_FAILED);
    expect(desc?.errors).toBeDefined();
    expect(desc?.logLevel).toBe('warning');
  });

  it('UnauthorizedException → 401 + CLIENT_AUTH_REQUIRED', () => {
    const desc = toErrorDescriptor(new UnauthorizedException('not authed'));
    expect(desc?.httpStatus).toBe(HttpStatus.UNAUTHORIZED);
    expect(desc?.code).toBe(ErrorCodes.CLIENT_AUTH_REQUIRED);
    expect(desc?.message).toBe('not authed');
    expect(desc?.logLevel).toBe('warning');
  });

  it('BadRequestException → 400 + CLIENT_INPUT_ERROR', () => {
    const desc = toErrorDescriptor(new BadRequestException('bad'));
    expect(desc?.httpStatus).toBe(HttpStatus.BAD_REQUEST);
    expect(desc?.code).toBe(ErrorCodes.CLIENT_INPUT_ERROR);
  });

  it('NotFoundException → 404 + CLIENT_AUTH_REQUIRED', () => {
    const desc = toErrorDescriptor(new NotFoundException('nope'));
    expect(desc?.httpStatus).toBe(HttpStatus.NOT_FOUND);
    expect(desc?.code).toBe(ErrorCodes.CLIENT_AUTH_REQUIRED);
  });

  it('ConflictException → 409 + BUSINESS_DATA_CONFLICT', () => {
    const desc = toErrorDescriptor(new ConflictException('dup'));
    expect(desc?.httpStatus).toBe(HttpStatus.CONFLICT);
    expect(desc?.code).toBe(ErrorCodes.BUSINESS_DATA_CONFLICT);
  });

  it('ThrottlerException → 429 + CLIENT_RATE_LIMITED', () => {
    const desc = toErrorDescriptor(new ThrottlerException('too many'));
    expect(desc?.httpStatus).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(desc?.code).toBe(ErrorCodes.CLIENT_RATE_LIMITED);
  });

  it('error-descriptor does not import optional throttler at module scope', () => {
    const source = readFileSync(join(import.meta.dir, 'error-descriptor.ts'), 'utf8');

    expect(source).not.toContain('@nestjs/throttler');
  });

  it('UnprocessableEntityException + BUSINESS_RULE_VIOLATION cause → warning', () => {
    const exception = new UnprocessableEntityException('rule violated');
    (exception as unknown as { cause: string }).cause = ErrorCodes.BUSINESS_RULE_VIOLATION;
    const desc = toErrorDescriptor(exception);
    expect(desc?.httpStatus).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(desc?.code).toBe(ErrorCodes.BUSINESS_RULE_VIOLATION);
    expect(desc?.logLevel).toBe('warning');
  });

  it('UnprocessableEntityException + 无效 cause → SYSTEM_INTERNAL_ERROR + error 级别', () => {
    const desc = toErrorDescriptor(new UnprocessableEntityException('unknown'));
    expect(desc?.httpStatus).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(desc?.code).toBe(ErrorCodes.SYSTEM_INTERNAL_ERROR);
    expect(desc?.logLevel).toBe('error');
  });

  it('HttpException 4xx → 状态码 + CLIENT_INPUT_ERROR + warning', () => {
    const desc = toErrorDescriptor(new HttpException('not acceptable', HttpStatus.NOT_ACCEPTABLE));
    expect(desc?.httpStatus).toBe(HttpStatus.NOT_ACCEPTABLE);
    expect(desc?.code).toBe(ErrorCodes.CLIENT_INPUT_ERROR);
    expect(desc?.logLevel).toBe('warning');
  });

  it('HttpException 5xx → 状态码 + SYSTEM_INTERNAL_ERROR + error', () => {
    const desc = toErrorDescriptor(new HttpException('gateway timeout', HttpStatus.GATEWAY_TIMEOUT));
    expect(desc?.httpStatus).toBe(HttpStatus.GATEWAY_TIMEOUT);
    expect(desc?.code).toBe(ErrorCodes.SYSTEM_INTERNAL_ERROR);
    expect(desc?.logLevel).toBe('error');
  });

  it('Prisma P2002 (鸭子类型) → 422 + SYSTEM_DATABASE_ERROR', () => {
    const prismaError = Object.assign(new Error('unique constraint'), {
      code: 'P2002',
      clientVersion: '5.0.0',
    });
    const desc = toErrorDescriptor(prismaError);
    expect(desc?.httpStatus).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(desc?.code).toBe(ErrorCodes.SYSTEM_DATABASE_ERROR);
  });

  it('FetchError (by name) → 422 + EXTERNAL_SERVICE_ERROR', () => {
    const err = new Error('connection refused');
    err.name = 'FetchError';
    const desc = toErrorDescriptor(err);
    expect(desc?.httpStatus).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(desc?.code).toBe(ErrorCodes.EXTERNAL_SERVICE_ERROR);
  });

  it('未识别的 Error → null (调用方兜底 500)', () => {
    expect(toErrorDescriptor(new Error('unknown'))).toBeNull();
  });

  it('null / string / object → null', () => {
    expect(toErrorDescriptor(null)).toBeNull();
    expect(toErrorDescriptor('string error')).toBeNull();
    expect(toErrorDescriptor({ foo: 'bar' })).toBeNull();
  });
});
