import { AnyExceptionFilter } from './any-exception.filter';
import { ErrorCodes } from './error-codes';
import { Oops } from './oops';

import './oops-factories';

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

import { describe, expect, it, mock } from 'bun:test';
import { ZodError } from 'zod';

import type { ArgumentsHost } from '@nestjs/common';

// ==================== Test Helpers ====================

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
  overrides?: Partial<{ ip: string; uid: string; headers: Record<string, string>; path: string }>,
) {
  return {
    ip: overrides?.ip ?? '127.0.0.1',
    user: { uid: overrides?.uid ?? 'test-user' },
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

// ==================== Tests ====================

describe('AnyExceptionFilter', () => {
  const filter = new AnyExceptionFilter();

  // ==================== HTTP: OopsError ====================

  describe('HTTP: OopsError', () => {
    it('Oops 422 → warning 级别 + 422 响应', async () => {
      const { host, response } = createHttpHost();
      const exception = Oops.Validation('参数不合法');

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

  // ==================== HTTP: Legacy duck-typing ====================

  describe('HTTP: isBusinessException duck-typing', () => {
    it('完整 OopsLike 对象 → 按 httpStatus 响应', async () => {
      const { host, response } = createHttpHost();
      const exception = {
        httpStatus: 422,
        userMessage: 'legacy error',
        getCombinedCode: () => '0x0201LEGACY',
        getInternalDetails: () => 'internal',
      };

      await filter.catch(exception, host);

      expect(response.status).toHaveBeenCalledWith(422);
      const body = getResponseBody(response);
      expect(body.code).toBe('0x0201LEGACY');
      expect(body.message).toBe('legacy error');
    });

    it('缺少 getCombinedCode → 不走 BusinessException 路径', async () => {
      const { host, response } = createHttpHost();
      const exception = {
        httpStatus: 422,
        userMessage: 'incomplete',
        // 缺少 getCombinedCode
      };

      await filter.catch(exception, host);

      // 走到兜底，不是 422 BusinessException
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
      const exception = Oops.Validation('参数不合法');

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

    it('Legacy duck-typing → throw GraphQLError', async () => {
      const { host } = createGraphqlHost();
      const exception = {
        httpStatus: 422,
        userMessage: 'legacy graphql',
        getCombinedCode: () => '0x0201LEGACY',
        getInternalDetails: () => 'detail',
      };

      await expect(filter.catch(exception, host)).rejects.toThrow();
    });

    it('UnauthorizedException → 静默 throw 原始异常', async () => {
      const { host } = createGraphqlHost();
      const exception = new UnauthorizedException('not authed');

      try {
        await filter.catch(exception, host);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(UnauthorizedException);
      }
    });

    it('其他异常 → throw 原始异常', async () => {
      const { host } = createGraphqlHost();
      const exception = new Error('unexpected graphql error');

      try {
        await filter.catch(exception, host);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBe(exception);
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
  });
});
