import { Oops } from '@app/nest/exceptions/oops';

import {
  AbstractEnvironmentVariables,
  AppConfigure,
  asDatabaseField,
  baseEnvSchema,
  coerceBoolean,
  coerceNumber,
  createEnvConfig,
  DatabaseField,
  getDatabaseFieldSpec,
} from './configure';

import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { z } from 'zod';

import type { ISysAppSettingClient, ISysAppSettingRecord } from './configure';

function row(key: string, value: string | null, patch: Partial<ISysAppSettingRecord> = {}): ISysAppSettingRecord {
  return { key, scope: 'sample-app', value, defaultValue: null, format: 'number', createdBy: 'sample-app', ...patch };
}

/** Stateful port fixture: assertions observe rows and published config, not the coordinator's private plan. */
function store(initial: ISysAppSettingRecord[] = []) {
  const rows = structuredClone(initial);
  const writes: string[] = [];
  const client: ISysAppSettingClient = {
    sysAppSetting: {
      findMany: mock(async (args) =>
        structuredClone(rows.filter((r) => !args?.where?.scope || args.where.scope.in.includes(r.scope))),
      ),
      updateMany: mock(async ({ where, data }) => {
        writes.push('updateMany');
        const matched = rows.filter(
          (r) =>
            where.key.in.includes(r.key) &&
            (where.scope === undefined || r.scope === where.scope) &&
            (where.createdBy === undefined || r.createdBy === where.createdBy),
        );
        for (const record of matched) Object.assign(record, data);
        return { count: matched.length };
      }),
      createMany: mock(async ({ data, skipDuplicates }) => {
        writes.push('createMany');
        let count = 0;
        for (const item of data) {
          if (rows.some((r) => r.scope === item.scope && r.key === item.key)) {
            if (skipDuplicates) continue;
            throw new Error('Duplicate setting');
          }
          rows.push({ ...item, value: null });
          count++;
        }
        return { count };
      }),
      findUnique: mock(async ({ where }) =>
        structuredClone(rows.find((r) => r.scope === where.scope_key.scope && r.key === where.scope_key.key) ?? null),
      ),
      create: mock(async ({ data }) => {
        writes.push('create');
        if (rows.some((r) => r.scope === data.scope && r.key === data.key)) throw new Error('Duplicate setting');
        const record = { ...data };
        rows.push(record);
        return structuredClone(record);
      }),
      update: mock(async ({ where, data }) => {
        writes.push('update');
        const record = rows.find(
          (r) =>
            r.scope === where.scope_key.scope &&
            r.key === where.scope_key.key &&
            (where.createdBy === undefined || r.createdBy === where.createdBy),
        );
        if (!record) throw new Error('Setting not found');
        Object.assign(record, data);
        return structuredClone(record);
      }),
    },
  };
  return { rows, writes, client };
}

const schema = z.object({
  SAMPLE_LIMIT: asDatabaseField(coerceNumber(z.number().int().min(0).max(10).default(4)), {
    format: 'number',
    scoped: true,
  }),
  SAMPLE_ENABLED: asDatabaseField(coerceBoolean(z.boolean().default(true)), { format: 'boolean', scoped: true }),
  SAMPLE_OPTIONAL: asDatabaseField(z.string().optional(), { format: 'string', scoped: true }),
  SAMPLE_LABEL: asDatabaseField(
    z
      .string()
      .default('code')
      .transform((value) => `parsed:${value}`),
    { format: 'string', scoped: true },
  ),
});
const originalEnv = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) Reflect.deleteProperty(process.env, key);
  Object.assign(process.env, originalEnv);
});

function configured() {
  return createEnvConfig(schema, { loadDotEnv: false, scope: 'sample-app' });
}

