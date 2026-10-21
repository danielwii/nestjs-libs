import { Controller, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { GrpcMethod, Transport } from '@nestjs/microservices';

import { createSchemaDto } from '@app/nest/contract/schema-dto';
import { AnyExceptionFilter } from '@app/nest/exceptions/any-exception.filter';
import { ErrorCodes } from '@app/nest/exceptions/error-codes';
import { GrpcExceptionFilter } from '@app/nest/exceptions/grpc-exception.filter';
import { Oops } from '@app/nest/exceptions/oops';
import { GrpcServiceTokenGuard } from '@app/nest/guards';
import { GraphqlAwareClassSerializerInterceptor } from '@app/nest/interceptors/graphql-aware-class-serializer.interceptor';
import { LoggerInterceptor } from '@app/nest/interceptors/logger.interceptor';
import { CursoredRequestInput, cursoredRequestSchema } from '@app/utils/graphql';

import {
  AppStandardSchemaValidationPipe,
  assertGrpcServiceTokenConfiguredForMode,
  assertRequiredEnvs,
  bootstrap,
  buildGrpcTransportOptions,
  configureGrpcMicroserviceBoundary,
  connectGrpcMicroserviceWithBoundary,
  createGlobalValidationPipes,
  describeGrpcMessageLimits,
  DualBoundaryValidationPipe,
  hasGrpcMicroserviceConfigured,
  resolveGrpcHybridAppOptions,
  resolveGrpcProvider,
} from './bootstrap';

import { createServer } from 'node:net';

import * as grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { throwError } from 'rxjs';
import { z } from 'zod';

import type { BootstrapOptions } from './bootstrap';
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
      'standard-schema',
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

// ==================== 故意接错线：microservice 继承了根应用的 AnyExceptionFilter ====================
//
// 这就是 calo-server 2026-09-03 崩溃时的接线（inheritAppConfig: true + app 级 AnyExceptionFilter）。
// 兜底要求：无论 handler 是同步 throw 还是返回 error Observable，客户端都拿到 INTERNAL，进程不退出、
// 零 unhandledRejection。**Observable 路径必须单独测**：RpcProxy 只在 handler 返回 Observable 时走
// catchError，而 catchError 拿到 Promise<Observable> 会把它当 next 值发出去 → 变成"成功"的垃圾响应。
// 同步 throw 那条路径两种写法都能过，所以只测它等于没测（Codex review #51）。

@Controller()
class MiswiredProbeController {
  @GrpcMethod('HybridProbe', 'Ping')
  ping(data: { echo: string }) {
    return { echo: data.echo };
  }

  @GrpcMethod('HybridProbe', 'RejectWithBlock')
  rejectViaObservable() {
    return throwError(() => new Error('rx boom'));
  }

  @GrpcMethod('HybridProbe', 'ThrowPlainError')
  throwPlainError(): never {
    throw new Error('sync boom');
  }
}

@Module({ controllers: [MiswiredProbeController] })
class MiswiredProbeModule {}

describe('gRPC message size limits', () => {
  const BASE = { package: 'libs.test.hybrid', protoPath: HYBRID_PROTO, loader: HYBRID_LOADER };

  it('passes the limits that are set and leaves the keys out when they are not (the grpc-js default stays)', () => {
    const unset = buildGrpcTransportOptions(BASE, '127.0.0.1:1');
    expect('maxReceiveMessageLength' in unset).toBe(false);
    expect('maxSendMessageLength' in unset).toBe(false);
    expect(unset).toMatchObject({ package: 'libs.test.hybrid', url: '127.0.0.1:1', gracefulShutdown: true });
    expect(buildGrpcTransportOptions({ ...BASE, maxReceiveMessageLength: 16 * 1024 * 1024 }, 'u')).toMatchObject({
      maxReceiveMessageLength: 16 * 1024 * 1024,
    });
    const both = buildGrpcTransportOptions({ ...BASE, maxReceiveMessageLength: 1, maxSendMessageLength: 2 }, 'u');
    expect(both).toMatchObject({ maxReceiveMessageLength: 1, maxSendMessageLength: 2 });
  });

  it('describes the limits in effect for the start-up log: the value when set, `default` when not', () => {
    expect(describeGrpcMessageLimits(buildGrpcTransportOptions(BASE, 'u'))).toBe('maxReceive=default maxSend=default');
    expect(
      describeGrpcMessageLimits(buildGrpcTransportOptions({ ...BASE, maxReceiveMessageLength: 16777216 }, 'u')),
    ).toBe('maxReceive=16777216 maxSend=default');
    expect(
      describeGrpcMessageLimits(
        buildGrpcTransportOptions({ ...BASE, maxReceiveMessageLength: 16777216, maxSendMessageLength: 1048576 }, 'u'),
      ),
    ).toBe('maxReceive=16777216 maxSend=1048576');
  });

  // The builder bootstrap calls produces the keys; this proves they reach grpc-js through the Nest transport.
  describe('real transport', () => {
    const PAYLOAD = 'x'.repeat(4096);
    let app: INestApplication;
    let client: Record<string, (...args: unknown[]) => void>;

    async function start(limits: { maxReceiveMessageLength?: number; maxSendMessageLength?: number }) {
      process.env.GRPC_SERVICE_TOKEN = HYBRID_TOKEN;
      app = await NestFactory.create(HybridProbeModule, { logger: false });
      const port = await freePort();
      connectGrpcMicroserviceWithBoundary(
        app,
        {
          transport: Transport.GRPC,
          options: buildGrpcTransportOptions({ ...BASE, ...limits }, `127.0.0.1:${port}`),
        },
        'api',
        'HybridProbe',
        'standard-schema',
      );
      await app.startAllMicroservices();
      await app.init();
      const pkg = grpc.loadPackageDefinition(loadSync(HYBRID_PROTO, HYBRID_LOADER)) as unknown as {
        libs: { test: { hybrid: { HybridProbe: new (addr: string, creds: grpc.ChannelCredentials) => unknown } } };
      };
      client = new pkg.libs.test.hybrid.HybridProbe(
        `127.0.0.1:${port}`,
        grpc.credentials.createInsecure(),
      ) as typeof client;
    }

    const ping = (echo: string): Promise<UnaryResult> => {
      const metadata = new grpc.Metadata();
      metadata.set('x-service-token', HYBRID_TOKEN);
      const unary = client.ping?.bind(client);
      if (!unary) throw new Error('no such rpc: ping');
      return new Promise((resolve) => {
        unary(
          { echo },
          metadata,
          { deadline: Date.now() + 3_000 },
          (err: grpc.ServiceError | null, res: { echo: string }) => resolve(err ? { err } : { ok: res }),
        );
      });
    };

    afterEach(async () => {
      (client as unknown as { close?: () => void }).close?.();
      await app?.close();
      restoreToken();
    });

    it('a request over the configured receive limit is rejected as RESOURCE_EXHAUSTED; one under it is served', async () => {
      await start({ maxReceiveMessageLength: 2048 });
      const over = await ping(PAYLOAD);
      expect('err' in over && over.err.code).toBe(grpc.status.RESOURCE_EXHAUSTED);
      const under = await ping('x'.repeat(100));
      expect('ok' in under && under.ok.echo).toBe('x'.repeat(100));
    }, 30_000);

    it('with no limit set the same request is served (the grpc-js default is far above it)', async () => {
      await start({});
      const result = await ping(PAYLOAD);
      expect('ok' in result && result.ok.echo.length).toBe(PAYLOAD.length);
    }, 30_000);
  });
});

describe('AnyExceptionFilter reached from a miswired gRPC microservice (real transport)', () => {
  let app: INestApplication;
  let client: Record<string, (...args: unknown[]) => void>;
  const rejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    rejections.push(reason);
  };

  const call = (method: string): Promise<UnaryResult> => {
    const unary = client[method]?.bind(client);
    if (!unary) throw new Error(`no such rpc: ${method}`);
    return new Promise((resolve) => {
      unary(
        { echo: method },
        new grpc.Metadata(),
        { deadline: Date.now() + 3_000 },
        (err: grpc.ServiceError | null, res: { echo: string }) => resolve(err ? { err } : { ok: res }),
      );
    });
  };

  beforeAll(async () => {
    process.on('unhandledRejection', onUnhandledRejection);
    app = await NestFactory.create(MiswiredProbeModule, { logger: false });
    app.useGlobalFilters(new AnyExceptionFilter());
    const port = await freePort();
    app.connectMicroservice(
      {
        transport: Transport.GRPC,
        options: {
          package: 'libs.test.hybrid',
          protoPath: HYBRID_PROTO,
          url: `127.0.0.1:${port}`,
          loader: HYBRID_LOADER,
        },
      },
      { inheritAppConfig: true },
    );
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
  });

  it('sync throw in handler → INTERNAL with the misconfiguration message, not a dead process', async () => {
    const r = await call('throwPlainError');
    expect('err' in r).toBe(true);
    if (!('err' in r)) return;
    expect(r.err.code).toBe(grpc.status.INTERNAL);
    expect(r.err.details).toContain('gRPC boundary misconfigured');
  });

  it('error Observable from handler → INTERNAL (the rpc branch must return synchronously)', async () => {
    const r = await call('rejectWithBlock');
    expect('err' in r).toBe(true);
    if (!('err' in r)) return;
    expect(r.err.code).toBe(grpc.status.INTERNAL);
    expect(r.err.details).toContain('gRPC boundary misconfigured');
  });

  it('keeps serving; nothing leaked as unhandledRejection', async () => {
    expect(await call('ping')).toEqual({ ok: { echo: 'ping' } });
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

  it('standard-schema: the grpc boundary mounts only the Standard Schema pipe and no class-transformer interceptor', () => {
    const target = new GrpcBoundaryRecorder();

    configureGrpcMicroserviceBoundary(
      target as unknown as Parameters<typeof configureGrpcMicroserviceBoundary>[0],
      new Reflector(),
      'TestProvider',
      'standard-schema',
    );

    expect(target.pipes).toHaveLength(1);
    expect(target.pipes[0]).toBeInstanceOf(AppStandardSchemaValidationPipe);
    expect(target.pipes.some((p) => p instanceof ValidationPipe)).toBe(false);
    expect(target.filters).toHaveLength(1);
    expect(target.filters[0]).toBeInstanceOf(GrpcExceptionFilter);
    expect(target.guards).toHaveLength(1);
    expect(target.guards[0]).toBeInstanceOf(GrpcServiceTokenGuard);
    expect(target.interceptors).toHaveLength(1);
    expect(target.interceptors[0]).toBeInstanceOf(LoggerInterceptor);
  });

  it('legacy: the grpc boundary keeps the previous default (Standard Schema + class-validator pipes, serializer + logger)', () => {
    const target = new GrpcBoundaryRecorder();

    configureGrpcMicroserviceBoundary(
      target as unknown as Parameters<typeof configureGrpcMicroserviceBoundary>[0],
      new Reflector(),
      'TestProvider',
      'legacy',
    );

    expect(target.pipes).toHaveLength(2);
    expect(target.pipes[0]).toBeInstanceOf(AppStandardSchemaValidationPipe);
    expect(target.pipes[1]).toBeInstanceOf(ValidationPipe);
    expect(target.filters).toHaveLength(1);
    expect(target.filters[0]).toBeInstanceOf(GrpcExceptionFilter);
    expect(target.guards).toHaveLength(1);
    expect(target.guards[0]).toBeInstanceOf(GrpcServiceTokenGuard);
    expect(target.interceptors).toHaveLength(2);
    expect(target.interceptors[0]).toBeInstanceOf(GraphqlAwareClassSerializerInterceptor);
    expect(target.interceptors[1]).toBeInstanceOf(LoggerInterceptor);
  });

  it.each(['standard-schema', 'legacy'] as const)(
    'connectGrpcMicroserviceWithBoundary forwards the %s mode into the microservice pipes',
    async (validation) => {
      const app = await NestFactory.create(HybridLifecycleTestModule, { logger: false });
      const grpcMs = connectGrpcMicroserviceWithBoundary(
        app,
        { strategy: new NoopTransportStrategy() },
        'api',
        'TestProvider',
        validation,
      );

      try {
        const pipes = (
          grpcMs as unknown as { applicationConfig: { getGlobalPipes(): unknown[] } }
        ).applicationConfig.getGlobalPipes();
        expect(pipes.some((p) => p instanceof AppStandardSchemaValidationPipe)).toBe(true);
        expect(pipes.some((p) => p instanceof ValidationPipe)).toBe(validation === 'legacy');
      } finally {
        await app.close();
      }
    },
  );

  it('connectGrpcMicroserviceWithBoundary applies a custom Standard Schema exceptionFactory to the microservice pipes', async () => {
    const rejectAll = {
      '~standard': { version: 1 as const, vendor: 'test', validate: () => ({ issues: [{ message: 'rejected' }] }) },
    };
    const metadata = { type: 'body' as const, schema: rejectAll };
    const app = await NestFactory.create(HybridLifecycleTestModule, { logger: false });
    const pipesOf = (ms: unknown) =>
      (ms as { applicationConfig: { getGlobalPipes(): AppStandardSchemaValidationPipe[] } }).applicationConfig
        .getGlobalPipes()
        .filter((p) => p instanceof AppStandardSchemaValidationPipe);
    const connect = (option?: Parameters<typeof connectGrpcMicroserviceWithBoundary>[5]) =>
      connectGrpcMicroserviceWithBoundary(
        app,
        { strategy: new NoopTransportStrategy() },
        'api',
        'TestProvider',
        'standard-schema',
        option,
      );

    try {
      const custom = pipesOf(connect({ exceptionFactory: () => new Error('custom-grpc-boundary-error') }));
      expect(custom).toHaveLength(1);
      await expect(custom[0]!.transform({}, metadata)).rejects.toThrow('custom-grpc-boundary-error');

      // 不传选项时仍是 Nest 默认的异常（对照：证明上面的自定义确实来自参数）
      const plain = pipesOf(connect());
      await expect(plain[0]!.transform({}, metadata)).rejects.not.toThrow('custom-grpc-boundary-error');
    } finally {
      await app.close();
    }
  });

  // 公开 API 不得单独出售 deferInitialization：它必须与 setIsInitHookCalled 成对，而调用方拿到
  // 半截就会在 startAllMicroservices() 提前跑 onModuleInit（Bull handler 双注册、Prisma/Redis 双连）。
  // 2026-09-03：libs 这边全绿合并，是 unee-server 的 reach-out-push-runtime.spec 逮到的 ——
  // 不变量只活在消费者测试里，libs 自己看不见。把它搬进来。
  it('resolveGrpcHybridAppOptions only decides config inheritance — never hands out deferInitialization', () => {
    expect(resolveGrpcHybridAppOptions('api')).toEqual({ inheritAppConfig: false });
    expect(resolveGrpcHybridAppOptions('scheduler')).toEqual({ inheritAppConfig: false });
    expect(resolveGrpcHybridAppOptions('grpc')).toEqual({ inheritAppConfig: true });
  });

  it('a direct connectMicroservice with these options must not run lifecycle hooks before app.init()', async () => {
    sharedInitHookCalls = 0;
    const app = await NestFactory.create(HybridLifecycleTestModule, { logger: false });
    // 消费者可能这样直连（unee-server 的 spec 就是）——不经 helper，所以没有 setIsInitHookCalled 补偿
    app.connectMicroservice({ strategy: new NoopTransportStrategy() }, resolveGrpcHybridAppOptions('api'));

    try {
      await app.startAllMicroservices();
      expect(sharedInitHookCalls).toBe(0);

      await app.init();
      expect(sharedInitHookCalls).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('initializes shared providers once when an api app attaches a grpc microservice', async () => {
    sharedInitHookCalls = 0;
    const app = await NestFactory.create(HybridLifecycleTestModule, { logger: false });
    // 必须经 helper：deferInitialization 让 microservice.listen() 自己跑 lifecycle hook，
    // helper 用 setIsInitHookCalled(true) 交还给 app.init()。直接 connectMicroservice 会跑两遍。
    connectGrpcMicroserviceWithBoundary(
      app,
      { strategy: new NoopTransportStrategy() },
      'api',
      'TestProvider',
      'standard-schema',
    );

    try {
      await app.startAllMicroservices();
      await app.init();

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

describe('AppStandardSchemaValidationPipe & DualBoundaryValidationPipe with callable schemas', () => {
  it('supports callable Standard Schema (e.g. ArkType function schemas)', async () => {
    // 模拟类似 ArkType 的 callable schema（自身是函数，同时挂载 '~standard' 属性）
    const callableSchema = Object.assign((input: unknown) => input, {
      '~standard': {
        version: 1 as const,
        vendor: 'arktype',
        validate: (value: unknown) => {
          if (typeof value === 'object' && value !== null && 'count' in value) {
            return { value: { count: Number((value as { count: unknown }).count) } };
          }
          return { issues: [{ message: 'expected count property' }] };
        },
      },
    });

    class CallableDto {
      static schema = callableSchema;
    }

    const pipe = new AppStandardSchemaValidationPipe();
    const result = await pipe.transform<unknown>(
      { count: '42' },
      {
        type: 'body',
        metatype: CallableDto,
      },
    );
    expect(result).toEqual({ count: 42 });
  });

  it('createGlobalValidationPipes: legacy mounts the class-validator pipe after the Standard Schema pipe', () => {
    const legacyPipes = createGlobalValidationPipes('legacy');
    expect(legacyPipes).toHaveLength(2);
    expect(legacyPipes[0]).toBeInstanceOf(AppStandardSchemaValidationPipe);
    expect(legacyPipes[1]).toBeInstanceOf(DualBoundaryValidationPipe);

    // standardSchemaValidationPipe: false -> 仅 legacy 管道
    const withoutStandardPipes = createGlobalValidationPipes('legacy', false);
    expect(withoutStandardPipes).toHaveLength(1);
    expect(withoutStandardPipes[0]).toBeInstanceOf(DualBoundaryValidationPipe);
  });

  it('createGlobalValidationPipes: standard-schema mounts only the Standard Schema pipe', () => {
    const pipes = createGlobalValidationPipes('standard-schema');
    expect(pipes).toHaveLength(1);
    expect(pipes[0]).toBeInstanceOf(AppStandardSchemaValidationPipe);
    expect(pipes.some((p) => p instanceof ValidationPipe)).toBe(false);

    // 两者皆停用 -> 空管道
    expect(createGlobalValidationPipes('standard-schema', false)).toHaveLength(0);

    // 自定义 exceptionFactory 选项给 AppStandardSchemaValidationPipe
    const customPipes = createGlobalValidationPipes('standard-schema', {
      exceptionFactory: () => new Error('custom-standard-schema-error'),
    });
    expect(customPipes).toHaveLength(1);
    expect(customPipes[0]).toBeInstanceOf(AppStandardSchemaValidationPipe);
  });

  // Nest 在 ValidationPipe 构造函数里才加载 class-validator / class-transformer
  // （loadValidator / loadTransformer）。standard-schema 模式不得走到这里 —— 这才是"启动不需要这两个包"。
  it('createGlobalValidationPipes: only legacy reaches the class-validator / class-transformer loaders', () => {
    const proto = ValidationPipe.prototype as unknown as {
      loadValidator: () => unknown;
      loadTransformer: () => unknown;
    };
    const loadValidator = spyOn(proto, 'loadValidator');
    const loadTransformer = spyOn(proto, 'loadTransformer');
    try {
      createGlobalValidationPipes('standard-schema');
      configureGrpcMicroserviceBoundary(
        new GrpcBoundaryRecorder() as unknown as Parameters<typeof configureGrpcMicroserviceBoundary>[0],
        new Reflector(),
        'TestProvider',
        'standard-schema',
      );
      expect(loadValidator).not.toHaveBeenCalled();
      expect(loadTransformer).not.toHaveBeenCalled();

      createGlobalValidationPipes('legacy');
      expect(loadValidator).toHaveBeenCalledTimes(1);
      expect(loadTransformer).toHaveBeenCalledTimes(1);
    } finally {
      loadValidator.mockRestore();
      loadTransformer.mockRestore();
    }
  });
});

// 分页输入（CursoredRequestInput 及子类）不携带 static schema：
// legacy 模式下无 schema 时 whitelist 管道会把它剥成空对象；
// standard-schema 模式下绑定 cursoredRequestSchema 时原样校验放行，开启 missingSchema: 'reject' 时拦截漏绑 schema 的自定义 DTO 类。
describe('validation mode, pagination inputs, and Default-Deny boundary', () => {
  const runPipes = async (
    pipes: ReturnType<typeof createGlobalValidationPipes>,
    value: unknown,
    schema?: unknown,
    metatype: any = CursoredRequestInput,
  ) => {
    let current = value;
    for (const pipe of pipes) {
      current = await pipe.transform(current, {
        type: 'body',
        metatype,
        ...(schema ? { schema: schema as any } : {}),
      });
    }
    return current;
  };

  it('legacy: the whitelist pipe strips pagination fields that have no class-validator decorator or schema', async () => {
    const out = await runPipes(createGlobalValidationPipes('legacy'), { first: 5, after: 'c1' });
    expect(out).not.toHaveProperty('after');
    expect(Object.keys(out as object)).not.toContain('first');
  });

  it('standard-schema: pagination fields reach the resolver untouched when cursoredRequestSchema is bound', async () => {
    const input = { first: 5, after: 'c1' };
    const out = await runPipes(
      createGlobalValidationPipes('standard-schema', { missingSchema: 'reject' }),
      input,
      cursoredRequestSchema,
    );
    expect(out).toEqual({ first: 5, after: 'c1' });
  });

  it('standard-schema: defaults to missingSchema=allow during migration so un-schemed endpoints do not break prior to cutover', async () => {
    const input = { first: 5, after: 'c1' };
    const out = await runPipes(createGlobalValidationPipes('standard-schema'), input);
    expect(out).toEqual({ first: 5, after: 'c1' });
  });

  it('standard-schema: missingSchema=reject blocks custom DTO classes missing a bound Standard Schema while allowing built-in Date/Buffer', async () => {
    const input = { first: 5, after: 'c1' };
    const strictPipes = createGlobalValidationPipes('standard-schema', { missingSchema: 'reject' });
    await expect(runPipes(strictPipes, input)).rejects.toThrow(
      "Inbound DTO 'CursoredRequestInput' is missing a bound Standard Schema in standard-schema validation mode",
    );

    const now = new Date();
    expect(await runPipes(strictPipes, now, undefined, Date)).toBe(now);
    const buf = Buffer.from('ok');
    expect(await runPipes(strictPipes, buf, undefined, Buffer)).toBe(buf);
  });
});

// 校验模式必填：漏填是编译错误，不是静默落回 legacy。tsc 把下面的 @ts-expect-error 当断言。
describe('validation mode is mandatory (type level)', () => {
  it('rejects BootstrapOptions and bootstrap() calls that omit validation', () => {
    // @ts-expect-error validation is required
    const omitted: BootstrapOptions = {};
    const ok: BootstrapOptions = { validation: 'standard-schema' };
    // @ts-expect-error unknown validation mode
    const bad: BootstrapOptions = { validation: 'class-validator' };
    // @ts-expect-error the options argument is required, so a bare bootstrap(AppModule) no longer compiles
    const bare = () => bootstrap(HybridLifecycleTestModule);
    // @ts-expect-error object-form class-validator options were removed together with `validationPipe`
    const removed: BootstrapOptions = { validation: 'legacy', validationPipe: false };
    void [omitted, ok, bad, bare, removed];
    expect(ok.validation).toBe('standard-schema');
  });
});

describe('createSchemaDto & DualBoundaryValidationPipe / AppStandardSchemaValidationPipe integration', () => {
  const FormASchema = z.object({
    username: z.string().min(2),
    age: z.coerce.number().int().positive(),
  });

  class FormADto extends createSchemaDto(FormASchema) {}

  it('AppStandardSchemaValidationPipe automatically resolves schema from createSchemaDto parent class', async () => {
    const pipe = new AppStandardSchemaValidationPipe();
    const result = await pipe.transform<unknown>(
      { username: 'daniel', age: '30' },
      { type: 'body', metatype: FormADto },
    );
    expect(result).toEqual({ username: 'daniel', age: 30 });
  });

  it('DualBoundaryValidationPipe skips class-validator when metatype is a createSchemaDto subclass', () => {
    const dualPipe = new DualBoundaryValidationPipe();
    // 形式 A DTO 應被判定為持有 Standard Schema，因此 toValidate 返回 false（跳過 class-validator）
    const shouldValidateWithClassValidator = dualPipe.toValidate({
      type: 'body',
      metatype: FormADto,
    });
    expect(shouldValidateWithClassValidator).toBe(false);
  });
});
