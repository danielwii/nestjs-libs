import {
  AppConfig,
  configAll,
  DatabaseUrl,
  GrpcPort,
  isProduction,
  isTest,
  LogLevel,
  NodeEnv,
  Port,
  RedisUrl,
  ServiceName,
  ShutdownDrainMs,
} from './config';

import { describe, expect, test } from 'bun:test';
import { ConfigProvider, Effect, Layer } from 'effect';

const withConfig = (env: Record<string, string>) =>
  Layer.setConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(env))));

const run = <A>(effect: Effect.Effect<A, any, never>) => Effect.runPromise(effect);

// ==================== NodeEnv ====================

describe('NodeEnv', () => {
  test('defaults to development', () =>
    run(NodeEnv.pipe(Effect.provide(withConfig({})))).then((v) => expect(v).toBe('development')));

  test('reads production', () =>
    run(NodeEnv.pipe(Effect.provide(withConfig({ NODE_ENV: 'production' })))).then((v) =>
      expect(v).toBe('production'),
    ));

  test('rejects invalid value', () =>
    run(Effect.either(NodeEnv).pipe(Effect.provide(withConfig({ NODE_ENV: 'invalid' })))).then((r) =>
      expect(r._tag).toBe('Left'),
    ));
});

// ==================== Port ====================

describe('Port', () => {
  test('defaults to 3100', () => run(Port.pipe(Effect.provide(withConfig({})))).then((v) => expect(v).toBe(3100)));

  test('reads custom port', () =>
    run(Port.pipe(Effect.provide(withConfig({ PORT: '8080' })))).then((v) => expect(v).toBe(8080)));

  test('rejects 0', () =>
    run(Effect.either(Port).pipe(Effect.provide(withConfig({ PORT: '0' })))).then((r) => expect(r._tag).toBe('Left')));

  test('rejects 99999', () =>
    run(Effect.either(Port).pipe(Effect.provide(withConfig({ PORT: '99999' })))).then((r) =>
      expect(r._tag).toBe('Left'),
    ));
});

// ==================== GrpcPort ====================

describe('GrpcPort', () => {
  test('defaults to 50051', () =>
    run(GrpcPort.pipe(Effect.provide(withConfig({})))).then((v) => expect(v).toBe(50051)));
});

// ==================== LogLevel ====================

describe('LogLevel', () => {
  test('defaults to debug', () =>
    run(LogLevel.pipe(Effect.provide(withConfig({})))).then((v) => expect(v).toBe('debug')));

  test('accepts error', () =>
    run(LogLevel.pipe(Effect.provide(withConfig({ LOG_LEVEL: 'error' })))).then((v) => expect(v).toBe('error')));
});

// ==================== ServiceName ====================

describe('ServiceName', () => {
  test('reads APP_NAME', () =>
    run(ServiceName.pipe(Effect.provide(withConfig({ APP_NAME: 'my-svc' })))).then((v) => expect(v).toBe('my-svc')));

  test('falls back to SERVICE_NAME', () =>
    run(ServiceName.pipe(Effect.provide(withConfig({ SERVICE_NAME: 'fallback-svc' })))).then((v) =>
      expect(v).toBe('fallback-svc'),
    ));

  test('defaults to app', () =>
    run(ServiceName.pipe(Effect.provide(withConfig({})))).then((v) => expect(v).toBe('app')));
});

// ==================== DatabaseUrl ====================

describe('DatabaseUrl', () => {
  test('reads valid url', () =>
    run(DatabaseUrl.pipe(Effect.provide(withConfig({ DATABASE_URL: 'postgres://localhost/db' })))).then((v) =>
      expect(v).toBe('postgres://localhost/db'),
    ));

  test('fails when missing', () =>
    run(Effect.either(DatabaseUrl).pipe(Effect.provide(withConfig({})))).then((r) => expect(r._tag).toBe('Left')));

  test('fails when empty', () =>
    run(Effect.either(DatabaseUrl).pipe(Effect.provide(withConfig({ DATABASE_URL: '' })))).then((r) =>
      expect(r._tag).toBe('Left'),
    ));
});

// ==================== RedisUrl ====================

describe('RedisUrl', () => {
  test('defaults to redis://localhost:6379', () =>
    run(RedisUrl.pipe(Effect.provide(withConfig({})))).then((v) => expect(v).toBe('redis://localhost:6379')));
});

// ==================== ShutdownDrainMs ====================

describe('ShutdownDrainMs', () => {
  test('defaults to 5000', () =>
    run(ShutdownDrainMs.pipe(Effect.provide(withConfig({})))).then((v) => expect(v).toBe(5000)));

  test('rejects 0', () =>
    run(Effect.either(ShutdownDrainMs).pipe(Effect.provide(withConfig({ SHUTDOWN_DRAIN_MS: '0' })))).then((r) =>
      expect(r._tag).toBe('Left'),
    ));
});

// ==================== AppConfig ====================

describe('AppConfig', () => {
  test('reads all fields with defaults', () =>
    run(AppConfig.pipe(Effect.provide(withConfig({})))).then((cfg) => {
      expect(cfg.nodeEnv).toBe('development');
      expect(cfg.port).toBe(3100);
      expect(cfg.logLevel).toBe('debug');
      expect(cfg.serviceName).toBe('app');
    }));

  test('reads custom values', () =>
    run(
      AppConfig.pipe(
        Effect.provide(withConfig({ NODE_ENV: 'production', PORT: '9000', LOG_LEVEL: 'error', APP_NAME: 'test-svc' })),
      ),
    ).then((cfg) => {
      expect(cfg.nodeEnv).toBe('production');
      expect(cfg.port).toBe(9000);
      expect(cfg.logLevel).toBe('error');
      expect(cfg.serviceName).toBe('test-svc');
    }));
});

// ==================== isProduction / isTest ====================

describe('isProduction', () => {
  test('true for production', () =>
    run(isProduction.pipe(Effect.provide(withConfig({ NODE_ENV: 'production' })))).then((v) => expect(v).toBe(true)));

  test('false for development', () =>
    run(isProduction.pipe(Effect.provide(withConfig({})))).then((v) => expect(v).toBe(false)));
});

describe('isTest', () => {
  test('true for test', () =>
    run(isTest.pipe(Effect.provide(withConfig({ NODE_ENV: 'test' })))).then((v) => expect(v).toBe(true)));

  test('false for development', () =>
    run(isTest.pipe(Effect.provide(withConfig({})))).then((v) => expect(v).toBe(false)));
});

// ==================== configAll ====================

describe('configAll', () => {
  test('combines multiple configs', () =>
    run(
      configAll({ port: Port, dbUrl: DatabaseUrl }).pipe(
        Effect.provide(withConfig({ DATABASE_URL: 'postgres://localhost/db' })),
      ),
    ).then((cfg) => {
      expect(cfg.port).toBe(3100);
      expect(cfg.dbUrl).toBe('postgres://localhost/db');
    }));

  test('returns empty object for empty input', () =>
    run(configAll({}).pipe(Effect.provide(withConfig({})))).then((cfg) => expect(cfg).toEqual({})));
});
