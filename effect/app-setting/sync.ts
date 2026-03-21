import { f } from '@app/utils/logging';

/**
 * syncFromDB — 核心同步逻辑
 *
 * 完全对标 libs/env/src/configure.ts 的 AppConfigure.syncFromDB
 *
 * 读方向（所有实例执行）：
 * 1. prisma.sysAppSetting.findMany() 读取相关 scope 的行
 * 2. 遍历已注册 fields：scoped 字段优先读项目行，fallback 到 shared
 * 3. Schema.decodeUnknownSync 验证 → Ref.update 覆盖运行时值
 *
 * 写方向（APP_CONFIG_SYNC_WRITE_ENABLED=true 时）：
 * 1. 代码有但 DB 没有 → createMany（shared 或 project scope）
 * 2. DB 有但代码删除 → updateMany 设 deprecatedAt（按 scope 隔离）
 * 3. 已废弃但代码重新添加 → 清除 deprecatedAt
 * 4. defaultValue 或 description 变更 → update（复合键 scope_key）
 */

import { Effect, Ref, Schema } from 'effect';

import type { DatabaseFieldDef } from './field';

// ==================== Prisma 接口（解耦） ====================

/** 对应 NestJS 版 ISysAppSettingRecord */
export interface SysAppSettingRecord {
  readonly key: string;
  readonly scope: string;
  readonly value: string | null;
  readonly defaultValue: string | null;
  readonly format: string;
  readonly description: string | null;
  readonly deprecatedAt: Date | null;
}

