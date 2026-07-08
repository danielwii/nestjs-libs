import { assertGrpcServiceTokenConfiguredForMode, hasGrpcMicroserviceConfigured } from './bootstrap';

import { afterEach, describe, expect, it } from 'bun:test';

const ORIGINAL_TOKEN = process.env.GRPC_SERVICE_TOKEN;
const GRPC_BOOTSTRAP_OPTIONS = {
  grpc: {
    package: 'test.Service',
    protoPath: 'test.proto',
  },
};

function restoreToken() {
  if (ORIGINAL_TOKEN === undefined) {
    delete process.env.GRPC_SERVICE_TOKEN;
  } else {
    process.env.GRPC_SERVICE_TOKEN = ORIGINAL_TOKEN;
  }
}

describe('assertGrpcServiceTokenConfiguredForMode', () => {
  afterEach(restoreToken);

  it('detects grpc microservice configuration independently from bootstrap mode', () => {
    expect(hasGrpcMicroserviceConfigured('api')).toBe(false);
    expect(hasGrpcMicroserviceConfigured('scheduler')).toBe(false);
    expect(hasGrpcMicroserviceConfigured('grpc')).toBe(true);
    expect(hasGrpcMicroserviceConfigured('api', GRPC_BOOTSTRAP_OPTIONS)).toBe(true);
    expect(hasGrpcMicroserviceConfigured('scheduler', GRPC_BOOTSTRAP_OPTIONS)).toBe(true);
  });

  it('does not require GRPC_SERVICE_TOKEN outside grpc mode', () => {
    delete process.env.GRPC_SERVICE_TOKEN;

    expect(() => assertGrpcServiceTokenConfiguredForMode('api')).not.toThrow();
    expect(() => assertGrpcServiceTokenConfiguredForMode('scheduler')).not.toThrow();
  });

  it('throws before grpc bootstrap can continue when GRPC_SERVICE_TOKEN is missing or blank', () => {
    delete process.env.GRPC_SERVICE_TOKEN;
    expect(() => assertGrpcServiceTokenConfiguredForMode('grpc')).toThrow(
      'GRPC_SERVICE_TOKEN is required when gRPC microservice is configured',
    );

    process.env.GRPC_SERVICE_TOKEN = '   ';
    expect(() => assertGrpcServiceTokenConfiguredForMode('grpc')).toThrow(
      'GRPC_SERVICE_TOKEN is required when gRPC microservice is configured',
    );
  });

  it('throws when api mode configures a grpc microservice without GRPC_SERVICE_TOKEN', () => {
    delete process.env.GRPC_SERVICE_TOKEN;

    expect(() => assertGrpcServiceTokenConfiguredForMode('api', GRPC_BOOTSTRAP_OPTIONS)).toThrow(
      'GRPC_SERVICE_TOKEN is required when gRPC microservice is configured',
    );
  });

  it('allows grpc mode when GRPC_SERVICE_TOKEN is configured', () => {
    process.env.GRPC_SERVICE_TOKEN = 'secret';

    expect(() => assertGrpcServiceTokenConfiguredForMode('grpc')).not.toThrow();
    expect(() => assertGrpcServiceTokenConfiguredForMode('api', GRPC_BOOTSTRAP_OPTIONS)).not.toThrow();
  });
});
