import { ErrorCodes } from './error-codes';
import { GrpcExceptionFilter } from './grpc-exception.filter';
import { Oops } from './oops';

import './oops-factories';

import { HttpException, HttpStatus, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

import { Metadata, status } from '@grpc/grpc-js';
import { describe, expect, it, mock } from 'bun:test';
import { firstValueFrom } from 'rxjs';

import type { ArgumentsHost } from '@nestjs/common';

// ==================== Test Helpers ====================

function makeOops422(overrides?: Partial<{ oopsCode: string; userMessage: string }>) {
  return new Oops({
    errorCode: ErrorCodes.EXTERNAL_API_UNAVAILABLE,
    oopsCode: overrides?.oopsCode ?? 'MG40001',
    userMessage: overrides?.userMessage ?? '设备不在线',
    internalDetails: 'device offline',
    provider: 'marsgate',
  });
}

function makeOopsPanic() {
  return Oops.Panic.ExternalService('marsgate', 'connection refused');
}

/** 模拟 ArgumentsHost（gRPC 上下文） */
function mockGrpcHost() {
  const sentMetadata: Metadata[] = [];
  const callObj = {
    sendMetadata: (m: Metadata) => sentMetadata.push(m),
  };

  const host: ArgumentsHost = {
    switchToRpc: () => ({
      getData: () => ({}),
      getContext: () => new Metadata(),
    }),
    switchToHttp: () => ({ getRequest: () => ({}), getResponse: () => ({}) }) as never,
    switchToWs: () => ({ getClient: () => ({}), getData: () => ({}) }) as never,
    getArgs: () => [{}, new Metadata(), callObj],
    getArgByIndex: (index: number) => [undefined, undefined, callObj][index],
    getType: () => 'rpc' as const,
  } as unknown as ArgumentsHost;

  return { host, sentMetadata, callObj };
}

// ==================== Tests ====================

describe('GrpcExceptionFilter', () => {
  const filter = new GrpcExceptionFilter('test-provider');

  describe('Oops (422, isFatal=false)', () => {
    it('should return OK status with x-oops-error-bin metadata', async () => {
      const { host, sentMetadata } = mockGrpcHost();
      const exception = makeOops422();

      const result$ = filter.catch(exception, host);
      const response = await firstValueFrom(result$);

      // 返回空对象（OK response）
      expect(response).toEqual({});

      // 发送了 initial metadata
      expect(sentMetadata).toHaveLength(1);
      const errorHeader = sentMetadata[0]!.get('x-oops-error-bin');
      expect(errorHeader).toHaveLength(1);

      // -bin metadata 返回 Buffer，decode 为 JSON
      const parsed = JSON.parse(Buffer.from(errorHeader[0] as Buffer).toString('utf-8'));
      expect(parsed.httpStatus).toBe(422);
      expect(parsed.businessCode).toBe('MG40001');
      expect(parsed.userMessage).toBe('设备不在线');
      expect(parsed.provider).toBe('marsgate');
    });
  });

  describe('Oops.Panic (isFatal=true)', () => {
    it('should throw gRPC error with non-OK status code', async () => {
      const { host } = mockGrpcHost();
      const exception = makeOopsPanic();
      const captureFatalToSentry = mock(() => undefined);
      const scopedFilter = new GrpcExceptionFilter('test-provider');
      Object.assign(scopedFilter as object, { captureFatalToSentry });

      const result$ = scopedFilter.catch(exception, host);

      try {
        await firstValueFrom(result$);
        expect(true).toBe(false); // should not reach
      } catch (error: unknown) {
        const grpcError = error as { code: number; details: string };
        expect(grpcError.code).toBe(status.INTERNAL);
        const parsed = JSON.parse(grpcError.details);
        expect(parsed.httpStatus).toBe(500);
      }

      expect(captureFatalToSentry).toHaveBeenCalledTimes(1);
      expect(captureFatalToSentry).toHaveBeenCalledWith(exception, host);
    });
  });

  describe('plain shape is not an OopsError', () => {
    it('hand-rolled object → unexpected INTERNAL path', async () => {
      const { host, sentMetadata } = mockGrpcHost();
      const exception = Object.assign(new Error('business error'), {
        httpStatus: 422,
        errorCode: '0x0302',
        businessCode: 'MG40001',
        userMessage: '设备不在线',
        isFatal: () => false,
        getCombinedCode: () => '0x0302MG40001',
      });

      const result$ = filter.catch(exception, host);

      try {
        await firstValueFrom(result$);
        expect.unreachable('expected unexpected path');
      } catch (error: unknown) {
        const grpcError = error as { code: number };
        expect(grpcError.code).toBe(status.INTERNAL);
        expect(sentMetadata).toHaveLength(0);
      }
    });
  });

  describe('ZodError', () => {
    it('should throw INVALID_ARGUMENT (unchanged behavior)', async () => {
      const { ZodError } = await import('zod');
      const { host } = mockGrpcHost();
      const exception = new ZodError([
        { code: 'invalid_type', expected: 'string', path: ['id'], message: 'Expected string' } as never,
      ]);

      const result$ = filter.catch(exception, host);

      try {
        await firstValueFrom(result$);
        expect(true).toBe(false);
      } catch (error: unknown) {
        const grpcError = error as { code: number };
        expect(grpcError.code).toBe(status.INVALID_ARGUMENT);
      }
    });
  });

  describe('HttpException', () => {
    it('should map UnauthorizedException to UNAUTHENTICATED', async () => {
      const { host } = mockGrpcHost();
      const result$ = filter.catch(new UnauthorizedException('not logged in'), host);

      try {
        await firstValueFrom(result$);
        expect.unreachable('expected HttpException to be thrown as gRPC error');
      } catch (error: unknown) {
        const grpcError = error as { code: number; details: string };
        expect(grpcError.code).toBe(status.UNAUTHENTICATED);
        const parsed = JSON.parse(grpcError.details) as { httpStatus: number; errorCode: string; businessCode: string };
        expect(parsed.httpStatus).toBe(HttpStatus.UNAUTHORIZED);
        expect(parsed.errorCode).toBe(ErrorCodes.CLIENT_AUTH_REQUIRED);
        expect(parsed.businessCode).toBe(ErrorCodes.CLIENT_AUTH_REQUIRED);
      }
    });

    it('should map NotFoundException to NOT_FOUND', async () => {
      const { host } = mockGrpcHost();
      const result$ = filter.catch(new NotFoundException('resource not found'), host);

      try {
        await firstValueFrom(result$);
        expect.unreachable('expected HttpException to be thrown as gRPC error');
      } catch (error: unknown) {
        const grpcError = error as { code: number; details: string };
        expect(grpcError.code).toBe(status.NOT_FOUND);
        const parsed = JSON.parse(grpcError.details) as { httpStatus: number; errorCode: string };
        expect(parsed.httpStatus).toBe(HttpStatus.NOT_FOUND);
        expect(parsed.errorCode).toBe(ErrorCodes.CLIENT_AUTH_REQUIRED);
      }
    });

    it('should map generic 4xx HttpException to INVALID_ARGUMENT', async () => {
      const { host } = mockGrpcHost();
      const result$ = filter.catch(new HttpException('not acceptable', HttpStatus.NOT_ACCEPTABLE), host);

      try {
        await firstValueFrom(result$);
        expect.unreachable('expected HttpException to be thrown as gRPC error');
      } catch (error: unknown) {
        const grpcError = error as { code: number; details: string };
        expect(grpcError.code).toBe(status.INVALID_ARGUMENT);
        const parsed = JSON.parse(grpcError.details) as { httpStatus: number; errorCode: string };
        expect(parsed.httpStatus).toBe(HttpStatus.NOT_ACCEPTABLE);
        expect(parsed.errorCode).toBe(ErrorCodes.CLIENT_INPUT_ERROR);
      }
    });

    it('should map 504 HttpException to DEADLINE_EXCEEDED', async () => {
      const { host } = mockGrpcHost();
      const result$ = filter.catch(new HttpException('gateway timeout', HttpStatus.GATEWAY_TIMEOUT), host);

      try {
        await firstValueFrom(result$);
        expect.unreachable('expected HttpException to be thrown as gRPC error');
      } catch (error: unknown) {
        const grpcError = error as { code: number; details: string };
        expect(grpcError.code).toBe(status.DEADLINE_EXCEEDED);
        const parsed = JSON.parse(grpcError.details) as { httpStatus: number; errorCode: string };
        expect(parsed.httpStatus).toBe(HttpStatus.GATEWAY_TIMEOUT);
        expect(parsed.errorCode).toBe(ErrorCodes.SYSTEM_INTERNAL_ERROR);
      }
    });
  });

  describe('RpcException', () => {
    it('should preserve explicit gRPC status codes from transport-native exceptions', async () => {
      const { host } = mockGrpcHost();
      const exception = new RpcException({
        code: status.UNAUTHENTICATED,
        message: 'Missing service token in gRPC metadata',
      });

      const result$ = filter.catch(exception, host);

      try {
        await firstValueFrom(result$);
        expect.unreachable('expected RpcException to be rethrown');
      } catch (error: unknown) {
        const grpcError = error as { code: number; details: string; message: string };
        expect(grpcError.code).toBe(status.UNAUTHENTICATED);
        expect(grpcError.details).toBe('Missing service token in gRPC metadata');
        expect(grpcError.message).toBe('Missing service token in gRPC metadata');
      }
    });

    it('should preserve status field as a gRPC code alias', async () => {
      const { host } = mockGrpcHost();
      const exception = new RpcException({
        status: status.PERMISSION_DENIED,
        message: 'Permission denied',
      });

      const result$ = filter.catch(exception, host);

      try {
        await firstValueFrom(result$);
        expect.unreachable('expected RpcException to be rethrown');
      } catch (error: unknown) {
        const grpcError = error as { code: number; details: string };
        expect(grpcError.code).toBe(status.PERMISSION_DENIED);
        expect(grpcError.details).toBe('Permission denied');
      }
    });

    it('should map plain RpcException messages to UNKNOWN', async () => {
      const { host } = mockGrpcHost();
      const exception = new RpcException('transport failed');

      const result$ = filter.catch(exception, host);

      try {
        await firstValueFrom(result$);
        expect.unreachable('expected RpcException to be rethrown');
      } catch (error: unknown) {
        const grpcError = error as { code: number; details: string };
        expect(grpcError.code).toBe(status.UNKNOWN);
        expect(grpcError.details).toBe('transport failed');
      }
    });
  });

  describe('canonical Oops instances', () => {
    it('Oops (422) should return OK with metadata', async () => {
      const { host, sentMetadata } = mockGrpcHost();
      const exception = new Oops({
        errorCode: ErrorCodes.CLIENT_INPUT_ERROR,
        oopsCode: 'GN01',
        userMessage: 'bad input',
        internalDetails: 'field missing',
      });

      const result$ = filter.catch(exception, host);
      const response = await firstValueFrom(result$);

      expect(response).toEqual({});
      expect(sentMetadata).toHaveLength(1);
    });

    it('Oops.Block (401) should throw UNAUTHENTICATED', async () => {
      const { host } = mockGrpcHost();
      const exception = Oops.Block.Unauthorized('expired token');

      const result$ = filter.catch(exception, host);

      try {
        await firstValueFrom(result$);
        expect(true).toBe(false);
      } catch (error: unknown) {
        const grpcError = error as { code: number };
        expect(grpcError.code).toBe(status.UNAUTHENTICATED);
      }
    });

    it('Oops.Block (404) should throw NOT_FOUND', async () => {
      const { host } = mockGrpcHost();
      const exception = Oops.Block.NotFound('User', 'u_123');

      const result$ = filter.catch(exception, host);

      try {
        await firstValueFrom(result$);
        expect(true).toBe(false);
      } catch (error: unknown) {
        const grpcError = error as { code: number };
        expect(grpcError.code).toBe(status.NOT_FOUND);
      }
    });

    it('Oops.Block request-boundary statuses should map to specific gRPC statuses', async () => {
      const cases = [
        { httpStatus: 408 as const, grpcStatus: status.DEADLINE_EXCEEDED },
        { httpStatus: 413 as const, grpcStatus: status.RESOURCE_EXHAUSTED },
        { httpStatus: 415 as const, grpcStatus: status.INVALID_ARGUMENT },
      ];

      for (const { httpStatus, grpcStatus } of cases) {
        const { host } = mockGrpcHost();
        const exception = new Oops.Block({
          httpStatus,
          errorCode: '0x0101',
          oopsCode: 'ST01',
          userMessage: 'stream request blocked',
        });

        const result$ = filter.catch(exception, host);

        try {
          await firstValueFrom(result$);
          expect.unreachable('expected Oops.Block to be thrown as gRPC error');
        } catch (error: unknown) {
          const grpcError = error as { code: number; details: string };
          expect(grpcError.code).toBe(grpcStatus);
          const parsed = JSON.parse(grpcError.details) as { httpStatus: number };
          expect(parsed.httpStatus).toBe(httpStatus);
        }
      }
    });

    it('Oops.Panic (500) should throw INTERNAL', async () => {
      const { host } = mockGrpcHost();
      const exception = Oops.Panic.Database('query failed');

      const result$ = filter.catch(exception, host);

      try {
        await firstValueFrom(result$);
        expect(true).toBe(false);
      } catch (error: unknown) {
        const grpcError = error as { code: number };
        expect(grpcError.code).toBe(status.INTERNAL);
      }
    });

    it('Oops.Panic upstream failure statuses should throw UNAVAILABLE', async () => {
      const cases = [502, 503] as const;

      for (const httpStatus of cases) {
        const { host } = mockGrpcHost();
        const exception = new Oops.Panic({
          httpStatus,
          errorCode: '0x0303',
          userMessage: 'upstream unavailable',
          internalDetails: 'dependency outage',
        });

        const result$ = filter.catch(exception, host);

        try {
          await firstValueFrom(result$);
          expect.unreachable('expected Oops.Panic to be thrown as gRPC error');
        } catch (error: unknown) {
          const grpcError = error as { code: number; details: string };
          expect(grpcError.code).toBe(status.UNAVAILABLE);
          const parsed = JSON.parse(grpcError.details) as { httpStatus: number };
          expect(parsed.httpStatus).toBe(httpStatus);
        }
      }
    });
  });
});
