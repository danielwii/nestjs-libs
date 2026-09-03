import { Controller, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { GrpcMethod, Transport } from '@nestjs/microservices';

import { ErrorCodes } from '@app/nest/exceptions/error-codes';
import { GrpcExceptionFilter } from '@app/nest/exceptions/grpc-exception.filter';
import { Oops } from '@app/nest/exceptions/oops';
import { GrpcServiceTokenGuard } from '@app/nest/guards';
import { GraphqlAwareClassSerializerInterceptor } from '@app/nest/interceptors/graphql-aware-class-serializer.interceptor';
import { LoggerInterceptor } from '@app/nest/interceptors/logger.interceptor';

import {
  assertGrpcServiceTokenConfiguredForMode,
  assertRequiredEnvs,
  configureGrpcMicroserviceBoundary,
  connectGrpcMicroserviceWithBoundary,
  hasGrpcMicroserviceConfigured,
  resolveGrpcHybridAppOptions,
  resolveGrpcProvider,
} from './bootstrap';

import { createServer } from 'node:net';

import * as grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import type { INestApplication, OnModuleInit } from '@nestjs/common';
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

// ==================== hybrid gRPC 边界：真 transport ====================
//
// 上面的 GrpcBoundaryRecorder 只能证明 useGlobal* 被"调用"了；证明不了它"生效"。
// 2026-09-03 之前 bootstrap 正是这样空转的：connectMicroservice 当场把 enhancer 快照进 listener，
// 之后装的一个都没进管线，unee-server 的 gRPC 因此既无 token 守卫也无 GrpcExceptionFilter。
// 这组测试真起 Transport.GRPC，从 socket 打进来，断言行为。

const HYBRID_PROTO = new URL('./__fixtures__/hybrid-boundary-probe.proto', import.meta.url).pathname;
const HYBRID_TOKEN = 'hybrid-boundary-spec-token';
const HYBRID_LOADER = { keepCase: false, longs: String, enums: String, defaults: true, oneofs: true } as const;

const hybridLifecycle = { moduleInit: 0, appBootstrap: 0 };

class HybridLifecycleSentinel {
  onModuleInit(): void {
    hybridLifecycle.moduleInit += 1;
  }

  onApplicationBootstrap(): void {
    hybridLifecycle.appBootstrap += 1;
  }
}

@Controller()
class HybridProbeController {
  @GrpcMethod('HybridProbe', 'Ping')
  ping(data: { echo: string }) {
    return { echo: data.echo };
  }

  @GrpcMethod('HybridProbe', 'RejectWithBlock')
  rejectWithBlock(): never {
    throw new Oops.Block({
      httpStatus: 409,
      errorCode: ErrorCodes.CLIENT_RESOURCE_CONFLICT,
      oopsCode: 'PROBE_BLOCK',
      userMessage: 'probe block',
    });
  }

  @GrpcMethod('HybridProbe', 'ThrowPlainError')
  throwPlainError(): never {
    throw new Error('probe boom');
  }
}

@Module({ controllers: [HybridProbeController], providers: [HybridLifecycleSentinel] })
class HybridProbeModule {}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

type UnaryResult = { ok: { echo: string } } | { err: grpc.ServiceError };

describe('connectGrpcMicroserviceWithBoundary (real transport, api mode)', () => {
  let app: INestApplication;
  let client: Record<string, (...args: unknown[]) => void>;
  const rejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    rejections.push(reason);
  };

  const call = (method: string, withToken: boolean): Promise<UnaryResult> => {
    const metadata = new grpc.Metadata();
    if (withToken) metadata.set('x-service-token', HYBRID_TOKEN);
    const unary = client[method]?.bind(client); // grpc-js 客户端方法依赖 this，不能裸取
    if (!unary) throw new Error(`no such rpc: ${method}`);
    return new Promise((resolve) => {
      unary(
        { echo: method },
        metadata,
        { deadline: Date.now() + 3_000 },
        (err: grpc.ServiceError | null, res: { echo: string }) => resolve(err ? { err } : { ok: res }),
      );
    });
  };

  beforeAll(async () => {
    process.on('unhandledRejection', onUnhandledRejection);
    process.env.GRPC_SERVICE_TOKEN = HYBRID_TOKEN;
    hybridLifecycle.moduleInit = 0;
    hybridLifecycle.appBootstrap = 0;

    app = await NestFactory.create(HybridProbeModule, { logger: false });
    const port = await freePort();
    connectGrpcMicroserviceWithBoundary(
      app,
      {
        transport: Transport.GRPC,
        options: {
          package: 'libs.test.hybrid',
          protoPath: HYBRID_PROTO,
          url: `127.0.0.1:${port}`,
          loader: HYBRID_LOADER,
        },
      },
      'api',
      'HybridProbe',
    );
    // 与 bootstrap 同序：先起 microservice，再 init 根应用
    await app.startAllMicroservices();
    await app.init();

    const pkg = grpc.loadPackageDefinition(loadSync(HYBRID_PROTO, HYBRID_LOADER)) as unknown as {
      libs: { test: { hybrid: { HybridProbe: new (addr: string, creds: grpc.ChannelCredentials) => unknown } } };
    };
    client = new pkg.libs.test.hybrid.HybridProbe(
      `127.0.0.1:${port}`,
      grpc.credentials.createInsecure(),
    ) as typeof client;
  }, 30_000);

  afterAll(async () => {
    (client as unknown as { close?: () => void }).close?.();
    await app?.close();
    process.off('unhandledRejection', onUnhandledRejection);
    restoreToken();
  });

  it('missing x-service-token → UNAUTHENTICATED (the guard is actually in the pipeline)', async () => {
    const r = await call('ping', false);
    expect('err' in r).toBe(true);
    if (!('err' in r)) return;
    expect(r.err.code).toBe(grpc.status.UNAUTHENTICATED);
    expect(r.err.details).toContain('Missing service token');
  });

  it('valid token → handler runs', async () => {
    expect(await call('ping', true)).toEqual({ ok: { echo: 'ping' } });
  });

  it('handler throws Oops.Block(409) → ALREADY_EXISTS with structured details (GrpcExceptionFilter is in the pipeline)', async () => {
    const r = await call('rejectWithBlock', true);
    expect('err' in r).toBe(true);
    if (!('err' in r)) return;
    expect(r.err.code).toBe(grpc.status.ALREADY_EXISTS);
    expect(JSON.parse(r.err.details)).toMatchObject({ businessCode: 'PROBE_BLOCK', provider: 'HybridProbe' });
  });

  it('handler throws plain Error → INTERNAL with structured details', async () => {
    const r = await call('throwPlainError', true);
    expect('err' in r).toBe(true);
    if (!('err' in r)) return;
    expect(r.err.code).toBe(grpc.status.INTERNAL);
    expect(JSON.parse(r.err.details)).toMatchObject({ businessCode: 'INTERNAL_ERROR' });
  });

  it('lifecycle hooks run exactly once across startAllMicroservices + app.init', () => {
    expect(hybridLifecycle).toEqual({ moduleInit: 1, appBootstrap: 1 });
  });

  it('keeps serving after every failure mode; nothing leaked as unhandledRejection', async () => {
    expect(await call('ping', true)).toEqual({ ok: { echo: 'ping' } });
    expect(rejections).toEqual([]);
  });
});

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
    // 必须经 helper：deferInitialization 让 microservice.listen() 自己跑 lifecycle hook，
    // helper 用 setIsInitHookCalled(true) 交还给 app.init()。直接 connectMicroservice 会跑两遍。
    connectGrpcMicroserviceWithBoundary(app, { strategy: new NoopTransportStrategy() }, 'api', 'TestProvider');

    try {
      await app.startAllMicroservices();
      await app.init();

      expect(resolveGrpcHybridAppOptions('api')).toEqual({ inheritAppConfig: false, deferInitialization: true });
      expect(resolveGrpcHybridAppOptions('scheduler')).toEqual({ inheritAppConfig: false, deferInitialization: true });
      expect(resolveGrpcHybridAppOptions('grpc')).toEqual({ inheritAppConfig: true, deferInitialization: false });
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

describe('assertRequiredEnvs', () => {
  const ORIGINAL_VERTEX = process.env.AI_GOOGLE_VERTEX_API_KEY;
  const ORIGINAL_OPENROUTER = process.env.AI_OPENROUTER_API_KEY;

  afterEach(() => {
    if (ORIGINAL_VERTEX === undefined) delete process.env.AI_GOOGLE_VERTEX_API_KEY;
    else process.env.AI_GOOGLE_VERTEX_API_KEY = ORIGINAL_VERTEX;
    if (ORIGINAL_OPENROUTER === undefined) delete process.env.AI_OPENROUTER_API_KEY;
    else process.env.AI_OPENROUTER_API_KEY = ORIGINAL_OPENROUTER;
  });

  it('no-ops when keys are omitted or empty', () => {
    expect(() => assertRequiredEnvs()).not.toThrow();
    expect(() => assertRequiredEnvs([])).not.toThrow();
  });

  it('passes when all required SysEnvConfigKey values are non-blank', () => {
    process.env.AI_GOOGLE_VERTEX_API_KEY = 'vertex-key';
    process.env.AI_OPENROUTER_API_KEY = 'or-key';

    expect(() => assertRequiredEnvs(['AI_GOOGLE_VERTEX_API_KEY', 'AI_OPENROUTER_API_KEY'])).not.toThrow();
  });

  it('throws listing every missing or blank required env', () => {
    delete process.env.AI_GOOGLE_VERTEX_API_KEY;
    process.env.AI_OPENROUTER_API_KEY = '   ';

    expect(() => assertRequiredEnvs(['AI_GOOGLE_VERTEX_API_KEY', 'AI_OPENROUTER_API_KEY'])).toThrow(
      'required env(s) not set: AI_GOOGLE_VERTEX_API_KEY, AI_OPENROUTER_API_KEY',
    );
  });

  it('does not embed secret values in the error message', () => {
    process.env.AI_GOOGLE_VERTEX_API_KEY = 'super-secret-vertex-key';
    delete process.env.AI_OPENROUTER_API_KEY;

    try {
      assertRequiredEnvs(['AI_GOOGLE_VERTEX_API_KEY', 'AI_OPENROUTER_API_KEY']);
      expect.unreachable('expected assertRequiredEnvs to throw');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      expect(message).toContain('AI_OPENROUTER_API_KEY');
      expect(message).not.toContain('super-secret-vertex-key');
    }
  });
});
