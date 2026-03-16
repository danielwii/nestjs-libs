import { f } from '@app/utils/logging';
/**
 * makeAppSettingsLive — AppSettings Layer 工厂
 *
 * 与 NestJS 版对比：
 * - NestJS: @Cron(EVERY_MINUTE) + AppConfigure.sync(prisma)
 * - Effect: Effect.schedule(sync, Schedule.fixed("1 minute"))（声明式、可组合）
 *
 * 生命周期：
 * 1. 初始值 = fields 声明的 defaultValue
 * 2. 首次 sync = 启动时立即同步
 * 3. 定时 sync = 生产环境每分钟（forkScoped，随 Layer 销毁自动取消）
 */

import { NodeEnv } from '../core/config';
import { AppSettings } from './service';
import { syncFromDB } from './sync';

import { Config, Effect, Layer, Ref, Schedule, Schema } from 'effect';

import type { DatabaseFieldDef } from './field';
import type { AppSettingsService } from './service';
import type { AppSettingClient } from './sync';

// ==================== Config ====================

const SyncWriteEnabled = Schema.Config(
  'APP_CONFIG_SYNC_WRITE_ENABLED',
  Schema.transform(Schema.String, Schema.Boolean, {
    decode: (s) => s === 'true' || s === '1',
    encode: (b) => (b ? 'true' : 'false'),
  }),
).pipe(Config.withDefault(false));

// ==================== Layer Factory ====================

/**
 * 构建 AppSettings Layer
 *
 * @param fields - DatabaseField 定义（替代 @DatabaseField 装饰器）
 *
 * @example
 * ```ts
 * const fields = {
 *   SYNC_INTERVAL_MS: dbNumber(60000, '同步间隔'),
 *   FEATURE_FLAG_X: dbBoolean(false, '功能开关'),
 * };
 *
 * const AppSettingsLive = makeAppSettingsLive(fields);
 * // 提供给 Layer 组合
 * ```
 */
export const makeAppSettingsLive = (fields: Record<string, DatabaseFieldDef>, prismaClient: AppSettingClient) =>
  Layer.scoped(
    AppSettings,
    Effect.gen(function* () {
      const syncWriteEnabled = yield* SyncWriteEnabled;
      const nodeEnv = yield* NodeEnv;

      // 初始值 = env defaults
      const initialValues: Record<string, unknown> = {};
      for (const [k, def] of Object.entries(fields)) {
        initialValues[k] = def.defaultValue;
      }
      const ref = yield* Ref.make(initialValues);

      // sync Effect（内部 tryPromise 可能抛 UnknownException）
      const doSync = syncFromDB(prismaClient, fields, ref, syncWriteEnabled);

      // 首次 sync（fail fast — 启动时 DB 不可达直接崩溃）
      yield* doSync;

      // 安全 sync（catch + log，用于定时和手动触发）
      const safeSync = doSync.pipe(Effect.catchAll((e) => Effect.logError(f`AppSettings sync failed: ${String(e)}`)));

      // 定时 sync（生产环境每分钟）
      if (nodeEnv === 'production') {
        yield* Effect.forkScoped(safeSync.pipe(Effect.schedule(Schedule.fixed('1 minute'))));
      }

      return {
        get: () => Ref.get(ref),
        getField: <T>(key: string) => Ref.get(ref).pipe(Effect.map((s) => s[key] as T)),
        sync: () => safeSync,
      } satisfies AppSettingsService;
    }),
  );
