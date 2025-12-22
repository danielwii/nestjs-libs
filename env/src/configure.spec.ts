import { AbstractEnvironmentVariables, AppConfigure, DatabaseField } from './configure';

import { describe, expect, it, mock } from 'bun:test';

import 'reflect-metadata';

import * as os from 'node:os';

import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, validateSync } from 'class-validator';
import * as _ from 'radash';

describe('AppConfigure', () => {
  describe('syncFromDB', () => {
    // 模拟一个配置类
    class TestEnvs {
      @DatabaseField('string', '测试字段')
      TEST_FIELD: string = 'default_code_value';
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

      const createData = (mockPrisma.sysAppSetting.createMany.mock.calls as any[][])[0][0].data[0];

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
      }
      const original = new Envs();
      const active = new Envs();

      const mockPrisma = {
        sysAppSetting: {
          findMany: mock(() =>
            Promise.resolve([
              { key: 'FIELD1', value: 'val', format: 'string' },
              { key: 'ORPHAN', value: 'old', format: 'string', deprecatedAt: null },
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
      const deprecateCall = (mockPrisma.sysAppSetting.updateMany.mock.calls as any[][])[0][0];
      expect(deprecateCall.where.key.in).toContain('ORPHAN');
      expect(deprecateCall.data.deprecatedAt).toBeDefined();
    });

    it('should update metadata if defaults or description change', async () => {
      class Envs {
        @DatabaseField('string', 'New Description')
        FIELD: string = 'new_default';
      }
      const original = new Envs();
      const active = new Envs();

      const mockPrisma = {
        sysAppSetting: {
          findMany: mock(() =>
            Promise.resolve([
              {
                key: 'FIELD',
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
      const updateData = (mockPrisma.sysAppSetting.update.mock.calls as any[][])[0][0].data;
      expect(updateData.defaultValue).toBe('new_default');
      expect(updateData.description).toBe('New Description');
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

      // Spy on the static method
      const staticSpy = mock(async () => {});
      // biome-ignore lint/suspicious/noExplicitAny: Mocking static method
      (AppConfigure as any).syncFromDB = staticSpy;

      await appConfig.sync(mockPrisma as any);

      expect(staticSpy).toHaveBeenCalledTimes(1);
      const calls = staticSpy.mock.calls[0] as any[];
      expect(calls[0]).toBe(mockPrisma);
      // originalVars should be passed
      expect(calls[1]).toEqual(appConfig.originalVars);
      // vars should be passed
      expect(calls[2]).toBe(appConfig.vars);
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
});
