import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';

import { GrpcExceptionFilter } from '@app/nest/exceptions/grpc-exception.filter';
import { GrpcServiceTokenGuard } from '@app/nest/guards';
import { GraphqlAwareClassSerializerInterceptor } from '@app/nest/interceptors/graphql-aware-class-serializer.interceptor';
import { LoggerInterceptor } from '@app/nest/interceptors/logger.interceptor';

import {
  assertGrpcServiceTokenConfiguredForMode,
  configureGrpcMicroserviceBoundary,
  hasGrpcMicroserviceConfigured,
  resolveGrpcHybridAppOptions,
  resolveGrpcProvider,
} from './bootstrap';

import { afterEach, describe, expect, it } from 'bun:test';

import type { OnModuleInit } from '@nestjs/common';
import type { CustomTransportStrategy } from '@nestjs/microservices';

const ORIGINAL_TOKEN = process.env.GRPC_SERVICE_TOKEN;
const GRPC_BOOTSTRAP_OPTIONS = {
  grpc: {
    package: 'test.Service',
    protoPath: 'test.proto',
  },
};

class GrpcBoundaryRecorder {
  readonly filters: unknown[] = [];
  readonly guards: unknown[] = [];
  readonly interceptors: unknown[] = [];
  readonly pipes: unknown[] = [];

  useGlobalFilters(...filters: unknown[]): this {
    this.filters.push(...filters);
    return this;
  }

  useGlobalGuards(...guards: unknown[]): this {
    this.guards.push(...guards);
    return this;
  }

  useGlobalInterceptors(...interceptors: unknown[]): this {
    this.interceptors.push(...interceptors);
    return this;
  }

  useGlobalPipes(...pipes: unknown[]): this {
    this.pipes.push(...pipes);
    return this;
  }
}

let sharedInitHookCalls = 0;

class SharedLifecycleProbe implements OnModuleInit {
  onModuleInit(): void {
    sharedInitHookCalls += 1;
  }
}

@Module({ providers: [SharedLifecycleProbe] })
class HybridLifecycleTestModule {}

class NoopTransportStrategy implements CustomTransportStrategy {
  listen(callback: () => void): void {
    callback();
  }

  close(): void {}
}

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

  it('resolves grpc provider from explicit provider or grpc package', () => {
    expect(resolveGrpcProvider({ grpcProvider: 'explicit', ...GRPC_BOOTSTRAP_OPTIONS })).toBe('explicit');
    expect(resolveGrpcProvider({ grpc: { package: 'app.pkg.TestProvider', protoPath: 'test.proto' } })).toBe(
      'TestProvider',
    );
    expect(resolveGrpcProvider({ grpc: { package: ['app.pkg.FirstProvider'], protoPath: 'test.proto' } })).toBe(
      'FirstProvider',
    );
    expect(resolveGrpcProvider()).toBe('unknown');
  });

  it('configures hybrid grpc microservices with grpc boundary enhancers', () => {
    const target = new GrpcBoundaryRecorder();

    configureGrpcMicroserviceBoundary(
      target as unknown as Parameters<typeof configureGrpcMicroserviceBoundary>[0],
      new Reflector(),
      'TestProvider',
    );

    expect(target.pipes).toHaveLength(1);
    expect(target.pipes[0]).toBeInstanceOf(ValidationPipe);
    expect(target.filters).toHaveLength(1);
    expect(target.filters[0]).toBeInstanceOf(GrpcExceptionFilter);
    expect(target.guards).toHaveLength(1);
    expect(target.guards[0]).toBeInstanceOf(GrpcServiceTokenGuard);
    expect(target.interceptors).toHaveLength(2);
    expect(target.interceptors[0]).toBeInstanceOf(GraphqlAwareClassSerializerInterceptor);
    expect(target.interceptors[1]).toBeInstanceOf(LoggerInterceptor);
  });

  it('initializes shared providers once when an api app attaches a grpc microservice', async () => {
    sharedInitHookCalls = 0;
    const app = await NestFactory.create(HybridLifecycleTestModule, { logger: false });
    app.connectMicroservice({ strategy: new NoopTransportStrategy() }, resolveGrpcHybridAppOptions('api'));

    try {
      await app.startAllMicroservices();
      await app.init();

      expect(resolveGrpcHybridAppOptions('api')).toEqual({ inheritAppConfig: false });
      expect(resolveGrpcHybridAppOptions('grpc')).toEqual({ inheritAppConfig: true });
      expect(sharedInitHookCalls).toBe(1);
    } finally {
      await app.close();
    }
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
