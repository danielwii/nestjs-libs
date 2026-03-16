import { f } from '@app/utils/logging';
/**
 * syncFromDB — 核心同步逻辑
 *
 * 完全对标 libs/env/src/configure.ts 的 AppConfigure.syncFromDB
 *
 * 读方向（所有实例执行）：
 * 1. prisma.sysAppSetting.findMany() 读取全部
 * 2. 遍历已注册 fields：DB 有 value → Schema.decodeUnknownSync 验证
 * 3. 验证通过且值变化 → Ref.update 覆盖运行时值
 * 4. 验证失败 → 跳过 + logWarning
 *
 * 写方向（APP_CONFIG_SYNC_WRITE_ENABLED=true 时）：
 * 1. 代码有但 DB 没有 → createMany
 * 2. DB 有但代码删除 → updateMany 设 deprecatedAt
 * 3. 已废弃但代码重新添加 → 清除 deprecatedAt
 * 4. defaultValue 或 description 变更 → update
 */

import { Effect, Ref, Schema } from 'effect';

import type { DatabaseFieldDef } from './field';

// ==================== Prisma 接口（解耦） ====================

/** 对应 NestJS 版 ISysAppSettingClient */
export interface SysAppSettingRecord {
  readonly key: string;
  readonly value: string | null;
  readonly defaultValue: string | null;
  readonly format: string;
  readonly description: string | null;
  readonly deprecatedAt: Date | null;
}

export interface AppSettingClient {
  readonly sysAppSetting: {
    findMany(): Promise<ReadonlyArray<SysAppSettingRecord>>;
    createMany(args: {
      data: ReadonlyArray<{
        key: string;
        value: string | null;
        defaultValue: string | null;
        format: string;
        description: string | null;
      }>;
      skipDuplicates?: boolean;
    }): Promise<{ count: number }>;
    updateMany(args: {
      where: { key: { in: ReadonlyArray<string> } };
      data: { deprecatedAt: Date | null };
    }): Promise<{ count: number }>;
    findUnique(args: { where: { key: string } }): Promise<SysAppSettingRecord | null>;
    create(args: {
      data: {
        key: string;
        value: string | null;
        defaultValue: string | null;
        format: string;
        description: string | null;
      };
    }): Promise<SysAppSettingRecord>;
    update(args: {
      where: { key: string };
      data: { defaultValue?: string; description?: string };
    }): Promise<SysAppSettingRecord>;
  };
}

// ==================== 同步统计 ====================

interface SyncStats {
  runtimeOverridesApplied: number;
  runtimeOverridesUnchanged: number;
  runtimeMissingDBValue: number;
  runtimeInvalidDBValue: number;
  metadataDeprecatedMarked: number;
  metadataRestored: number;
  metadataCreated: number;
  metadataUpdated: number;
  metadataUpdateFailed: number;
}

// ==================== 辅助函数 ====================

