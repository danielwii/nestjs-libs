/**
 * AppSettings Tag（Port）
 *
 * 与 NestJS 版对比：
 * - NestJS: AppEnvs.FIELD 全局读（可变全局对象）
 * - Effect: yield* AppSettings → getField('FIELD')（Ref 管理、类型安全）
 */

import type { Effect } from 'effect';
import { Context } from 'effect';

// ==================== Service Interface ====================

export interface AppSettingsService {
  /** 获取所有当前设置值 */
  readonly get: () => Effect.Effect<Readonly<Record<string, unknown>>>;
  /** 获取单个字段值 */
  readonly getField: <T = unknown>(key: string) => Effect.Effect<T>;
  /** 手动触发同步 */
  readonly sync: () => Effect.Effect<void>;
}

// ==================== Tag (Port) ====================

export class AppSettings extends Context.Tag('AppSettings')<AppSettings, AppSettingsService>() {}
