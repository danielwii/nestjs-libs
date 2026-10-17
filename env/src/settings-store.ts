import { z } from 'zod';

import type { ISysAppSettingClient } from './configure';

export const settingFormatSchema = z.enum(['string', 'number', 'boolean', 'json']);
export type SettingFormat = z.infer<typeof settingFormatSchema>;

export interface ManagedSetting {
  field: string;
  isScoped: boolean;
  format: SettingFormat;
  description?: string;
  defaultValue: unknown;
}

interface SettingMetadata {
  key: string;
  scope: string;
  defaultValue?: unknown;
  description?: string | null;
  createdBy?: string | null;
  deprecatedAt?: Date | null;
}

export function settingWriteScope(field: Pick<ManagedSetting, 'isScoped'>, projectScope?: string): string {
  return field.isScoped && projectScope ? projectScope : 'shared';
}

export function effectiveSetting<Row extends Pick<SettingMetadata, 'key' | 'scope'>>(
  field: Pick<ManagedSetting, 'field' | 'isScoped'>,
  rows: readonly Row[],
  projectScope?: string,
): Row | undefined {
  const shared = rows.find((row) => row.key === field.field && row.scope === 'shared');
  return field.isScoped && projectScope
    ? (rows.find((row) => row.key === field.field && row.scope === projectScope) ?? shared)
    : shared;
}

function storedDefault(value: unknown): string | null {
  return value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value);
}

type ScopedKeys = { scope: string; keys: string[]; createdBy?: string };

type MetadataUpdate = {
  field: ManagedSetting;
  scope: string;
  data: { defaultValue?: string; description?: string };
};

/** Shared ownership/default coordination; callers own validation and snapshot publication. */
export function planSettingMetadata(
  fields: readonly ManagedSetting[],
  rows: readonly SettingMetadata[],
  projectScope: string,
) {
  const deprecations: ScopedKeys[] = [];
  const restorations: ScopedKeys[] = [];
  for (const scope of ['shared', projectScope]) {
    const names = new Set(
      fields.filter((field) => settingWriteScope(field, projectScope) === scope).map((f) => f.field),
    );
    // A project owns its scope. Shared rows additionally require explicit creator ownership.
    const owned = rows.filter((row) => row.scope === scope && (scope !== 'shared' || row.createdBy === projectScope));
    const deprecated = owned.filter((row) => !names.has(row.key) && !row.deprecatedAt).map((row) => row.key);
    const restored = owned.filter((row) => names.has(row.key) && row.deprecatedAt).map((row) => row.key);
    const ownership = scope === 'shared' ? { createdBy: projectScope } : {};
    if (deprecated.length) deprecations.push({ scope, keys: deprecated, ...ownership });
    if (restored.length) restorations.push({ scope, keys: restored, ...ownership });
  }

  const creations: Array<{
    key: string;
    scope: string;
    value: null;
    defaultValue: string | null;
    format: SettingFormat;
    description?: string;
    createdBy: string;
  }> = [];
  const updates: MetadataUpdate[] = [];
  const conflicts: string[] = [];
  let skippedNotOwned = 0;
  for (const field of fields) {
    const scope = settingWriteScope(field, projectScope);
    const row = rows.find((r) => r.key === field.field && r.scope === scope);
    const defaultValue = storedDefault(field.defaultValue);
    if (!row) {
      creations.push({
        key: field.field,
        scope,
        value: null,
        defaultValue,
        format: field.format,
        description: field.description,
        createdBy: projectScope,
      });
      continue;
    }
    if (!field.isScoped && row.createdBy !== projectScope) {
      skippedNotOwned++;
      if (defaultValue !== null && row.defaultValue !== defaultValue) conflicts.push(field.field);
      continue;
    }
    const data: MetadataUpdate['data'] = {};
    if (defaultValue !== null && row.defaultValue !== defaultValue) data.defaultValue = defaultValue;
    if (field.description && row.description !== field.description) data.description = field.description;
    if (Object.keys(data).length) updates.push({ field, scope, data });
  }
  return { deprecations, restorations, creations, updates, conflicts, skippedNotOwned };
}

export type SettingMetadataPlan = ReturnType<typeof planSettingMetadata>;

/** Every write is scoped and idempotent. This port does not promise a transaction. */
export async function applySettingStructure(prisma: ISysAppSettingClient, plan: SettingMetadataPlan): Promise<void> {
  for (const { scope, keys, createdBy } of plan.deprecations) {
    await prisma.sysAppSetting.updateMany({
      where: { scope, key: { in: keys }, createdBy },
      data: { deprecatedAt: new Date() },
    });
  }
  for (const { scope, keys, createdBy } of plan.restorations) {
    await prisma.sysAppSetting.updateMany({
      where: { scope, key: { in: keys }, createdBy },
      data: { deprecatedAt: null },
    });
  }
  if (plan.creations.length) await prisma.sysAppSetting.createMany({ data: plan.creations, skipDuplicates: true });
}

export async function applySettingUpdate(
  prisma: ISysAppSettingClient,
  update: MetadataUpdate,
  projectScope: string,
): Promise<void> {
  const { field, scope, data } = update;
  const where = { scope_key: { scope, key: field.field } };
  const existing = await prisma.sysAppSetting.findUnique({ where });
  if (existing) {
    if (scope === 'shared' && existing.createdBy !== projectScope) return;
    await prisma.sysAppSetting.update({
      where: { ...where, ...(scope === 'shared' ? { createdBy: projectScope } : {}) },
      data,
    });
  } else {
    await prisma.sysAppSetting.create({
      data: {
        key: field.field,
        scope,
        value: null,
        defaultValue: storedDefault(field.defaultValue),
        format: field.format,
        description: field.description ?? null,
        createdBy: projectScope,
      },
    });
  }
}
