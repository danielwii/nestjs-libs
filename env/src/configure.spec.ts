import { AbstractEnvironmentVariables, AppConfigure, DatabaseField } from './configure';

import { describe, expect, it, mock } from 'bun:test';

import 'reflect-metadata';

import * as os from 'node:os';

import { IsString, Min } from 'class-validator';
import * as _ from 'radash';

describe('AppConfigure', () => {
  describe('syncFromDB', () => {
    // 模拟一个配置类
    class TestEnvs {
      @DatabaseField('string', '测试字段')
      TEST_FIELD: string = 'default_code_value';
      APP_CONFIG_SYNC_WRITE_ENABLED: boolean = true;
    }

    it('should separate code default value from runtime env value', async () => {
      // 1. 准备数据
      const originalEnvs = new TestEnvs(); // 原始快照 (Code Default)

      const activeEnvs = new TestEnvs();
      activeEnvs.TEST_FIELD = 'env_override_value'; // 模拟运行态 (Env Override)

      // Mock Prisma
      const mockPrisma = {
        sysAppSetting: {
          findMany: mock(() => Promise.resolve([])),
          createMany: mock(() => Promise.resolve({ count: 1 })),
          updateMany: mock(() => Promise.resolve({ count: 0 })),
          findUnique: mock(() => Promise.resolve(null)),
          create: mock(() => Promise.resolve({})),
          update: mock(() => Promise.resolve({})),
        },
      };

      // 2. 执行同步
      // 现在传递两个副本
      await AppConfigure.syncFromDB(mockPrisma as unknown as any, originalEnvs as any, activeEnvs as any);

      // 3. 验证结果
      expect(mockPrisma.sysAppSetting.createMany).toHaveBeenCalled();

      const createData = (mockPrisma.sysAppSetting.createMany.mock.calls as any[][])[0]![0].data[0];

      expect(createData.key).toBe('TEST_FIELD');

      // [关键断言 1] defaultValue 应该是 originalEnvs 里的原始值
      expect(createData.defaultValue).toBe('default_code_value');

      // [关键断言 2] 初始创建时，value 应该为 null，不覆盖环境
      expect(createData.value).toBeNull();
    });

    it('should override active envs if database has a value', async () => {
      const originalEnvs = new TestEnvs();
      const activeEnvs = new TestEnvs(); // 当前是 'default_code_value'

      const mockPrisma = {
        sysAppSetting: {
          findMany: mock(() =>
            Promise.resolve([
              {
                key: 'TEST_FIELD',
                scope: 'shared',
                value: 'db_override_value',
                defaultValue: 'default_code_value',
                format: 'string',
              },
            ]),
          ),
          updateMany: mock(() => Promise.resolve({ count: 0 })),
          createMany: mock(() => Promise.resolve({ count: 0 })),
          findUnique: mock(() => Promise.resolve({ key: 'TEST_FIELD' })),
          update: mock(() => Promise.resolve({})),
        },
      };

      await AppConfigure.syncFromDB(mockPrisma as unknown as any, originalEnvs as any, activeEnvs as any);

      // [关键断言] activeEnvs 应该被 DB 的值覆盖
      expect(activeEnvs.TEST_FIELD).toBe('db_override_value');
    });

    it('should handle deprecation and restoration', async () => {
      class Envs {
        @DatabaseField('string') FIELD1: string = 'v1';
        APP_CONFIG_SYNC_WRITE_ENABLED: boolean = true;
      }
      const original = new Envs();
      const active = new Envs();

      const mockPrisma = {
        sysAppSetting: {
          findMany: mock(() =>
            Promise.resolve([
              { key: 'FIELD1', scope: 'shared', value: 'val', format: 'string' },
              { key: 'ORPHAN', scope: 'shared', value: 'old', format: 'string', deprecatedAt: null },
            ]),
          ),
          updateMany: mock(() => Promise.resolve({ count: 1 })),
          createMany: mock(() => Promise.resolve({ count: 0 })),
          findUnique: mock((args: Record<string, any>) => Promise.resolve({ key: args.where.key })),
          update: mock(() => Promise.resolve({})),
        },
      };

      await AppConfigure.syncFromDB(mockPrisma as unknown as any, original as any, active as any);

      // Verify updateMany was called to deprecate ORPHAN
      const deprecateCall = (mockPrisma.sysAppSetting.updateMany.mock.calls as any[][])[0]![0];
      expect(deprecateCall.where.key.in).toContain('ORPHAN');
      expect(deprecateCall.data.deprecatedAt).toBeDefined();
    });

    it('should override activeEnvs with DB value when env var not effective (bug reproduction)', async () => {
      // 场景：代码默认值 60，环境变量应为 1440 但没生效，数据库 value=1440
      // 期望：syncFromDB 应该把 activeEnvs 覆盖为 1440
      class NumberEnvs {
        @DatabaseField('number', '每日配额')
        DAILY_MINUTES: number = 60; // 代码默认值
        APP_CONFIG_SYNC_WRITE_ENABLED: boolean = true;
      }

      const originalEnvs = new NumberEnvs(); // 60
      const activeEnvs = new NumberEnvs(); // 60（环境变量没生效的情况）

      const mockPrisma = {
        sysAppSetting: {
          findMany: mock(() =>
            Promise.resolve([
              {
                key: 'DAILY_MINUTES',
                scope: 'shared',
                value: 1440,
                defaultValue: '60',
                format: 'number',
              },
            ]),
          ),
          updateMany: mock(() => Promise.resolve({ count: 0 })),
          createMany: mock(() => Promise.resolve({ count: 0 })),
          findUnique: mock(() => Promise.resolve({ key: 'DAILY_MINUTES' })),
          update: mock(() => Promise.resolve({})),
        },
      };

      await AppConfigure.syncFromDB(mockPrisma as unknown as any, originalEnvs as any, activeEnvs as any);

      // [关键断言] activeEnvs 应该被 DB 的值覆盖为 1440
      expect(activeEnvs.DAILY_MINUTES).toBe(1440);
    });

    it('should NOT override activeEnvs when DB value equals activeEnvs', async () => {
      // 场景：环境变量已生效（1440），数据库 value 也是 1440
      // 期望：不触发覆盖日志，值保持 1440
      class NumberEnvs {
        @DatabaseField('number', '每日配额')
        DAILY_MINUTES: number = 60;
        APP_CONFIG_SYNC_WRITE_ENABLED: boolean = true;
      }

      const originalEnvs = new NumberEnvs();
      originalEnvs.DAILY_MINUTES = 1440; // 模拟环境变量已覆盖

      const activeEnvs = new NumberEnvs();
      activeEnvs.DAILY_MINUTES = 1440; // 当前运行值

      const mockPrisma = {
        sysAppSetting: {
          findMany: mock(() =>
            Promise.resolve([
              {
                key: 'DAILY_MINUTES',
                scope: 'shared',
                value: 1440,
                defaultValue: '60',
                format: 'number',
              },
            ]),
          ),
          updateMany: mock(() => Promise.resolve({ count: 0 })),
          createMany: mock(() => Promise.resolve({ count: 0 })),
          findUnique: mock(() => Promise.resolve({ key: 'DAILY_MINUTES' })),
          update: mock(() => Promise.resolve({})),
        },
      };

      await AppConfigure.syncFromDB(mockPrisma as unknown as any, originalEnvs as any, activeEnvs as any);

      // 值应保持 1440
      expect(activeEnvs.DAILY_MINUTES).toBe(1440);
    });

    it('should handle number type correctly when DB stores as string', async () => {
      // 场景：数据库 format=number，但 value 存储可能是字符串（测试 JSON.parse 逻辑）
      class NumberEnvs {
        @DatabaseField('number', '每日配额')
        DAILY_MINUTES: number = 60;
        APP_CONFIG_SYNC_WRITE_ENABLED: boolean = true;
      }

      const originalEnvs = new NumberEnvs();
      const activeEnvs = new NumberEnvs(); // 60

      // 注意：syncFromDB 内部会对非 string format 执行 JSON.parse
      // 这里模拟 findMany 返回已解析的值（1440 是数字类型）
      const mockPrisma = {
        sysAppSetting: {
          findMany: mock(() =>
            Promise.resolve([
              {
                key: 'DAILY_MINUTES',
                scope: 'shared',
                value: 1440,
                defaultValue: '60',
                format: 'number',
              },
            ]),
          ),
          updateMany: mock(() => Promise.resolve({ count: 0 })),
          createMany: mock(() => Promise.resolve({ count: 0 })),
          findUnique: mock(() => Promise.resolve({ key: 'DAILY_MINUTES' })),
          update: mock(() => Promise.resolve({})),
        },
      };

      await AppConfigure.syncFromDB(mockPrisma as unknown as any, originalEnvs as any, activeEnvs as any);

      expect(activeEnvs.DAILY_MINUTES).toBe(1440);
      expect(typeof activeEnvs.DAILY_MINUTES).toBe('number');
    });

    it('should skip overriding activeEnvs when DB value is invalid', async () => {
      class NumberEnvs {
        @DatabaseField('number', '默认 LLM 调用超时（毫秒）')
        @Min(1000)
        AI_LLM_TIMEOUT_MS: number = 60_000;
        APP_CONFIG_SYNC_WRITE_ENABLED: boolean = true;
      }

      const originalEnvs = new NumberEnvs();
      const activeEnvs = new NumberEnvs();

      const mockPrisma = {
        sysAppSetting: {
          findMany: mock(() =>
            Promise.resolve([
              {
                key: 'AI_LLM_TIMEOUT_MS',
                scope: 'shared',
                value: 500,
                defaultValue: '60000',
                format: 'number',
              },
            ]),
          ),
          updateMany: mock(() => Promise.resolve({ count: 0 })),
          createMany: mock(() => Promise.resolve({ count: 0 })),
          findUnique: mock(() => Promise.resolve({ key: 'AI_LLM_TIMEOUT_MS' })),
          update: mock(() => Promise.resolve({})),
        },
      };

      await AppConfigure.syncFromDB(mockPrisma as unknown as any, originalEnvs as any, activeEnvs as any);

      // 不应被非法 DB 值覆盖
      expect(activeEnvs.AI_LLM_TIMEOUT_MS).toBe(60_000);
    });

    it('should work when originalEnvs is created via structuredClone (loses prototype chain)', async () => {
      // 场景：模拟 AppConfigure 构造函数中的行为
      // this.vars = this.validate(); // plainToInstance 创建类实例
      // this.originalVars = structuredClone(this.vars); // 普通对象，丢失原型链
      //
      // Bug 复现：structuredClone 创建的对象没有原型链，Reflect.getMetadata 找不到装饰器
      // 修复：使用 activeEnvs（类实例）来查找装饰器元数据

      class NumberEnvs {
        @DatabaseField('number', '每日配额')
        DAILY_MINUTES: number = 60;
        APP_CONFIG_SYNC_WRITE_ENABLED: boolean = true;
      }

      const activeEnvs = new NumberEnvs(); // 类实例，有原型链
      const originalEnvs = structuredClone(activeEnvs); // 普通对象，无原型链！

      // 验证 structuredClone 确实丢失了原型链
      expect(Object.getPrototypeOf(activeEnvs)).toBe(NumberEnvs.prototype);
      expect(Object.getPrototypeOf(originalEnvs)).toBe(Object.prototype); // 普通对象

      const mockPrisma = {
        sysAppSetting: {
          findMany: mock(() =>
            Promise.resolve([
              {
                key: 'DAILY_MINUTES',
                scope: 'shared',
                value: 1440,
                defaultValue: '60',
                format: 'number',
              },
            ]),
          ),
          updateMany: mock(() => Promise.resolve({ count: 0 })),
          createMany: mock(() => Promise.resolve({ count: 0 })),
          findUnique: mock(() => Promise.resolve({ key: 'DAILY_MINUTES' })),
          update: mock(() => Promise.resolve({})),
        },
      };

      await AppConfigure.syncFromDB(mockPrisma as unknown as any, originalEnvs as any, activeEnvs as any);

      // [关键断言] 即使 originalEnvs 是 structuredClone 创建的普通对象，
      // syncFromDB 应该能通过 activeEnvs 找到装饰器元数据，正确覆盖值
      expect(activeEnvs.DAILY_MINUTES).toBe(1440);
    });

    it('should update metadata if defaults or description change', async () => {
      class Envs {
        @DatabaseField('string', 'New Description')
        FIELD: string = 'new_default';
        APP_CONFIG_SYNC_WRITE_ENABLED: boolean = true;
      }
      const original = new Envs();
      const active = new Envs();

      const mockPrisma = {
        sysAppSetting: {
          findMany: mock(() =>
            Promise.resolve([
              {
                key: 'FIELD',
                scope: 'shared',
                value: 'val',
                defaultValue: 'old_default',
                description: 'Old Description',
                format: 'string',
              },
            ]),
          ),
          updateMany: mock(() => Promise.resolve({ count: 0 })),
          createMany: mock(() => Promise.resolve({ count: 0 })),
          findUnique: mock(() => Promise.resolve({ key: 'FIELD' })),
          update: mock(() => Promise.resolve({})),
        },
      };

      await AppConfigure.syncFromDB(mockPrisma as unknown as any, original as any, active as any);

      expect(mockPrisma.sysAppSetting.update).toHaveBeenCalled();
      const updateData = (mockPrisma.sysAppSetting.update.mock.calls as any[][])[0]![0].data;
      expect(updateData.defaultValue).toBe('new_default');
      expect(updateData.description).toBe('New Description');
    });

    it('should skip all DB writes when APP_CONFIG_SYNC_WRITE_ENABLED is false', async () => {
      class Envs {
        @DatabaseField('string', 'New Description')
        FIELD: string = 'new_default';
        APP_CONFIG_SYNC_WRITE_ENABLED: boolean = false;
      }
      const original = new Envs();
      const active = new Envs();

      const mockPrisma = {
        sysAppSetting: {
          findMany: mock(() =>
            Promise.resolve([
              {
                key: 'FIELD',
                scope: 'shared',
                value: 'db_value',
                defaultValue: 'old_default',
                description: 'Old Description',
                format: 'string',
                deprecatedAt: null,
              },
              {
                key: 'ORPHAN',
                scope: 'shared',
                value: 'old',
                format: 'string',
                deprecatedAt: null,
              },
            ]),
          ),
          updateMany: mock(() => Promise.resolve({ count: 0 })),
          createMany: mock(() => Promise.resolve({ count: 0 })),
          findUnique: mock(() => Promise.resolve({ key: 'FIELD' })),
          create: mock(() => Promise.resolve({})),
          update: mock(() => Promise.resolve({})),
        },
      };

      await AppConfigure.syncFromDB(mockPrisma as unknown as any, original as any, active as any);

      // 读路径仍生效
      expect(active.FIELD).toBe('db_value');
      // 写路径全部跳过
      expect(mockPrisma.sysAppSetting.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.sysAppSetting.createMany).not.toHaveBeenCalled();
      expect(mockPrisma.sysAppSetting.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.sysAppSetting.create).not.toHaveBeenCalled();
      expect(mockPrisma.sysAppSetting.update).not.toHaveBeenCalled();
    });
  });

  describe('sync (instance method)', () => {
    class TestEnvs extends AbstractEnvironmentVariables {
      @DatabaseField('string')
      KEY: string = 'default';
    }

    it('should call static syncFromDB with correct args', async () => {
      const appConfig = new AppConfigure(TestEnvs);
      const mockPrisma = { sysAppSetting: {} };

      const originalSyncFromDB = AppConfigure.syncFromDB;
      const staticSpy = mock(async () => {});
      (AppConfigure as any).syncFromDB = staticSpy;

      try {
        await appConfig.sync(mockPrisma as any);

        expect(staticSpy).toHaveBeenCalledTimes(1);
        const calls = staticSpy.mock.calls[0] as any[];
        expect(calls[0]).toBe(mockPrisma);
        expect(calls[1]).toEqual(appConfig.originalVars);
        expect(calls[2]).toBe(appConfig.vars);
      } finally {
        (AppConfigure as any).syncFromDB = originalSyncFromDB;
      }
    });
  });

  describe('Validation and Debugging', () => {
    it('allFields should return property names', () => {
      const fields = AbstractEnvironmentVariables.allFields;
      expect(fields).toContain('PORT');
      expect(fields).toContain('TZ');
    });

    it('should throw validation error for invalid configs', () => {
      class InvalidEnvs extends AbstractEnvironmentVariables {
        @IsString()
        REQUIRED_STRING!: string;
      }
      // Bun or dotenv might have injected vars, so we clear them to trigger validation error
      const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        expect(() => new AppConfigure(InvalidEnvs)).toThrow();
      } finally {
        process.env.NODE_ENV = ORIGINAL_NODE_ENV;
      }
    });

    it('should cover debug logging paths', () => {
      const ORIGINAL_DEBUG = process.env.CONFIGURE_DEBUG;
      process.env.CONFIGURE_DEBUG = 'true';
      try {
        const appConfig = new AppConfigure(AbstractEnvironmentVariables, true);
        expect(appConfig.vars).toBeDefined();
      } finally {
        process.env.CONFIGURE_DEBUG = ORIGINAL_DEBUG;
      }
    });

    it('EnvironmentVariables properties coverage', () => {
      const envs = new AbstractEnvironmentVariables();
      expect(envs.environment.env).toBeDefined();
      expect(envs.isNodeDevelopment).toBe(process.env.NODE_ENV === 'development');
      expect(envs.NODE_NAME).toContain(os.hostname());
    });
  });

  describe('Transformers', () => {
    it('booleanTransformFn should handle various inputs', () => {
      const { booleanTransformFn } = require('./configure');
      expect(booleanTransformFn({ key: 'k', obj: { k: 'true' } })).toBe(true);
      expect(booleanTransformFn({ key: 'k', obj: { k: '1' } })).toBe(true);
      expect(booleanTransformFn({ key: 'k', obj: { k: true } })).toBe(true);
      expect(booleanTransformFn({ key: 'k', obj: { k: 'false' } })).toBe(false);
      expect(booleanTransformFn({ key: 'k', obj: { k: '0' } })).toBe(false);
      expect(booleanTransformFn({ key: 'k', obj: { k: null } })).toBe(false);
    });

    it('objectTransformFn should parse JSON5 strings or return objects', () => {
      const { objectTransformFn } = require('./configure');
      expect(objectTransformFn({ key: 'k', obj: { k: { a: 1 } } })).toEqual({ a: 1 });
      expect(objectTransformFn({ key: 'k', obj: { k: '{a:1}' } })).toEqual({ a: 1 }); // JSON5
      expect(objectTransformFn({ key: 'k', obj: { k: '' } })).toEqual({});
      expect(() => objectTransformFn({ key: 'k', obj: { k: '{invalid}' } })).toThrow();
    });

    it('arrayTransformFn should parse JSON5 strings or return arrays', () => {
      const { arrayTransformFn } = require('./configure');
      expect(arrayTransformFn({ key: 'k', obj: { k: [1, 2] } })).toEqual([1, 2]);
      expect(arrayTransformFn({ key: 'k', obj: { k: '[1,2]' } })).toEqual([1, 2]);
      expect(arrayTransformFn({ key: 'k', obj: { k: '' } })).toEqual([]);
      expect(() => arrayTransformFn({ key: 'k', obj: { k: '[invalid]' } })).toThrow();
    });
  });

  describe('Host Logic', () => {
    class TestEnvs extends AbstractEnvironmentVariables {}

    it('hostIndex should return numeric suffix', () => {
      const envs = new TestEnvs();
      // @ts-ignore - hacking hostname for test
      (envs as any).hostname = 'app-server-1';
      expect(envs.hostIndex).toBe(1);

      // @ts-ignore
      (envs as any).hostname = 'localhost';
      expect(envs.hostIndex).toBeNull();
    });

    it('I18N_EXCEPTION_ENABLED transform coverage', () => {
      class TestI18n extends AbstractEnvironmentVariables {}
      process.env.I18N_EXCEPTION_ENABLED = 'true';
      const config1 = new AppConfigure(TestI18n);
      expect(config1.vars.I18N_EXCEPTION_ENABLED).toBe(true);

      process.env.I18N_EXCEPTION_ENABLED = 'false';
      const config2 = new AppConfigure(TestI18n);
      expect(config2.vars.I18N_EXCEPTION_ENABLED).toBe(false);

      delete process.env.I18N_EXCEPTION_ENABLED;
    });

    it('getUniqueHost should identify if it should run on current host', () => {
      const envs = new TestEnvs();
      // @ts-ignore
      (envs as any).hostname = 'app-server-1';

      expect(envs.getUniqueHost({ hostId: 1, key: 'task1' })).toBe(true);
      expect(envs.getUniqueHost({ hostId: 0, key: 'task2' })).toBe(false);
      expect(envs.getUniqueHost({ hostId: 2, key: 'task3' })).toBe(false);

      // acceptWhenNoIds logic
      // @ts-ignore
      (envs as any).hostname = 'localhost';
      expect(envs.getUniqueHost({ hostId: 1, key: 'task4', acceptWhenNoIds: true })).toBe(true);
      expect(envs.getUniqueHost({ hostId: 1, key: 'task5', acceptWhenNoIds: false })).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Scope 隔离
  // ═══════════════════════════════════════════════════════════════════════════

  describe('syncFromDB with scope', () => {
    // ─── helpers ──────────────────────────────────────────────────────────
    function buildScopedMock(
      rows: Array<
        Partial<{
          key: string;
          scope: string;
          value: unknown;
          defaultValue: string | null;
          format: string;
          description: string | null;
          deprecatedAt: Date | null;
        }>
      >,
    ) {
      return {
        sysAppSetting: {
          findMany: mock(() => Promise.resolve(rows)),
          createMany: mock(() => Promise.resolve({ count: 1 })),
          updateMany: mock(() => Promise.resolve({ count: 0 })),
          findUnique: mock((args: any) => {
            const { scope, key } = args.where.scope_key ?? {};
            const row = rows.find((r) => r.key === key && r.scope === scope);
            return Promise.resolve(row ?? null);
          }),
          create: mock(() => Promise.resolve({})),
          update: mock(() => Promise.resolve({})),
        },
      };
    }

    // ─── Cycle 0: Decorator { scoped: true } ──────────────────────────────

    describe('DatabaseField decorator overload', () => {
      it('should accept options object with scoped: true', () => {
        // 编译期 + 运行期不报错就算通过
        class TestEnvs {
          @DatabaseField('string', { description: 'scoped field', scoped: true })
          SCOPED_FIELD: string = 'val';
          APP_CONFIG_SYNC_WRITE_ENABLED: boolean = true;
        }
        const envs = new TestEnvs();
        expect(envs.SCOPED_FIELD).toBe('val');
      });

      it('should still accept string description (backward compat)', () => {
        class TestEnvs {
          @DatabaseField('string', 'a description')
          FIELD: string = 'val';
        }
        const envs = new TestEnvs();
        expect(envs.FIELD).toBe('val');
      });
    });

    // ─── Cycle 3: 共享字段写入 scope='shared' ─────────────────────────────

    it('should create shared fields with scope="shared"', async () => {
      class Envs {
        @DatabaseField('string', 'desc')
        FIELD: string = 'val';
        APP_CONFIG_SYNC_WRITE_ENABLED: boolean = true;
      }
      const original = new Envs();
      const active = new Envs();
      const mockPrisma = buildScopedMock([]);

      await AppConfigure.syncFromDB(mockPrisma as any, original as any, active as any, { scope: 'my-project' });

      expect(mockPrisma.sysAppSetting.createMany).toHaveBeenCalled();
      const createData = (mockPrisma.sysAppSetting.createMany.mock.calls as any[][])[0]![0].data[0];
      expect(createData.scope).toBe('shared');
      expect(createData.key).toBe('FIELD');
    });

    // ─── Cycle 4: Scoped 字段写入 projectName ──────────────────────────────

    it('should create scoped fields with scope=projectName', async () => {
      class Envs {
        @DatabaseField('string', { description: 'scoped', scoped: true })
        MY_FIELD: string = 'val';
        APP_CONFIG_SYNC_WRITE_ENABLED: boolean = true;
      }
      const original = new Envs();
      const active = new Envs();
      const mockPrisma = buildScopedMock([]);

      await AppConfigure.syncFromDB(mockPrisma as any, original as any, active as any, { scope: 'ai-persona' });

      expect(mockPrisma.sysAppSetting.createMany).toHaveBeenCalled();
      const createData = (mockPrisma.sysAppSetting.createMany.mock.calls as any[][])[0]![0].data[0];
      expect(createData.scope).toBe('ai-persona');
    });

    // ─── Cycle 5: 读取优先级 scoped > shared > code default ────────────────

    it('should prefer project-scoped value over shared value', async () => {
      class Envs {
        @DatabaseField('string', { description: 'model', scoped: true })
        MY_MODEL: string = 'code-default';
        APP_CONFIG_SYNC_WRITE_ENABLED: boolean = false;
      }
      const original = new Envs();
      const active = new Envs();
      const mockPrisma = buildScopedMock([
        { key: 'MY_MODEL', scope: 'shared', value: 'shared-model', format: 'string' },
        { key: 'MY_MODEL', scope: 'ai-persona', value: 'scoped-model', format: 'string' },
      ]);

      await AppConfigure.syncFromDB(mockPrisma as any, original as any, active as any, { scope: 'ai-persona' });
      expect((active as any).MY_MODEL).toBe('scoped-model');
    });

    it('should fall back to shared value when no scoped value exists', async () => {
      class Envs {
        @DatabaseField('string', { description: 'model', scoped: true })
        MY_MODEL: string = 'code-default';
        APP_CONFIG_SYNC_WRITE_ENABLED: boolean = false;
      }
      const original = new Envs();
      const active = new Envs();
      const mockPrisma = buildScopedMock([
        { key: 'MY_MODEL', scope: 'shared', value: 'shared-model', format: 'string' },
      ]);

      await AppConfigure.syncFromDB(mockPrisma as any, original as any, active as any, { scope: 'ai-persona' });
      expect((active as any).MY_MODEL).toBe('shared-model');
    });

    it('should use code default when no DB values exist', async () => {
      class Envs {
        @DatabaseField('string', { description: 'model', scoped: true })
        MY_MODEL: string = 'code-default';
        APP_CONFIG_SYNC_WRITE_ENABLED: boolean = false;
      }
      const original = new Envs();
      const active = new Envs();
      const mockPrisma = buildScopedMock([]);

      await AppConfigure.syncFromDB(mockPrisma as any, original as any, active as any, { scope: 'ai-persona' });
      expect((active as any).MY_MODEL).toBe('code-default');
    });

    it('should apply shared field DB value (non-scoped field reads shared only)', async () => {
      class Envs {
        @DatabaseField('string', 'desc')
        SHARED_FIELD: string = 'code-default';
        APP_CONFIG_SYNC_WRITE_ENABLED: boolean = false;
      }
      const original = new Envs();
      const active = new Envs();
      const mockPrisma = buildScopedMock([
        { key: 'SHARED_FIELD', scope: 'shared', value: 'db-value', format: 'string' },
      ]);

      await AppConfigure.syncFromDB(mockPrisma as any, original as any, active as any, { scope: 'ai-persona' });
      expect((active as any).SHARED_FIELD).toBe('db-value');
    });

    // ─── Cycle 6: Orphan 检测按 scope 隔离 ──────────────────────────────────

    it('should not deprecate other project scope rows', async () => {
      class Envs {
        @DatabaseField('string') FIELD1: string = 'v1';
        APP_CONFIG_SYNC_WRITE_ENABLED: boolean = true;
      }
      const original = new Envs();
      const active = new Envs();
      const mockPrisma = buildScopedMock([
        { key: 'FIELD1', scope: 'shared', value: 'val', format: 'string' },
        { key: 'OTHER_PROJECT_FIELD', scope: 'other-project', value: 'val', format: 'string', deprecatedAt: null },
      ]);

      await AppConfigure.syncFromDB(mockPrisma as any, original as any, active as any, { scope: 'my-project' });

      // updateMany 不应该 deprecate 'other-project' scope 的行
      if (mockPrisma.sysAppSetting.updateMany.mock.calls.length > 0) {
        const calls = mockPrisma.sysAppSetting.updateMany.mock.calls as any[][];
        for (const call of calls) {
          const keys = call[0]?.where?.key?.in ?? [];
          expect(keys).not.toContain('OTHER_PROJECT_FIELD');
        }
      }
    });

    it('should deprecate orphans only in shared scope for shared fields', async () => {
      class Envs {
        @DatabaseField('string') FIELD1: string = 'v1';
        APP_CONFIG_SYNC_WRITE_ENABLED: boolean = true;
      }
      const original = new Envs();
      const active = new Envs();
      const mockPrisma = buildScopedMock([
        { key: 'FIELD1', scope: 'shared', value: 'val', format: 'string' },
        { key: 'ORPHAN_SHARED', scope: 'shared', value: 'old', format: 'string', deprecatedAt: null },
      ]);

      await AppConfigure.syncFromDB(mockPrisma as any, original as any, active as any, { scope: 'my-project' });

      const calls = mockPrisma.sysAppSetting.updateMany.mock.calls as any[][];
      expect(calls.length).toBeGreaterThan(0);
      const deprecateCall = calls.find((c) => c[0]?.data?.deprecatedAt);
      expect(deprecateCall).toBeDefined();
      expect(deprecateCall![0].where.key.in).toContain('ORPHAN_SHARED');
    });

    it('should deprecate orphans in own project scope for scoped fields', async () => {
      class Envs {
        @DatabaseField('string', { description: 'scoped', scoped: true })
        SCOPED_FIELD: string = 'v1';
        APP_CONFIG_SYNC_WRITE_ENABLED: boolean = true;
      }
      const original = new Envs();
      const active = new Envs();
      const mockPrisma = buildScopedMock([
        { key: 'SCOPED_FIELD', scope: 'my-project', value: 'val', format: 'string' },
        { key: 'OLD_SCOPED', scope: 'my-project', value: 'old', format: 'string', deprecatedAt: null },
      ]);

      await AppConfigure.syncFromDB(mockPrisma as any, original as any, active as any, { scope: 'my-project' });

      const calls = mockPrisma.sysAppSetting.updateMany.mock.calls as any[][];
      const deprecateCall = calls.find((c) => c[0]?.data?.deprecatedAt);
      expect(deprecateCall).toBeDefined();
      expect(deprecateCall![0].where.key.in).toContain('OLD_SCOPED');
    });

    // ─── Cycle 7: 向后兼容（无 scope = legacy） ──────────────────────────────

    it('should work in legacy mode when no scope is provided', async () => {
      class Envs {
        @DatabaseField('string') FIELD: string = 'val';
        APP_CONFIG_SYNC_WRITE_ENABLED: boolean = true;
      }
      const original = new Envs();
      const active = new Envs();
      const mockPrisma = buildScopedMock([]);

      // 不传 options（legacy）
      await AppConfigure.syncFromDB(mockPrisma as any, original as any, active as any);

      expect(mockPrisma.sysAppSetting.createMany).toHaveBeenCalled();
      const createData = (mockPrisma.sysAppSetting.createMany.mock.calls as any[][])[0]![0].data[0];
      expect(createData.scope).toBe('shared');
    });

    // ─── Cycle 9: Scoped 字段无 scope 时 fallback ─────────────────────────

    it('should fallback scoped field to shared when no project scope provided', async () => {
      class Envs {
        @DatabaseField('string', { description: 'model', scoped: true })
        MY_MODEL: string = 'default';
        APP_CONFIG_SYNC_WRITE_ENABLED: boolean = true;
      }
      const original = new Envs();
      const active = new Envs();
      const mockPrisma = buildScopedMock([]);

      // 不传 scope，scoped 字段 fallback 到 shared
      await AppConfigure.syncFromDB(mockPrisma as any, original as any, active as any);

      const createData = (mockPrisma.sysAppSetting.createMany.mock.calls as any[][])[0]![0].data[0];
      expect(createData.scope).toBe('shared');
    });

    // ─── Cycle 10: 元数据更新用复合键 ──────────────────────────────────────

    it('should use compound key (scope + key) for findUnique/update', async () => {
      class Envs {
        @DatabaseField('string', 'New Desc')
        FIELD: string = 'new_default';
        APP_CONFIG_SYNC_WRITE_ENABLED: boolean = true;
      }
      const original = new Envs();
      const active = new Envs();
      const mockPrisma = buildScopedMock([
        {
          key: 'FIELD',
          scope: 'shared',
          value: 'val',
          defaultValue: 'old_default',
          description: 'Old Desc',
          format: 'string',
        },
      ]);

      await AppConfigure.syncFromDB(mockPrisma as any, original as any, active as any, { scope: 'my-project' });

      expect(mockPrisma.sysAppSetting.findUnique).toHaveBeenCalled();
      const findCall = (mockPrisma.sysAppSetting.findUnique.mock.calls as any[][])[0]![0];
      expect(findCall.where.scope_key).toEqual({ scope: 'shared', key: 'FIELD' });
    });

    // ─── Cycle 8: sync() 实例方法传递 scope ──────────────────────────────────

    it('sync() should pass scope to syncFromDB', async () => {
      class TestEnvs extends AbstractEnvironmentVariables {
        @DatabaseField('string')
        KEY: string = 'default';
      }

      const appConfig = new AppConfigure(TestEnvs, false, { scope: 'test-project' });
      const originalSyncFromDB = AppConfigure.syncFromDB;
      const staticSpy = mock(async () => {});
      (AppConfigure as any).syncFromDB = staticSpy;

      try {
        await appConfig.sync({} as any);

        const calls = staticSpy.mock.calls[0] as any[];
        expect(calls[3]).toEqual({ scope: 'test-project' });
      } finally {
        (AppConfigure as any).syncFromDB = originalSyncFromDB;
      }
    });

    // ─── 混合字段场景 ────────────────────────────────────────────────────────

    it('should handle mixed shared + scoped fields correctly', async () => {
      class Envs {
        @DatabaseField('string', 'shared desc')
        SHARED_KEY: string = 'shared-default';

        @DatabaseField('string', { description: 'project-only', scoped: true })
        SCOPED_KEY: string = 'scoped-default';

        APP_CONFIG_SYNC_WRITE_ENABLED: boolean = true;
      }
      const original = new Envs();
      const active = new Envs();
      const mockPrisma = buildScopedMock([]);

      await AppConfigure.syncFromDB(mockPrisma as any, original as any, active as any, { scope: 'ai-persona' });

      expect(mockPrisma.sysAppSetting.createMany).toHaveBeenCalled();
      const createData = (mockPrisma.sysAppSetting.createMany.mock.calls as any[][])[0]![0].data as any[];
      const shared = createData.find((d: any) => d.key === 'SHARED_KEY');
      const scoped = createData.find((d: any) => d.key === 'SCOPED_KEY');
      expect(shared.scope).toBe('shared');
      expect(scoped.scope).toBe('ai-persona');
    });

    it('should read scoped value for scoped field and shared value for shared field', async () => {
      class Envs {
        @DatabaseField('string', 'shared desc')
        SHARED_KEY: string = 'shared-default';

        @DatabaseField('string', { description: 'project-only', scoped: true })
        SCOPED_KEY: string = 'scoped-default';

        APP_CONFIG_SYNC_WRITE_ENABLED: boolean = false;
      }
      const original = new Envs();
      const active = new Envs();
      const mockPrisma = buildScopedMock([
        { key: 'SHARED_KEY', scope: 'shared', value: 'shared-db', format: 'string' },
        { key: 'SCOPED_KEY', scope: 'shared', value: 'shared-scoped-db', format: 'string' },
        { key: 'SCOPED_KEY', scope: 'ai-persona', value: 'project-scoped-db', format: 'string' },
      ]);

      await AppConfigure.syncFromDB(mockPrisma as any, original as any, active as any, { scope: 'ai-persona' });

      expect((active as any).SHARED_KEY).toBe('shared-db');
      expect((active as any).SCOPED_KEY).toBe('project-scoped-db');
    });
  });
});
