/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { AbstractEnvironmentVariables, AppConfigure, DatabaseField } from './configure';

import { describe, expect, it, mock } from 'bun:test';

import 'reflect-metadata';

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
      await AppConfigure.syncFromDB(mockPrisma as any, originalEnvs, activeEnvs);

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

      await AppConfigure.syncFromDB(mockPrisma as any, originalEnvs, activeEnvs);

      // [关键断言] activeEnvs 应该被 DB 的值覆盖
      expect(activeEnvs.TEST_FIELD).toBe('db_override_value');
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
});
