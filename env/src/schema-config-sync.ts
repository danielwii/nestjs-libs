import { Oops } from '@app/nest/exceptions/oops';
import { getAppLogger } from '@app/utils/app-logger';

import {
  applySettingStructure,
  applySettingUpdate,
  effectiveSetting,
  planSettingMetadata,
  settingFormatSchema,
} from './settings-store';

import { isDeepStrictEqual } from 'node:util';

import { err, ok } from 'neverthrow';

import type { DatabaseFieldSpec, ISysAppSettingClient } from './configure';
import type { ManagedSetting } from './settings-store';
import type { OopsError } from '@app/nest/exceptions/oops-error';
import type { Result } from 'neverthrow';
import type { z } from 'zod';

export interface ConfigSyncStats {
  changedKeys: readonly string[];
}
export type SchemaConfigSync = (client: ISysAppSettingClient) => Promise<Result<ConfigSyncStats, OopsError>>;

/** The raw startup baseline is reparsed, never previously transformed runtime values. */
export function createSchemaConfigSync<Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>,
  config: {
    vars: z.infer<z.ZodObject<Shape>>;
    rawBaseline: Record<string, string | undefined>;
    databaseFields: readonly { key: string; spec: DatabaseFieldSpec }[];
    envSourceMap: Map<string, string>;
    scope?: string;
  },
): SchemaConfigSync {
  const baseline = new Map(Object.entries(structuredClone(config.vars)));
  const active: Record<string, unknown> = config.vars;
  const baselineSources = new Map(config.envSourceMap);
  const logger = getAppLogger('SchemaConfig');
  let pending: ReturnType<SchemaConfigSync> | undefined;

  const syncOnce: SchemaConfigSync = async (client) => {
    let phase: 'definition' | 'read' | 'validation' | 'metadata' = 'definition';
    try {
      const scope = config.scope ?? config.rawBaseline.APP_NAME;
      if (!scope || scope.trim() !== scope || scope === 'shared') {
        return err(Oops.Panic.Config('Configuration sync requires a non-empty project scope other than shared'));
      }
      const fields: ManagedSetting[] = [];
      for (const { key, spec } of config.databaseFields) {
        const format = settingFormatSchema.safeParse(spec.format);
        if (!format.success)
          return err(Oops.Panic.Config(`Configuration storage format is missing or invalid: ${key}`));
        fields.push({
          field: key,
          format: format.data,
          isScoped: spec.scoped,
          description: spec.description,
          defaultValue: baseline.get(key),
        });
      }

      phase = 'read';
      const rows = await client.sysAppSetting.findMany({ where: { scope: { in: ['shared', scope] } } });
      phase = 'validation';
      const candidate: Record<string, unknown> = { ...config.rawBaseline };
      const sources = new Map(baselineSources);
      for (const field of fields) {
        const row = effectiveSetting(field, rows, scope);
        if (!row) continue;
        if (row.format !== field.format) {
          return err(Oops.Validation(`Configuration storage format does not match its declaration: ${field.field}`));
        }
        if (row.value === null) continue;
        let value: unknown = row.value;
        if (field.format !== 'string') {
          if (row.value.trim() === '') continue;
          try {
            value = JSON.parse(row.value);
          } catch {
            return err(Oops.Validation(`Configuration value is not valid JSON: ${field.field}`));
          }
          if (value === null && field.format !== 'json') continue;
        }
        candidate[field.field] = value;
        sources.set(field.field, `database:${row.scope}`);
      }
      const parsed = schema.safeParse(candidate);
      if (!parsed.success) {
        const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(configuration)'))];
        return err(Oops.Validation(`Configuration snapshot rejected: ${fields.join(', ')}`));
      }

      // No metadata IO precedes whole-object validation. IO may partially complete;
      // every operation can be retried, but the active snapshot stays unchanged on failure.
      phase = 'metadata';
      const metadata = planSettingMetadata(fields, rows, scope);
      await applySettingStructure(client, metadata);
      for (const update of metadata.updates) await applySettingUpdate(client, update, scope);
      if (metadata.conflicts.length) {
        logger.warning`Shared configuration defaults differ for keys: ${metadata.conflicts.join(', ')}`;
      }

      const next: Record<string, unknown> = parsed.data;
      const keys = new Set([...Object.keys(active), ...Object.keys(next)]);
      const changedKeys = [...keys]
        .filter(
          (key) =>
            Object.hasOwn(active, key) !== Object.hasOwn(next, key) || !isDeepStrictEqual(active[key], next[key]),
        )
        .sort();
      // Publish in one synchronous turn while preserving the reference consumers hold.
      for (const key of Object.keys(active)) {
        if (!Object.hasOwn(next, key)) Reflect.deleteProperty(active, key);
      }
      Object.assign(active, next);
      config.envSourceMap.clear();
      for (const [key, source] of sources) config.envSourceMap.set(key, source);
      return ok({ changedKeys });
    } catch (cause) {
      return err(
        phase === 'read' || phase === 'metadata'
          ? Oops.Panic.Database(`configuration sync ${phase}`, { cause })
          : Oops.Panic.Config(`Configuration sync failed during ${phase}`, { cause }),
      );
    }
  };

  return (client) => {
    if (!pending)
      pending = syncOnce(client).finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