describe('schema configuration sync', () => {
  test('schema sync does not consult legacy reflection or the legacy sync entry', async () => {
    const reflection = spyOn(Reflect, 'getMetadata').mockImplementation(() => {
      throw new Error('Legacy metadata called');
    });
    const legacy = spyOn(AppConfigure, 'syncFromDB').mockImplementation(async () => {
      throw new Error('Legacy sync called');
    });
    try {
      const config = configured();
      expect((await config.sync(store().client)).isOk()).toBe(true);
      expect(reflection).not.toHaveBeenCalled();
      expect(legacy).not.toHaveBeenCalled();
    } finally {
      reflection.mockRestore();
      legacy.mockRestore();
    }
  });

  test('JSON null is an explicit value; SQL null withdraws the override', async () => {
    const config = createEnvConfig(
      z.object({
        SAMPLE_JSON: asDatabaseField(
          z
            .object({ limit: z.number().int().min(0) })
            .nullable()
            .optional(),
          { format: 'json', scoped: true },
        ),
      }),
      { scope: 'sample-app', loadDotEnv: false },
    );
    const db = store([row('SAMPLE_JSON', '{"limit":0}', { format: 'json' })]);
    expect((await config.sync(db.client)).isOk()).toBe(true);
    expect(config.vars.SAMPLE_JSON).toEqual({ limit: 0 });
    db.rows[0]!.value = 'null';
    expect((await config.sync(db.client)).isOk()).toBe(true);
    expect(config.vars.SAMPLE_JSON).toBeNull();
    db.rows[0]!.value = null;
    expect((await config.sync(db.client)).isOk()).toBe(true);
    expect(Object.hasOwn(config.vars, 'SAMPLE_JSON')).toBe(false);
  });

  test('publishes false and zero, preserves identity, restores host/default and removes absent optional keys', async () => {
    process.env.SAMPLE_LIMIT = '7';
    const config = configured();
    const held = config.vars;
    const db = store([
      row('SAMPLE_LIMIT', '0'),
      row('SAMPLE_ENABLED', 'false', { format: 'boolean' }),
      row('SAMPLE_OPTIONAL', 'temporary', { format: 'string' }),
      row('SAMPLE_LABEL', 'database', { format: 'string' }),
    ]);
    const first = await config.sync(db.client);
    expect(first.isOk()).toBe(true);
    expect(held).toEqual({
      SAMPLE_LIMIT: 0,
      SAMPLE_ENABLED: false,
      SAMPLE_OPTIONAL: 'temporary',
      SAMPLE_LABEL: 'parsed:database',
    });
    expect(config.vars).toBe(held);
    expect(config.envSourceMap.get('SAMPLE_LIMIT')).toBe('database:sample-app');
    expect((await config.sync(db.client))._unsafeUnwrap().changedKeys).toEqual([]);
    for (const record of db.rows) record.value = null;
    process.env.SAMPLE_LIMIT = '9'; // Refresh restores the captured host baseline, not a later process mutation.
    expect((await config.sync(db.client)).isOk()).toBe(true);
    expect(held).toEqual({ SAMPLE_LIMIT: 7, SAMPLE_ENABLED: true, SAMPLE_LABEL: 'parsed:code' });
    expect(Object.hasOwn(held, 'SAMPLE_OPTIONAL')).toBe(false);
    expect(config.envSourceMap.get('SAMPLE_LIMIT')).toBe('host');
    expect(config.envSourceMap.has('SAMPLE_OPTIONAL')).toBe(false);
  });

  test('validates the whole candidate before any metadata write or partial publication', async () => {
    const config = createEnvConfig(
      schema.refine((v) => v.SAMPLE_ENABLED || v.SAMPLE_LIMIT === 0),
      { loadDotEnv: false, scope: 'sample-app' },
    );
    const db = store([
      row('SAMPLE_LIMIT', '8'),
      row('SAMPLE_ENABLED', 'false', { format: 'boolean' }),
      row('OLD_FIELD', null),
    ]);
    const before = structuredClone(config.vars);
    const result = await config.sync(db.client);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(Oops.Block);
    expect(db.writes).toEqual([]);
    expect(config.vars).toEqual(before);
    expect(db.rows.find((r) => r.key === 'OLD_FIELD')?.deprecatedAt).toBeUndefined();
  });

  for (const bad of ['garbage', '2', '[]', '{}']) {
    test(`rejects invalid stored boolean ${bad} without publishing a valid sibling`, async () => {
      const config = configured();
      const db = store([row('SAMPLE_LIMIT', '0'), row('SAMPLE_ENABLED', bad, { format: 'boolean' })]);
      expect((await config.sync(db.client)).isErr()).toBe(true);
      expect(config.vars.SAMPLE_LIMIT).toBe(4);
      expect(config.vars.SAMPLE_ENABLED).toBe(true);
      expect(db.writes).toEqual([]);
    });
  }

  test('declared format and stored format must match even when the stored value is null', async () => {
    const config = configured();
    for (const format of ['json', 'unknown-format']) {
      const db = store([row('SAMPLE_LIMIT', null, { format })]);
      expect((await config.sync(db.client)).isErr()).toBe(true);
      expect(db.writes).toEqual([]);
    }
  });

  test('requires explicit format and project scope before storage access; env-only loading still works', async () => {
    const db = store();
    delete process.env.APP_NAME;
    const missingFormat = createEnvConfig(z.object({ SAMPLE: asDatabaseField(z.string().default('value')) }), {
      loadDotEnv: false,
      scope: 'sample-app',
    });
    expect(missingFormat.vars.SAMPLE).toBe('value');
    expect((await missingFormat.sync(db.client)).isErr()).toBe(true);
    for (const scope of [undefined, '', ' ', 'shared']) {
      const config = createEnvConfig(schema, { loadDotEnv: false, scope });
      expect((await config.sync(db.client)).isErr()).toBe(true);
    }
    expect(db.client.sysAppSetting.findMany).not.toHaveBeenCalled();
    process.env.APP_NAME = 'sample-app';
    expect((await createEnvConfig(schema, { loadDotEnv: false }).sync(db.client)).isOk()).toBe(true);
  });

  test('shares one in-flight refresh and releases it after a read failure', async () => {
    const config = configured();
    const db = store();
    const read = db.client.sysAppSetting.findMany;
    let rejectRead!: (error: Error) => void;
    db.client.sysAppSetting.findMany = mock(
      () =>
        new Promise<ISysAppSettingRecord[]>((_, reject) => {
          rejectRead = reject;
        }),
    );
    const first = config.sync(db.client);
    const overlapping = config.sync(db.client);
    expect(overlapping).toBe(first);
    expect(db.client.sysAppSetting.findMany).toHaveBeenCalledTimes(1);
    rejectRead(new Error('Synthetic read outage'));
    expect((await first).isErr()).toBe(true);
    expect(db.writes).toEqual([]);
    db.client.sysAppSetting.findMany = read;
    expect((await config.sync(db.client)).isOk()).toBe(true);
  });

  test('metadata IO failure retains the active snapshot; retry converges after partial writes', async () => {
    const config = configured();
    const db = store([row('SAMPLE_LIMIT', '2', { defaultValue: 'old' })]);
    const update = db.client.sysAppSetting.update;
    db.client.sysAppSetting.update = mock(async () => {
      throw new Error('Synthetic update outage');
    });
    expect((await config.sync(db.client)).isErr()).toBe(true);
    expect(config.vars.SAMPLE_LIMIT).toBe(4);
    expect(db.rows).toHaveLength(4); // Creation preceded the failed update; no fictional transaction rollback.
    db.client.sysAppSetting.update = update;
    expect((await config.sync(db.client)).isOk()).toBe(true);
    expect(config.vars.SAMPLE_LIMIT).toBe(2);
    expect(db.rows).toHaveLength(4);
    db.writes.length = 0;
    expect((await config.sync(db.client))._unsafeUnwrap().changedKeys).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  test('scope and creator ownership govern restore, deprecation and defaults without changing human values', async () => {
    const config = createEnvConfig(
      z.object({
        SAMPLE_SHARED: asDatabaseField(z.string().default('local'), { format: 'string' }),
        SAMPLE_SCOPED: asDatabaseField(z.string().default('local'), { format: 'string', scoped: true }),
      }),
      { loadDotEnv: false, scope: 'sample-app' },
    );
    const date = new Date('2026-01-01T00:00:00Z');
    const db = store([
      row('SAMPLE_SHARED', 'human', {
        format: 'string',
        scope: 'shared',
        createdBy: 'another-app',
        deprecatedAt: date,
        defaultValue: 'other',
      }),
      row('SAMPLE_SCOPED', 'mine', { format: 'string', createdBy: null, deprecatedAt: date }),
      row('SAMPLE_SCOPED', 'other', {
        format: 'string',
        scope: 'another-app',
        createdBy: 'another-app',
        deprecatedAt: date,
      }),
      row('OLD_FIELD', 'preserve', { format: 'string', scope: 'shared' }),
      row('FOREIGN_OLD', 'preserve', { format: 'string', scope: 'shared', createdBy: 'another-app' }),
    ]);
    expect((await config.sync(db.client)).isOk()).toBe(true);
    expect(config.vars).toEqual({ SAMPLE_SHARED: 'human', SAMPLE_SCOPED: 'mine' });
    expect(db.rows[0]).toMatchObject({
      value: 'human',
      defaultValue: 'other',
      deprecatedAt: date,
      createdBy: 'another-app',
    });
    expect(db.rows[1]).toMatchObject({ value: 'mine', defaultValue: 'local', deprecatedAt: null, createdBy: null });
    expect(db.rows[2]?.deprecatedAt).toEqual(date);
    expect(db.rows[3]?.deprecatedAt).toBeInstanceOf(Date);
    expect(db.rows[3]?.value).toBe('preserve');
    expect(db.rows[4]?.deprecatedAt).toBeUndefined();
  });

  test('restoration cannot modify a shared row whose owner changed after reading', async () => {
    const config = createEnvConfig(
      z.object({
        SAMPLE_SHARED: asDatabaseField(z.string().default('local'), { format: 'string' }),
      }),
      { loadDotEnv: false, scope: 'sample-app' },
    );
    const date = new Date('2026-01-01T00:00:00Z');
    const db = store([
      row('SAMPLE_SHARED', 'human', { scope: 'shared', format: 'string', defaultValue: 'local', deprecatedAt: date }),
    ]);
    const updateMany = db.client.sysAppSetting.updateMany;
    db.client.sysAppSetting.updateMany = async (args) => {
      db.rows[0]!.createdBy = 'another-app';
      return updateMany(args);
    };
    expect((await config.sync(db.client)).isOk()).toBe(true);
    expect(db.rows[0]?.deprecatedAt).toEqual(date);
  });

  for (const stage of ['read', 'write']) {
    test(`metadata ownership changed before ${stage} never overwrites a foreign default`, async () => {
      const config = createEnvConfig(
        z.object({
          SAMPLE_SHARED: asDatabaseField(z.string().default('local'), { format: 'string' }),
        }),
        { loadDotEnv: false, scope: 'sample-app' },
      );
      const db = store([row('SAMPLE_SHARED', 'human', { scope: 'shared', format: 'string', defaultValue: 'foreign' })]);
      if (stage === 'read') {
        const read = db.client.sysAppSetting.findUnique;
        db.client.sysAppSetting.findUnique = async (args) => {
          db.rows[0]!.createdBy = 'another-app';
          return read(args);
        };
      } else {
        const update = db.client.sysAppSetting.update;
        db.client.sysAppSetting.update = async (args) => {
          db.rows[0]!.createdBy = 'another-app';
          return update(args);
        };
      }
      const result = await config.sync(db.client);
      expect(result.isErr()).toBe(stage === 'write');
      expect(db.rows[0]?.defaultValue).toBe('foreign');
      if (stage === 'write') expect(config.vars.SAMPLE_SHARED).toBe('local');
    });
  }

  test('legacy entry uses the same ownership rules without restoring foreign or wrong-scope rows', async () => {
    class Legacy {
      @DatabaseField('string') SAMPLE_SHARED = 'local';
      @DatabaseField('string', { scoped: true }) SAMPLE_SCOPED = 'local';
    }
    const date = new Date('2026-01-01T00:00:00Z');
    const db = store([
      row('SAMPLE_SHARED', 'human', {
        format: 'string',
        scope: 'shared',
        createdBy: 'another-app',
        deprecatedAt: date,
      }),
      row('SAMPLE_SCOPED', 'mine', { format: 'string', deprecatedAt: date }),
      row('SAMPLE_SCOPED', 'other', {
        format: 'string',
        scope: 'shared',
        createdBy: 'another-app',
        deprecatedAt: date,
      }),
    ]);
    const active = new Legacy();
    await AppConfigure.syncFromDB(db.client, new Legacy(), active, { scope: 'sample-app' });
    expect(active.SAMPLE_SHARED).toBe('human');
    expect(active.SAMPLE_SCOPED).toBe('mine');
    expect(db.rows[0]?.deprecatedAt).toEqual(date);
    expect(db.rows[1]?.deprecatedAt).toBeNull();
    expect(db.rows[2]?.deprecatedAt).toEqual(date);
  });
});

describe('configuration ingress', () => {
  test('number coercion accepts numeric text but does not turn booleans or containers into numbers', () => {
    const field = coerceNumber(z.number().default(4));
    for (const value of [true, false, [], [1], {}, 'invalid', NaN, Infinity]) {
      expect(field.safeParse(value).success).toBe(false);
    }
    expect(field.parse('0')).toBe(0);
    expect(field.parse(0)).toBe(0);
    expect(field.parse(' 2.5 ')).toBe(2.5);
    expect(field.parse(' ')).toBe(4);
  });

  test('strict boolean parsing rejects everything outside the declared representations', () => {
    const field = coerceBoolean(z.boolean().default(true));
    for (const value of ['nonsense', 'FALSE', ' false ', 2, -1, [], {}, NaN])
      expect(field.safeParse(value).success).toBe(false);
    for (const value of [false, 'false', 0, '0']) expect(field.parse(value)).toBe(false);
    for (const value of [true, 'true', 1, '1', undefined, null, '', '  ']) expect(field.parse(value)).toBe(true);
    expect(coerceBoolean(z.boolean().optional()).parse(' ')).toBeUndefined();
  });

  test('shared schema covers configurable class fields and all managed fields have storage formats', () => {
    const instance = new AbstractEnvironmentVariables();
    for (const key of Object.keys(instance).filter((key) => /^[A-Z][A-Z0-9_]*$/.test(key)))
      expect(Object.hasOwn(baseEnvSchema.shape, key)).toBe(true);
    expect(
      baseEnvSchema.parse({ INFRA_REDIS_URL: 'redis://example.invalid', AI_TYPESAFE_API_KEY: 'synthetic' }),
    ).toMatchObject({ INFRA_REDIS_URL: 'redis://example.invalid', AI_TYPESAFE_API_KEY: 'synthetic' });
    expect(getDatabaseFieldSpec(baseEnvSchema.shape.API_KEY)?.format).toBe('string');
    for (const field of Object.values(baseEnvSchema.shape)) {
      const spec = getDatabaseFieldSpec(field);
      if (spec) expect(['string', 'number', 'boolean', 'json'].includes(spec.format ?? '')).toBe(true);
    }
  });

  test('production without an explicit environment fails instead of silently becoming dev', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ENV;
    delete process.env.DOPPLER_ENVIRONMENT;
    expect(() => createEnvConfig(baseEnvSchema, { loadDotEnv: false })).toThrow(Oops.Panic);
    process.env.DOPPLER_ENVIRONMENT = ' ';
    expect(() => createEnvConfig(baseEnvSchema, { loadDotEnv: false })).toThrow(Oops.Panic);
    process.env.DOPPLER_ENVIRONMENT = 'prd';
    expect(createEnvConfig(baseEnvSchema, { loadDotEnv: false }).environment).toEqual({ env: 'prd', isProd: true });
    delete process.env.NODE_ENV;
    delete process.env.DOPPLER_ENVIRONMENT;
    expect(() =>
      createEnvConfig(baseEnvSchema.extend({ NODE_ENV: z.literal('production').default('production') }), {
        loadDotEnv: false,
      }),
    ).toThrow(Oops.Panic);
  });
});
