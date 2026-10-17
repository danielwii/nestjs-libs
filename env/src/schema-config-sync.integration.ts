/** Run explicitly against a disposable PostgreSQL database; every fixture is rolled back. */
import { asDatabaseField, coerceBoolean, coerceNumber, createEnvConfig } from './configure';

import { SQL } from 'bun';
import { expect, test } from 'bun:test';
import { z } from 'zod';

import type { ISysAppSettingClient, ISysAppSettingRecord } from './configure';

const databaseUrl = process.env.SETTINGS_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('SETTINGS_TEST_DATABASE_URL must select a disposable PostgreSQL database');

const rollback = new Error('Rollback synthetic fixtures');

test('schema config uses PostgreSQL storage with isolated ownership, restoration and no invalid-candidate writes', async () => {
  const sql = new SQL({ url: databaseUrl, max: 1 });
  try {
    await sql.begin(async (tx) => {
      await tx`CREATE TEMP TABLE settings_sync_test (
        key text NOT NULL, scope text NOT NULL, value text,
        "defaultValue" text, format text NOT NULL CHECK (format IN ('string','number','boolean','json')),
        description text, "createdBy" text, "deprecatedAt" timestamptz,
        UNIQUE(scope,key)
      ) ON COMMIT DROP`;
      // Text-first casts keep pre-serialized lists from being JSON-encoded twice by the driver.
      const client: ISysAppSettingClient = {
        sysAppSetting: {
          findMany: async (args) =>
            args?.where?.scope
              ? await tx<ISysAppSettingRecord[]>`SELECT * FROM settings_sync_test WHERE scope IN (
                SELECT jsonb_array_elements_text(${JSON.stringify(args.where.scope.in)}::text::jsonb)
              )`
              : await tx<ISysAppSettingRecord[]>`SELECT * FROM settings_sync_test`,
          updateMany: async ({ where, data }) => {
            const affected = await tx<
              Array<{ key: string }>
            >`UPDATE settings_sync_test SET "deprecatedAt"=${data.deprecatedAt}
              WHERE key IN (SELECT jsonb_array_elements_text(${JSON.stringify(where.key.in)}::text::jsonb))
              AND (${where.scope ?? null}::text IS NULL OR scope=${where.scope ?? null})
              AND (${where.createdBy ?? null}::text IS NULL OR "createdBy"=${where.createdBy ?? null}) RETURNING key`;
            return { count: affected.length };
          },
          createMany: async ({ data, skipDuplicates }) => {
            let count = 0;
            for (const record of data) {
              const inserted = skipDuplicates
                ? await tx<
                    Array<{ key: string }>
                  >`INSERT INTO settings_sync_test (key,scope,"defaultValue",format,description,"createdBy")
                    VALUES (${record.key},${record.scope},${record.defaultValue},${record.format},${record.description ?? null},${record.createdBy ?? null})
                    ON CONFLICT(scope,key) DO NOTHING RETURNING key`
                : await tx<
                    Array<{ key: string }>
                  >`INSERT INTO settings_sync_test (key,scope,"defaultValue",format,description,"createdBy")
                    VALUES (${record.key},${record.scope},${record.defaultValue},${record.format},${record.description ?? null},${record.createdBy ?? null}) RETURNING key`;
              count += inserted.length;
            }
            return { count };
          },
          findUnique: async ({ where }) => {
            const rows = await tx<
              ISysAppSettingRecord[]
            >`SELECT * FROM settings_sync_test WHERE scope=${where.scope_key.scope} AND key=${where.scope_key.key}`;
            return rows[0] ?? null;
          },
          create: async ({ data }) => {
            const rows = await tx<
              ISysAppSettingRecord[]
            >`INSERT INTO settings_sync_test (key,scope,value,"defaultValue",format,description,"createdBy")
              VALUES (${data.key},${data.scope},${data.value},${data.defaultValue},${data.format},${data.description ?? null},${data.createdBy ?? null}) RETURNING *`;
            const record = rows[0];
            if (!record) throw new Error('Fixture insert returned no record');
            return record;
          },
          update: async ({ where, data }) => {
            const rows = await tx<ISysAppSettingRecord[]>`UPDATE settings_sync_test SET
              "defaultValue"=CASE WHEN ${Object.hasOwn(data, 'defaultValue')} THEN ${data.defaultValue ?? null} ELSE "defaultValue" END,
              description=CASE WHEN ${Object.hasOwn(data, 'description')} THEN ${data.description ?? null} ELSE description END,
              "deprecatedAt"=CASE WHEN ${Object.hasOwn(data, 'deprecatedAt')} THEN ${data.deprecatedAt ?? null} ELSE "deprecatedAt" END
              WHERE scope=${where.scope_key.scope} AND key=${where.scope_key.key}
              AND (${where.createdBy ?? null}::text IS NULL OR "createdBy"=${where.createdBy ?? null}) RETURNING *`;
            const record = rows[0];
            if (!record) throw new Error('Fixture update found no record');
            return record;
          },
        },
      };
      const config = createEnvConfig(
        z.object({
          SAMPLE_LIMIT: asDatabaseField(coerceNumber(z.number().int().min(0).max(10).default(4)), {
            format: 'number',
            scoped: true,
          }),
          SAMPLE_ENABLED: asDatabaseField(coerceBoolean(z.boolean().default(true)), {
            format: 'boolean',
            scoped: true,
          }),
          SAMPLE_SHARED: asDatabaseField(z.string().default('local'), { format: 'string' }),
          SAMPLE_OPTIONAL: asDatabaseField(z.string().optional(), { format: 'string', scoped: true }),
        }),
        { loadDotEnv: false, scope: 'sample-app' },
      );
      await tx`INSERT INTO settings_sync_test (key,scope,value,"defaultValue",format,"createdBy","deprecatedAt") VALUES
        ('SAMPLE_LIMIT','sample-app','0','4','number','sample-app',now()),
        ('SAMPLE_LIMIT','another-app','9','9','number','another-app',now()),
        ('SAMPLE_ENABLED','sample-app','false','true','boolean','sample-app',NULL),
        ('SAMPLE_SHARED','shared','human','other','string','another-app',now()),
        ('SAMPLE_OPTIONAL','sample-app','temporary',NULL,'string','sample-app',NULL),
        ('OLD_FIELD','shared','preserved',NULL,'string','sample-app',NULL),
        ('FOREIGN_OLD','shared','preserved',NULL,'string','another-app',NULL)`;
      const held = config.vars;
      const initialSync = await config.sync(client);
      if (initialSync.isErr()) throw initialSync.error;
      expect(initialSync.value.changedKeys).toEqual([
        'SAMPLE_ENABLED',
        'SAMPLE_LIMIT',
        'SAMPLE_OPTIONAL',
        'SAMPLE_SHARED',
      ]);
      expect(held).toEqual({
        SAMPLE_LIMIT: 0,
        SAMPLE_ENABLED: false,
        SAMPLE_SHARED: 'human',
        SAMPLE_OPTIONAL: 'temporary',
      });
      expect(config.vars).toBe(held);
      const get = (key: string, scope: string) =>
        client.sysAppSetting.findUnique({ where: { scope_key: { key, scope } } });
      expect((await get('SAMPLE_LIMIT', 'sample-app'))?.deprecatedAt).toBeNull();
      expect((await get('SAMPLE_LIMIT', 'another-app'))?.deprecatedAt).toBeInstanceOf(Date);
      expect(await get('SAMPLE_SHARED', 'shared')).toMatchObject({
        value: 'human',
        defaultValue: 'other',
        createdBy: 'another-app',
      });
      expect((await get('SAMPLE_SHARED', 'shared'))?.deprecatedAt).toBeInstanceOf(Date);
      expect((await get('OLD_FIELD', 'shared'))?.deprecatedAt).toBeInstanceOf(Date);
      expect((await get('FOREIGN_OLD', 'shared'))?.deprecatedAt).toBeNull();
      expect((await config.sync(client))._unsafeUnwrap().changedKeys).toEqual([]);

      await tx`UPDATE settings_sync_test SET value=NULL WHERE scope='sample-app'`;
      expect((await config.sync(client)).isOk()).toBe(true);
      expect(held).toEqual({ SAMPLE_LIMIT: 4, SAMPLE_ENABLED: true, SAMPLE_SHARED: 'human' });
      expect(Object.hasOwn(held, 'SAMPLE_OPTIONAL')).toBe(false);

      await tx`UPDATE settings_sync_test SET value='invalid-secret-value' WHERE key='SAMPLE_ENABLED' AND scope='sample-app'`;
      await tx`INSERT INTO settings_sync_test (key,scope,value,format,"createdBy") VALUES ('NEW_ORPHAN','sample-app','human','string','sample-app')`;
      const before = await tx`SELECT * FROM settings_sync_test ORDER BY scope,key`;
      const rejected = await config.sync(client);
      expect(rejected.isErr()).toBe(true);
      expect(rejected._unsafeUnwrapErr().message).not.toContain('invalid-secret-value');
      expect(await tx`SELECT * FROM settings_sync_test ORDER BY scope,key`).toEqual(before);
      expect(held.SAMPLE_ENABLED).toBe(true);
      expect((await tx`SELECT 1 AS usable`)[0]?.usable).toBe(1); // The runtime never closes the caller's connection.
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    await sql.close();
  }
});
