import { RpcException } from '@nestjs/microservices';

import { getConfiguredGrpcServiceToken, GrpcServiceTokenGuard } from './grpc-service-token.guard';

import { Metadata, status } from '@grpc/grpc-js';
import { afterEach, describe, expect, it } from 'bun:test';

import type { ExecutionContext } from '@nestjs/common';

const ORIGINAL_TOKEN = process.env.GRPC_SERVICE_TOKEN;

function restoreToken() {
  if (ORIGINAL_TOKEN === undefined) {
    delete process.env.GRPC_SERVICE_TOKEN;
  } else {
    process.env.GRPC_SERVICE_TOKEN = ORIGINAL_TOKEN;
  }
}

function rpcContext(metadata: Metadata): ExecutionContext {
  return {
    getType: () => 'rpc',
    switchToRpc: () => ({
      getContext: () => metadata,
    }),
  } as unknown as ExecutionContext;
}

function nonRpcContext(): ExecutionContext {
  return {
    getType: () => 'http',
  } as unknown as ExecutionContext;
}

function expectUnauthenticated(fn: () => unknown, message: string) {
  try {
    fn();
    expect.unreachable('expected RpcException');
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toEqual({
      code: status.UNAUTHENTICATED,
      message,
    });
  }
}

describe('GrpcServiceTokenGuard', () => {
  afterEach(restoreToken);

  it('normalizes missing and blank GRPC_SERVICE_TOKEN to undefined', () => {
    delete process.env.GRPC_SERVICE_TOKEN;
    expect(getConfiguredGrpcServiceToken()).toBeUndefined();

    process.env.GRPC_SERVICE_TOKEN = '   ';
    expect(getConfiguredGrpcServiceToken()).toBeUndefined();

    process.env.GRPC_SERVICE_TOKEN = ' secret ';
    expect(getConfiguredGrpcServiceToken()).toBe('secret');
  });

  it('allows non-RPC contexts without requiring a service token', () => {
    delete process.env.GRPC_SERVICE_TOKEN;
    expect(new GrpcServiceTokenGuard().canActivate(nonRpcContext())).toBe(true);
  });

  it('rejects RPC requests when GRPC_SERVICE_TOKEN is missing or blank', () => {
    const metadata = new Metadata();

    delete process.env.GRPC_SERVICE_TOKEN;
    expectUnauthenticated(
      () => new GrpcServiceTokenGuard().canActivate(rpcContext(metadata)),
      'GRPC_SERVICE_TOKEN is required for gRPC mode',
    );

    process.env.GRPC_SERVICE_TOKEN = '  ';
    expectUnauthenticated(
      () => new GrpcServiceTokenGuard().canActivate(rpcContext(metadata)),
      'GRPC_SERVICE_TOKEN is required for gRPC mode',
    );
  });

  it('rejects missing or wrong x-service-token metadata', () => {
    process.env.GRPC_SERVICE_TOKEN = 'expected';

    expectUnauthenticated(
      () => new GrpcServiceTokenGuard().canActivate(rpcContext(new Metadata())),
      'Missing service token in gRPC metadata',
    );

    const wrong = new Metadata();
    wrong.set('x-service-token', 'wrong');
    expectUnauthenticated(() => new GrpcServiceTokenGuard().canActivate(rpcContext(wrong)), 'Invalid service token');
  });

  it('allows matching x-service-token metadata', () => {
    process.env.GRPC_SERVICE_TOKEN = 'expected';
    const metadata = new Metadata();
    metadata.set('x-service-token', 'expected');

    expect(new GrpcServiceTokenGuard().canActivate(rpcContext(metadata))).toBe(true);
  });
});
