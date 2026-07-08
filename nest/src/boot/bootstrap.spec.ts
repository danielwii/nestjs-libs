import { assertGrpcServiceTokenConfiguredForMode } from './bootstrap';

import { afterEach, describe, expect, it } from 'bun:test';

const ORIGINAL_TOKEN = process.env.GRPC_SERVICE_TOKEN;

function restoreToken() {
  if (ORIGINAL_TOKEN === undefined) {
    delete process.env.GRPC_SERVICE_TOKEN;
  } else {
    process.env.GRPC_SERVICE_TOKEN = ORIGINAL_TOKEN;
  }
}

describe('assertGrpcServiceTokenConfiguredForMode', () => {
  afterEach(restoreToken);

  it('does not require GRPC_SERVICE_TOKEN outside grpc mode', () => {
    delete process.env.GRPC_SERVICE_TOKEN;

    expect(() => assertGrpcServiceTokenConfiguredForMode('api')).not.toThrow();
    expect(() => assertGrpcServiceTokenConfiguredForMode('scheduler')).not.toThrow();
  });

  it('throws before grpc bootstrap can continue when GRPC_SERVICE_TOKEN is missing or blank', () => {
    delete process.env.GRPC_SERVICE_TOKEN;
    expect(() => assertGrpcServiceTokenConfiguredForMode('grpc')).toThrow(
      'GRPC_SERVICE_TOKEN is required for gRPC mode',
    );

    process.env.GRPC_SERVICE_TOKEN = '   ';
    expect(() => assertGrpcServiceTokenConfiguredForMode('grpc')).toThrow(
      'GRPC_SERVICE_TOKEN is required for gRPC mode',
    );
  });

  it('allows grpc mode when GRPC_SERVICE_TOKEN is configured', () => {
    process.env.GRPC_SERVICE_TOKEN = 'secret';

    expect(() => assertGrpcServiceTokenConfiguredForMode('grpc')).not.toThrow();
  });
});