export interface AppSettingClient {
  readonly sysAppSetting: {
    findMany(args?: { where?: { scope?: { in: ReadonlyArray<string> } } }): Promise<ReadonlyArray<SysAppSettingRecord>>;
    createMany(args: {
      data: ReadonlyArray<{
        key: string;
        scope: string;
        value: string | null;
        defaultValue: string | null;
        format: string;
        description: string | null;
      }>;
      skipDuplicates?: boolean;
    }): Promise<{ count: number }>;
    updateMany(args: {
      where: { key: { in: ReadonlyArray<string> }; scope?: string };
      data: { deprecatedAt: Date | null };
    }): Promise<{ count: number }>;
    findUnique(args: { where: { scope_key: { scope: string; key: string } } }): Promise<SysAppSettingRecord | null>;
    create(args: {
      data: {
        key: string;
        scope: string;
        value: string | null;
        defaultValue: string | null;
        format: string;
        description: string | null;
      };
    }): Promise<SysAppSettingRecord>;
    update(args: {
      where: { scope_key: { scope: string; key: string } };
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

/** 将 DB 原始值按 format 解析 — JSON.parse 失败返回 null 而非 throw */
const parseDbValue = (value: string, format: string): unknown => {
  if (format === 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null; // 无效 JSON，后续 validateDbValue 会跳过
  }
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

const SHARED = 'shared';

// ==================== 核心同步 ====================

export const syncFromDB = (
  prisma: AppSettingClient,
  fields: Record<string, DatabaseFieldDef>,
  ref: Ref.Ref<Record<string, unknown>>,
  syncWriteEnabled: boolean,
  options?: { scope?: string },
) =>
  Effect.gen(function* () {
    const projectScope = options?.scope;
    const syncMode = syncWriteEnabled ? 'read-write' : 'read-only';
    const fieldEntries = Object.entries(fields);
    const managedFieldNames = fieldEntries.map(([k]) => k).sort();

    /** 决定字段的写入 scope */
    const resolveWriteScope = (isScoped: boolean | undefined): string => {
      if (isScoped && projectScope) return projectScope;
      if (isScoped && !projectScope) {
        // scoped 字段但未配置 project scope → 降级到 shared
        Effect.logWarning(f`#syncFromDB scoped field used without project scope, falling back to "${SHARED}"`);
      }
      return SHARED;
    };

    const sharedFields = fieldEntries.filter(([, def]) => !def.scoped);
    const scopedFields = fieldEntries.filter(([, def]) => def.scoped);

    yield* Effect.logDebug(`#syncFromDB... reload app settings from db.`);
    yield* Effect.logDebug(f`#syncFromDB mode=${syncMode} scope=${projectScope ?? '(none)'}`);
    yield* Effect.logDebug(
      f`#syncFromDB managed keys (${managedFieldNames.length}): ${managedFieldNames.join(', ') || '(none)'}`,
    );

    // 拉取相关 scope 的行
    const scopesToRead = projectScope ? [SHARED, projectScope] : [SHARED];
    const rawSettings = yield* Effect.tryPromise(() =>
      prisma.sysAppSetting.findMany({ where: { scope: { in: scopesToRead } } }),
    );
    const appSettings = rawSettings.map((s) => ({
      ...s,
      value: s.value != null ? parseDbValue(s.value, s.format) : null,
    }));

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
      // Orphan 检测：按 scope 隔离

      // 1. shared scope orphans
      const sharedFieldNames = new Set(sharedFields.map(([k]) => k));
      const sharedRows = appSettings.filter((s) => s.scope === SHARED);
      const sharedOrphans = sharedRows.filter((s) => !sharedFieldNames.has(s.key) && !s.deprecatedAt);
      if (sharedOrphans.length > 0) {
        stats.metadataDeprecatedMarked += sharedOrphans.length;
        yield* Effect.logInfo(
          f`#syncFromDB 标记 ${sharedOrphans.length} 个废弃配置 (shared): ${sharedOrphans.map((s) => s.key).join(', ')}`,
        );
        yield* Effect.tryPromise(() =>
          prisma.sysAppSetting.updateMany({
            where: { key: { in: sharedOrphans.map((s) => s.key) }, scope: SHARED },
            data: { deprecatedAt: new Date() },
          }),
        );
      }

      // 2. project scope orphans
      if (projectScope) {
        const scopedFieldNames = new Set(scopedFields.map(([k]) => k));
        const projectRows = appSettings.filter((s) => s.scope === projectScope);
        const projectOrphans = projectRows.filter((s) => !scopedFieldNames.has(s.key) && !s.deprecatedAt);
        if (projectOrphans.length > 0) {
          stats.metadataDeprecatedMarked += projectOrphans.length;
          yield* Effect.logInfo(
            f`#syncFromDB 标记 ${projectOrphans.length} 个废弃配置 (${projectScope}): ${projectOrphans.map((s) => s.key).join(', ')}`,
          );
          yield* Effect.tryPromise(() =>
            prisma.sysAppSetting.updateMany({
              where: { key: { in: projectOrphans.map((s) => s.key) }, scope: projectScope },
              data: { deprecatedAt: new Date() },
            }),
          );
        }
      }

      // 恢复：代码重新添加
      const allFieldNames = new Set(fieldEntries.map(([k]) => k));
      const restoredSettings = appSettings.filter((s) => allFieldNames.has(s.key) && Boolean(s.deprecatedAt));
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
      const nonExistsFields = fieldEntries.filter(([key, def]) => {
        const writeScope = resolveWriteScope(def.scoped);
        return !appSettings.some((s) => s.key === key && s.scope === writeScope);
      });
      if (nonExistsFields.length > 0) {
        stats.metadataCreated += nonExistsFields.length;
        yield* Effect.logInfo(f`#syncFromDB 创建 ${nonExistsFields.length} 个新配置字段...`);
        const createData = nonExistsFields.map(([key, def]) => {
          const defaultVal = serializeValue(def.defaultValue);
          const scope = resolveWriteScope(def.scoped);
          return {
            key,
            scope,
            value: null,
            defaultValue: defaultVal,
            format: def.format as string,
            description: def.description ?? null,
          };
        });
        for (const d of createData) {
          yield* Effect.logInfo(f`#syncFromDB 创建配置: ${d.key} scope=${d.scope} (默认值: ${d.defaultValue})`);
        }
        yield* Effect.tryPromise(() => prisma.sysAppSetting.createMany({ data: createData, skipDuplicates: true }));
      }
    }

    // ==================== 读方向 ====================
    const currentValues = yield* Ref.get(ref);
    const updatedValues = { ...currentValues };

    for (const [fieldName, fieldDef] of fieldEntries) {
      const writeScope = resolveWriteScope(fieldDef.scoped);

      // scoped 字段优先读项目行，fallback 到 shared
      const scopedRow = projectScope
        ? appSettings.find((s) => s.key === fieldName && s.scope === projectScope)
        : undefined;
      const sharedRow = appSettings.find((s) => s.key === fieldName && s.scope === SHARED);
      const effectiveRow = fieldDef.scoped ? (scopedRow ?? sharedRow) : sharedRow;

      if (!effectiveRow) {
        stats.runtimeMissingDBValue += 1;
        continue;
      }

      // 用 DB value 覆盖运行时
      if (effectiveRow.value != null) {
        const validation = validateDbValue(fieldName, effectiveRow.value, fieldDef);
        if (!validation.ok) {
          stats.runtimeInvalidDBValue += 1;
          yield* Effect.logWarning(
            f`#syncFromDB skip invalid DB value: field=${fieldName} value=${JSON.stringify(effectiveRow.value)} reason=${validation.reason}`,
          );
        } else if (!isEqual(currentValues[fieldName], validation.value)) {
          stats.runtimeOverridesApplied += 1;
          yield* Effect.logInfo(
            f`#syncFromDB 配置覆盖: ${fieldName} = "${String(currentValues[fieldName])}" -> "${String(validation.value)}" (scope=${effectiveRow.scope})`,
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

      const metaRow = appSettings.find((s) => s.key === fieldName && s.scope === writeScope);
      if (!metaRow) continue;

      const updates: { defaultValue?: string; description?: string } = {};
      const valueToStore = serializeValue(fieldDef.defaultValue);

      if (metaRow.defaultValue !== valueToStore && valueToStore !== null) {
        updates.defaultValue = valueToStore;
      }
      if (fieldDef.description && fieldDef.description !== metaRow.description) {
        updates.description = fieldDef.description;
      }

      if (Object.keys(updates).length > 0) {
        stats.metadataUpdated += 1;
        yield* Effect.logInfo(f`#syncFromDB 更新元数据: ${fieldName} scope=${writeScope} ${JSON.stringify(updates)}`);
        yield* Effect.tryPromise(() =>
          prisma.sysAppSetting.findUnique({ where: { scope_key: { scope: writeScope, key: fieldName } } }),
        ).pipe(
          Effect.flatMap((existing) =>
            existing
              ? Effect.tryPromise(() =>
                  prisma.sysAppSetting.update({
                    where: { scope_key: { scope: writeScope, key: fieldName } },
                    data: updates,
                  }),
                )
              : Effect.tryPromise(() =>
                  prisma.sysAppSetting.create({
                    data: {
                      key: fieldName,
                      scope: writeScope,
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

    // 统计日志
    yield* Effect.logInfo(
      f`#syncFromDB summary mode=${syncMode} scope=${projectScope ?? SHARED} managed=${fieldEntries.length} dbRows=${appSettings.length} applied=${stats.runtimeOverridesApplied} unchanged=${stats.runtimeOverridesUnchanged} missingDbValue=${stats.runtimeMissingDBValue} invalidDbValue=${stats.runtimeInvalidDBValue} deprecated=${stats.metadataDeprecatedMarked} restored=${stats.metadataRestored} created=${stats.metadataCreated} metadataUpdated=${stats.metadataUpdated} metadataUpdateFailed=${stats.metadataUpdateFailed}`,
    );
  });