/** 将值序列化为 DB 存储格式 */
const serializeValue = (value: unknown): string | null => {
  if (value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
};

/** 将 DB 原始值按 format 解析 */
const parseDbValue = (value: string, format: string): unknown => {
  if (format === 'string') return value;
  return JSON.parse(value);
};

/** 验证 DB 值是否合法 */
const validateDbValue = <A>(
  _field: string,
  rawValue: unknown,
  fieldDef: DatabaseFieldDef<A>,
): { readonly ok: true; readonly value: A } | { readonly ok: false; readonly reason: string } => {
  try {
    const value = Schema.decodeUnknownSync(fieldDef.schema)(rawValue);
    return { ok: true, value };
  } catch (error: unknown) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

/** 浅比较两个值 */
const isEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object' && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
};

// ==================== 核心同步 ====================

export const syncFromDB = (
  prisma: AppSettingClient,
  fields: Record<string, DatabaseFieldDef>,
  ref: Ref.Ref<Record<string, unknown>>,
  syncWriteEnabled: boolean,
) =>
  Effect.gen(function* () {
    const syncMode = syncWriteEnabled ? 'read-write' : 'read-only';
    const fieldEntries = Object.entries(fields);
    const managedFieldNames = fieldEntries.map(([k]) => k).sort();

    yield* Effect.logDebug(`#syncFromDB... reload app settings from db.`);
    yield* Effect.logDebug(
      syncWriteEnabled
        ? '#syncFromDB mode=read-write, DB values + metadata sync are enabled'
        : '#syncFromDB mode=read-only, DB values will be applied to runtime, metadata writes are disabled',
    );
    yield* Effect.logDebug(
      f`#syncFromDB managed keys (${managedFieldNames.length}): ${managedFieldNames.join(', ') || '(none)'}`,
    );

    // 读取 DB 全量数据
    const rawSettings = yield* Effect.tryPromise(() => prisma.sysAppSetting.findMany());
    const appSettings = rawSettings.map((s) => ({
      ...s,
      value: s.value != null ? parseDbValue(s.value, s.format) : null,
    }));
    const fieldNamesInDB = new Set(appSettings.map((s) => s.key));

    const stats: SyncStats = {
      runtimeOverridesApplied: 0,
      runtimeOverridesUnchanged: 0,
      runtimeMissingDBValue: 0,
      runtimeInvalidDBValue: 0,
      metadataDeprecatedMarked: 0,
      metadataRestored: 0,
      metadataCreated: 0,
      metadataUpdated: 0,
      metadataUpdateFailed: 0,
    };

    // ==================== 写方向 ====================
    if (syncWriteEnabled) {
      const fieldNamesInCode = new Set(fieldEntries.map(([k]) => k));

      // 软删除：DB 有但代码删除
      const orphanSettings = appSettings.filter((s) => !fieldNamesInCode.has(s.key) && !s.deprecatedAt);
      if (orphanSettings.length > 0) {
        stats.metadataDeprecatedMarked += orphanSettings.length;
        yield* Effect.logInfo(
          f`#syncFromDB 标记 ${orphanSettings.length} 个废弃配置: ${orphanSettings.map((s) => s.key).join(', ')}`,
        );
        yield* Effect.tryPromise(() =>
          prisma.sysAppSetting.updateMany({
            where: { key: { in: orphanSettings.map((s) => s.key) } },
            data: { deprecatedAt: new Date() },
          }),
        );
      }

      // 恢复：代码重新添加
      const restoredSettings = appSettings.filter((s) => fieldNamesInCode.has(s.key) && Boolean(s.deprecatedAt));
      if (restoredSettings.length > 0) {
        stats.metadataRestored += restoredSettings.length;
        yield* Effect.logInfo(
          f`#syncFromDB 恢复 ${restoredSettings.length} 个配置: ${restoredSettings.map((s) => s.key).join(', ')}`,
        );
        yield* Effect.tryPromise(() =>
          prisma.sysAppSetting.updateMany({
            where: { key: { in: restoredSettings.map((s) => s.key) } },
            data: { deprecatedAt: null },
          }),
        );
      }

      // 创建：代码有但 DB 没有
      const nonExistsFields = fieldEntries.filter(([k]) => !fieldNamesInDB.has(k));
      if (nonExistsFields.length > 0) {
        stats.metadataCreated += nonExistsFields.length;
        yield* Effect.logInfo(f`#syncFromDB 创建 ${nonExistsFields.length} 个新配置字段...`);
        const createData = nonExistsFields.map(([key, def]) => {
          const defaultVal = serializeValue(def.defaultValue);
          return {
            key,
            value: null,
            defaultValue: defaultVal,
            format: def.format as string,
            description: def.description ?? null,
          };
        });
        for (const d of createData) {
          yield* Effect.logInfo(f`#syncFromDB 创建配置: ${d.key} (默认值: ${d.defaultValue})`);
        }
        yield* Effect.tryPromise(() => prisma.sysAppSetting.createMany({ data: createData, skipDuplicates: true }));
      }
    }

    // ==================== 读方向 ====================
    const currentValues = yield* Ref.get(ref);
    const updatedValues = { ...currentValues };

    for (const [fieldName, fieldDef] of fieldEntries) {
      const appSetting = appSettings.find((s) => s.key === fieldName);
      if (!appSetting) {
        continue; // DB 中不存在，保持默认值
      }

      // 用 DB value 覆盖运行时
      if (appSetting.value != null) {
        const validation = validateDbValue(fieldName, appSetting.value, fieldDef);
        if (!validation.ok) {
          stats.runtimeInvalidDBValue += 1;
          yield* Effect.logWarning(
            f`#syncFromDB skip invalid DB value: field=${fieldName} value=${JSON.stringify(appSetting.value)} reason=${validation.reason}`,
          );
        } else if (!isEqual(currentValues[fieldName], validation.value)) {
          stats.runtimeOverridesApplied += 1;
          yield* Effect.logInfo(
            f`#syncFromDB 配置覆盖: ${fieldName} = "${String(currentValues[fieldName])}" -> "${String(validation.value)}"`,
          );
          updatedValues[fieldName] = validation.value;
        } else {
          stats.runtimeOverridesUnchanged += 1;
        }
      } else {
        stats.runtimeMissingDBValue += 1;
      }

      // 元数据更新（写方向）
      if (!syncWriteEnabled) continue;

      const updates: { defaultValue?: string; description?: string } = {};
      const valueToStore = serializeValue(fieldDef.defaultValue);

      if (appSetting.defaultValue !== valueToStore && valueToStore !== null) {
        updates.defaultValue = valueToStore;
      }
      if (fieldDef.description && fieldDef.description !== appSetting.description) {
        updates.description = fieldDef.description;
      }

      if (Object.keys(updates).length > 0) {
        stats.metadataUpdated += 1;
        yield* Effect.logInfo(f`#syncFromDB 更新元数据: ${fieldName} ${JSON.stringify(updates)}`);
        yield* Effect.tryPromise(() => prisma.sysAppSetting.findUnique({ where: { key: fieldName } })).pipe(
          Effect.flatMap((existing) =>
            existing
              ? Effect.tryPromise(() => prisma.sysAppSetting.update({ where: { key: fieldName }, data: updates }))
              : Effect.tryPromise(() =>
                  prisma.sysAppSetting.create({
                    data: {
                      key: fieldName,
                      value: null,
                      defaultValue: updates.defaultValue ?? null,
                      format: fieldDef.format as string,
                      description: updates.description ?? null,
                    },
                  }),
                ),
          ),
          Effect.catchAll((error) => {
            stats.metadataUpdateFailed += 1;
            return Effect.logError(
              f`#syncFromDB failed to update metadata for ${fieldName}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }),
        );
      }
    }

    // 批量更新 Ref
    if (stats.runtimeOverridesApplied > 0) {
      yield* Ref.set(ref, updatedValues);
    }

    // 统计日志（完全对齐 NestJS 版 9 项指标）
    yield* Effect.logInfo(
      f`#syncFromDB summary mode=${syncMode} managed=${fieldEntries.length} dbRows=${appSettings.length} applied=${stats.runtimeOverridesApplied} unchanged=${stats.runtimeOverridesUnchanged} missingDbValue=${stats.runtimeMissingDBValue} invalidDbValue=${stats.runtimeInvalidDBValue} deprecated=${stats.metadataDeprecatedMarked} restored=${stats.metadataRestored} created=${stats.metadataCreated} metadataUpdated=${stats.metadataUpdated} metadataUpdateFailed=${stats.metadataUpdateFailed}`,
    );
  });
