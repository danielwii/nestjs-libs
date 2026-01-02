import { Logger } from '@nestjs/common';

import { errorStack } from '@app/utils/error';
import { f } from '@app/utils/logging';

import { NODE_ENV } from './env';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { config } from '@dotenvx/dotenvx';
import { plainToInstance, Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, validateSync } from 'class-validator';
import JSON5 from 'json5';
import * as _ from 'radash';

import type { TransformFnParams } from 'class-transformer';

export const booleanTransformFn = ({ key, obj }: TransformFnParams) => {
  // Logger.log(f`key: ${{ origin: obj[key] }}`, 'Transform');
  return [true, 'true', '1'].includes(obj[key] as string | boolean);
};
export const objectTransformFn = ({ key, value, obj }: TransformFnParams) => {
  // Logger.log(f`-[Transform]- ${{ key, value, origin: obj[key], isObject: _.isObject(obj[key]) }}`);
  try {
    return _.isObject(obj[key]) ? obj[key] : JSON5.parse((obj[key] as string) || '{}');
  } catch (e: unknown) {
    Logger.error(
      f`#objectTransformFn error ${{ key, value, origin: obj[key], isObject: _.isObject(obj[key]) }} ${e instanceof Error ? e.message : String(e)}`,
      errorStack(e),
      'Transform',
    );
    throw e;
  }
};
export const arrayTransformFn = ({ key, value, obj }: TransformFnParams) => {
  // Logger.log(f`-[Transform]- ${{ key, value, origin: obj[key], isArray: _.isArray(obj[key]) }}`);
  try {
    return _.isArray(obj[key]) ? obj[key] : JSON5.parse((obj[key] as string) || '[]');
  } catch (e: unknown) {
    Logger.error(
      f`#arrayTransformFn error ${{ key, value, origin: obj[key], isArray: _.isArray(obj[key]) }} ${e instanceof Error ? e.message : String(e)}`,
      errorStack(e),
      'Transform',
    );
    throw e;
  }
};

type HostSetVariables = {};

/**
 * Configure 模块调试日志开关
 *
 * 设计意图：
 * - 默认关闭，减少启动时的日志噪音（DatabaseField found、env 文件路径、配置项值等）
 * - 开发调试配置问题时可通过 CONFIGURE_DEBUG=true 开启
 * - 错误和警告日志不受此开关影响，始终输出
 *
 * 使用场景：
 * - 排查环境变量加载顺序问题
 * - 确认 DatabaseField 字段是否正确注册
 * - 调试配置验证失败的原因
 */
const isConfigureDebugEnabled = () => process.env.CONFIGURE_DEBUG === 'true';

const DatabaseFieldSymbol = Symbol('DatabaseField');
const DatabaseFieldFormatSymbol = Symbol('DatabaseFieldFormat');
const DatabaseFieldDescriptionSymbol = Symbol('DatabaseFieldDescription');

// ==================== LLM Model Field ====================

const llmModelFields = new Set<string>();

/**
 * 标记字段为 LLM Model 配置
 *
 * 被标记的字段会在启动时自动验证：
 * - Model 是否已注册
 * - 对应 Provider 的 API Key 是否已配置
 *
 * @example
 * @LLMModelField()
 * @IsString() @IsOptional()
 * DEFAULT_LLM_MODEL?: string = 'openrouter:gemini-2.5-flash';
 *
 * @LLMModelField()
 * @IsString() @IsOptional()
 * I18N_LLM_MODEL?: string;
 */
export function LLMModelField(): PropertyDecorator {
  return (target, propertyKey) => {
    llmModelFields.add(propertyKey as string);
    if (isConfigureDebugEnabled()) {
      Logger.verbose(`[LLMModelField] registered: ${String(propertyKey)}`, 'Configure');
    }
  };
}

/**
 * 获取所有标记为 @LLMModelField 的字段名
 */
export function getLLMModelFields(): string[] {
  return Array.from(llmModelFields);
}
/**
 * 标记字段是否需要同步到数据库, 用于配置项的动态更新, 默认为空的字段需要赋值为 undefined 才能进行同步
 * @param format 字段格式
 * @param description 字段描述
 * @constructor
 */
export const DatabaseField =
  (format: 'string' | 'number' | 'boolean' | 'json' = 'string', description?: string) =>
  (target: object, propertyKey: string) => {
    if (isConfigureDebugEnabled()) {
      Logger.verbose(f`found ${propertyKey}:${format}${description ? ` (${description})` : ''}`, 'DatabaseField');
    }
    Reflect.defineMetadata(DatabaseFieldSymbol, true, target, propertyKey);
    Reflect.defineMetadata(DatabaseFieldFormatSymbol, format, target, propertyKey);
    if (description) {
      Reflect.defineMetadata(DatabaseFieldDescriptionSymbol, description, target, propertyKey);
    }
    if (format === 'boolean') {
      Transform(booleanTransformFn)(target, propertyKey);
      IsBoolean()(target, propertyKey);
      IsOptional()(target, propertyKey);
    }
  };

export class AbstractEnvironmentVariables implements HostSetVariables {
  private readonly logger = new Logger(this.constructor.name);
  private readonly hostname = os.hostname();

  // use doppler env instead
  @IsEnum(['prd', 'stg', 'dev']) @IsOptional() ENV?: 'prd' | 'stg' | 'dev';

  @IsEnum(NODE_ENV) NODE_ENV: NODE_ENV = NODE_ENV.Development;

  get isNodeDevelopment() {
    return process.env.NODE_ENV === 'development';
  }

  // 使用 @Type(() => Number) 显式指定类型转换
  // 原因：
  // 1. 环境变量中的值都是字符串类型
  // 2. TypeScript 的类型信息在编译后会丢失
  // 3. 需要显式告诉 class-transformer 如何转换类型
  // 4. 这样可以确保在所有环境下（如 bun mastra dev）都能正确转换
  @Type(() => Number) @IsNumber() @IsOptional() PORT: number = 3100;
  @Type(() => Number) @IsNumber() @IsOptional() GRPC_PORT: number = 50051;
  @IsString() TZ = 'UTC';

  // 因为 有些服务器的 hostname 是 localhost，所以需要添加一个随机数来区分
  get NODE_NAME() {
    return os.hostname() === 'localhost' ? `localhost-${Date.now()}:${this.PORT}` : `${os.hostname()}:${this.PORT}`;
  }

  @IsEnum(['verbose', 'debug', 'log', 'warn', 'error', 'fatal'])
  LOG_LEVEL: 'verbose' | 'debug' | 'log' | 'warn' | 'error' | 'fatal' = 'log';

  @DatabaseField(
    'string',
    '系统API密钥，仅用于验证系统级内部API请求，不自行设置的话每次启动都会变更，注意: 不要外部使用',
  )
  @IsString()
  @IsOptional()
  API_KEY?: string = undefined;

  // used to debug dependency issues
  @IsString() @IsOptional() NEST_DEBUG?: string;

  @IsString() @IsOptional() DOPPLER_ENVIRONMENT?: string;

  @IsString() @IsOptional() SESSION_SECRET?: string;

  @IsBoolean() @IsOptional() @Transform(booleanTransformFn) TRACING_ENABLED?: boolean = true;
  @IsString() @IsOptional() SERVICE_NAME?: string;
  @IsString() @IsOptional() TRACING_EXPORTER_URL?: string;

  @IsBoolean() @IsOptional() @Transform(booleanTransformFn) APP_PROXY_ENABLED?: boolean;
  @IsString() @IsOptional() APP_PROXY_HOST?: string;
  @Type(() => Number) @IsNumber() @IsOptional() APP_PROXY_PORT?: number;

  // ==================== LLM ====================
  @IsString() @IsOptional() OPENROUTER_API_KEY?: string;
  @IsString() @IsOptional() GOOGLE_GENERATIVE_AI_API_KEY?: string;
  @IsString() @IsOptional() OPENAI_API_KEY?: string;
  /** 默认 LLM 模型，当指定模型不存在时作为 fallback（仅生产环境） */
  @LLMModelField() @IsString() @IsOptional() DEFAULT_LLM_MODEL?: string = 'openrouter:gemini-2.5-flash';

  @IsString() @IsOptional() INFRA_REDIS_URL?: string;
  @IsString() DATABASE_URL!: string;
  @IsBoolean() @IsOptional() @Transform(booleanTransformFn) PRISMA_QUERY_LOGGER?: boolean;
  @IsBoolean() @IsOptional() @Transform(booleanTransformFn) PRISMA_QUERY_LOGGER_WITH_PARAMS?: boolean;
  @IsBoolean() @IsOptional() @Transform(booleanTransformFn) PRISMA_MIGRATION?: boolean;
  @DatabaseField('number', 'Prisma 事务超时时间（毫秒）') @IsNumber() PRISMA_TRANSACTION_TIMEOUT: number = 30_000;

  /**
   * 是否启用异常处理器的 I18n 翻译功能
   * 【设计意图】
   * - GraphQL 上下文中获取 I18nService 会触发 NestJS ExceptionsZone 异常传播导致应用崩溃
   * - 该功能非核心，失败时应降级到原始消息而非崩溃
   * - 默认禁用，等 I18nService 在所有上下文中可用后再启用
   */
  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    return false;
  })
  @DatabaseField('boolean', '是否启用异常处理器的 I18n 翻译功能')
  I18N_EXCEPTION_ENABLED?: boolean = false;

  // 是否在遇到 uncaughtException 或 unhandledRejection 时自动退出进程
  @IsBoolean() @Transform(booleanTransformFn) EXIT_ON_ERROR: boolean = true;

  /**
   * 优雅关闭时等待进行中请求完成的超时时间（毫秒）
   *
   * 设计意图：
   * - SIGTERM 收到后，先停止接收新连接，然后等待现有请求完成
   * - 超过此时间后强制关闭，避免无限等待
   * - 应小于 K8s terminationGracePeriodSeconds 减去 preStop 延迟
   *
   * 计算公式：IN_FLIGHT_TIMEOUT_MS < terminationGracePeriodSeconds - preStop sleep
   * 当前配置：terminationGracePeriodSeconds=90s, preStop=10s → IN_FLIGHT_TIMEOUT_MS < 80s
   * 默认：60s（支持最长 1 分钟的请求如 chat API）
   */
  @Type(() => Number) @IsNumber() @IsOptional() IN_FLIGHT_TIMEOUT_MS: number = 60_000;

  get environment() {
    const env = this.ENV || this.DOPPLER_ENVIRONMENT || 'dev';
    const isProd = env === 'prd';
    return {
      env,
      isProd,
    };
  }

  static get allFields() {
    const instance = new AbstractEnvironmentVariables();
    return Object.getOwnPropertyNames(instance);
  }

  /**
   * Retrieves the value of a specified field based on the hostname of the current system.
   *
   * @template F - The type of the field to retrieve
   * @param {F} field - The field to retrieve the value from
   * @param {HostSetVariables[F][0] | boolean} [fallback] - The fallback value to use if the retrieval fails
   * @returns {HostSetVariables[F][0]} - The retrieved value of the specified field
   */
  // getByHost<F extends keyof HostSetVariables>(
  //   field: F,
  //   fallback?: HostSetVariables[F][0] | boolean,
  // ): HostSetVariables[F][0] | boolean | undefined {
  //   try {
  //     const index = this.hostIndex;
  //     if (_.isNullish(index)) {
  //       this.logger.warn(f`#getByHost (${this.hostname}) ${{ field, index }}`);
  //       return _.isBoolean(fallback) ? _.pathOr(this, [field, 0]) : fallback;
  //     }
  //     this.logger.verbose(f`#getByHost (${this.hostname}) ${{ field, index }}`);
  //     return _.isBoolean(fallback)
  //       ? (_.prop(this[field], index) ?? _.pathOr(this, [field, 0]))
  //       : (_.prop(this[field], index) ?? fallback);
  //   } catch (e: unknown) {
  //     this.logger.error(
  //       f`#getByHost (${this.hostname}) ${field} ${e instanceof Error ? e.message : String(e)}`,
  //       onelineStackFromError(e),
  //     );
  //     return _.isBoolean(fallback) ? _.pathOr(this, [field, 0]) : fallback;
  //   }
  // }

  get hostIndex() {
    const part = this.hostname.split('-').pop();
    const index = typeof part === 'string' ? +part : null;
    return typeof index === 'number' && !isNaN(index) ? index : null;
  }

  /**
   * Retrieves the unique host based on the specified host ID and accept policy.
   *
   * @param {Object} options - The options for retrieving the unique host.
   * @param {number} options.hostId - The host ID to compare with the current host.
   * @param {boolean} options.acceptWhenNoIds - Specifies whether to accept when there are no host IDs available.
   * @returns {boolean} - True if the host ID matches the current host, or if there are no host IDs available and the accepted policy allows it. False otherwise.
   */
  getUniqueHost({
    hostId,
    acceptWhenNoIds,
    key,
  }: {
    hostId?: number;
    acceptWhenNoIds?: boolean;
    key: string;
  }): boolean {
    try {
      const host = hostId ?? 0;
      this.hostKeys[host] = [...(this.hostKeys[host] ?? []), key];
      const index = this.hostIndex;
      const on = index == null ? !!acceptWhenNoIds : index === host;
      this.logger.debug(f`#getUniqueHost (${this.hostname}) ${{ key }} ${{ host, index, acceptWhenNoIds, on }}`);
      return on;
    } catch (_e: unknown) {
      this.logger.warn(f`#getUniqueHost no hostIndex for ${this.hostname}`, 'AppConfigure');
    }
    return !!acceptWhenNoIds;
  }

  hostKeys: Record<number, Array<string>> = {};
}

export interface ISysAppSettingRecord {
  key: string;
  value: string | null;
  defaultValue: string | null;
  format: string;
  description?: string | null;
  deprecatedAt?: Date | null;
}

export interface ISysAppSettingClient {
  sysAppSetting: {
    findMany(): Promise<ISysAppSettingRecord[]>;
    updateMany(args: {
      where: { key: { in: string[] } };
      data: { deprecatedAt: Date | null };
    }): Promise<{ count: number }>;
    createMany(args: {
      data: Array<{ key: string; defaultValue: string | null; format: string; description?: string | null }>;
      skipDuplicates?: boolean;
    }): Promise<{ count: number }>;
    findUnique(args: { where: { key: string } }): Promise<ISysAppSettingRecord | null>;
    create(args: {
      data: {
        key: string;
        value: string | null;
        defaultValue: string | null;
        format: string;
        description?: string | null;
      };
    }): Promise<ISysAppSettingRecord>;
    update(args: {
      where: { key: string };
      data: { defaultValue?: string | null; description?: string | null; deprecatedAt?: Date | null };
    }): Promise<ISysAppSettingRecord>;
  };
}

export class AppConfigure<T extends AbstractEnvironmentVariables> {
  private readonly logger = new Logger(this.constructor.name);

  public readonly vars: T;
  public readonly originalVars: T; // 添加原始副本

  /**
   * Order of precedence:
   * process.env
   * .env.$(NODE_ENV).local
   * .env.local (Not checked when NODE_ENV is test.)
   * .env.$(NODE_ENV)
   * .env
   * @param EnvsClass
   */
  constructor(
    readonly EnvsClass: new () => T,
    private readonly sys = false,
  ) {
    const envFilePath = (() => {
      switch (process.env.NODE_ENV) {
        case NODE_ENV.Test:
          // 测试环境应保持隔离：不要加载开发者本地的 `.env.local`（可能包含代理/证书等本机配置，甚至干扰解析）。
          // 允许使用可选的 `.env.test.local` 覆盖测试配置。
          return ['.env.test.local', '.env.test'];
        case NODE_ENV.Production:
          return ['.env.local', '.env'];
        default:
          return ['.env.development.local', '.env.local', '.env.development', '.env'];
      }
    })();

    if (this.sys && isConfigureDebugEnabled()) this.logger.log(f`load env from paths: ${envFilePath}`);
    envFilePath.forEach((env) => {
      // 使用 process.env.PWD 而不是 process.cwd() 的原因：
      // 1. process.cwd() 在 monorepo 项目中可能会指向子目录（如 .mastra/output）
      // 2. process.env.PWD 会保持原始的工作目录，即项目根目录
      // 3. 这样可以确保 .env 文件从正确的项目根目录加载，而不是从构建输出目录加载
      const fullPath = path.resolve(process.env.PWD || '', env);
      if (this.sys && isConfigureDebugEnabled()) this.logger.log(f`envFilePath: ${fullPath}`);
      // dotenvx 对于缺失文件会输出一条 “injecting env (0)” 的噪音日志（即使配置了 ignore MISSING_ENV_FILE）。
      // 这里主动跳过不存在的文件，保持启动/测试输出干净。
      if (!fs.existsSync(fullPath)) {
        return;
      }
      config({ path: fullPath, override: false, ignore: ['MISSING_ENV_FILE'] });
    });
    this.vars = this.validate();
    this.originalVars = structuredClone(this.vars); // 创建副本
  }

  private validate() {
    const config = process.env;
    const validatedConfig = plainToInstance(this.EnvsClass, config, {
      enableImplicitConversion: true,
    });

    if (process.env.NODE_ENV !== NODE_ENV.Test) {
      const errors = validateSync(validatedConfig, {
        skipMissingProperties: false,
      });

      if (errors.length > 0) {
        this.logger.warn(`[${this.sys ? 'SYS' : 'App'}] Configure these configs are not valid`);
        console.log(errors.map((e) => `${e.property}=`).join('\n'));
        throw new Error(errors.map((e) => e.property).join(', '));
      }

      // 配置项输出（仅在 CONFIGURE_DEBUG=true 时启用）
      if (isConfigureDebugEnabled()) {
        if (this.sys) {
          // display all envs not includes _ENABLE and not starts with APP_
          Object.entries(validatedConfig as object).forEach(([key, value]) => {
            if (
              key.includes('_ENABLE') ||
              key.startsWith('APP_') ||
              !AbstractEnvironmentVariables.allFields.includes(key) ||
              ['logger'].includes(key)
            )
              return;
            const isDatabaseField = Reflect.getMetadata(
              DatabaseFieldSymbol,
              AbstractEnvironmentVariables.prototype,
              key,
            );
            this.logger.log(f`[SYS] ${isDatabaseField ? '<- DB -> ' : ''}${{ key, value }}`);
          });
        }

        Object.entries(validatedConfig as object).forEach(([key, value]) => {
          if (!this.sys && !Object.getOwnPropertyNames(AbstractEnvironmentVariables.prototype).includes(key)) return; // exclude sys envs
          const isDatabaseField = Reflect.getMetadata(DatabaseFieldSymbol, AbstractEnvironmentVariables.prototype, key);
          if (key.includes('_ENABLE'))
            this.logger.log(
              f`[${this.sys ? 'SYS' : 'App'}] ${isDatabaseField ? '<- DB -> ' : ''}${{ key, value /* origin: config[key] */ }}`,
            );
        });
        Object.entries(validatedConfig as object).forEach(([key, value]) => {
          if (!this.sys && !Object.getOwnPropertyNames(AbstractEnvironmentVariables.prototype).includes(key)) return; // exclude sys envs
          const isDatabaseField = Reflect.getMetadata(DatabaseFieldSymbol, AbstractEnvironmentVariables.prototype, key);
          if (key.startsWith('APP_'))
            this.logger.log(
              f`[${this.sys ? 'SYS' : 'App'}] ${isDatabaseField ? '<- DB -> ' : ''}${{ key, value /* origin: config[key] */ }}`,
            );
        });
      }
    }
    if (isConfigureDebugEnabled()) {
      Logger.verbose(f`[${this.sys ? 'SYS' : 'App'}] Configure validated`, 'Configure');
    }
    return validatedConfig;
  }

  async sync(prisma: ISysAppSettingClient) {
    await AppConfigure.syncFromDB(prisma, this.originalVars, this.vars);
  }

  static async syncFromDB<T extends object>(prisma: ISysAppSettingClient, originalEnvs: T, activeEnvs: T) {
    const fields = Object.getOwnPropertyNames(originalEnvs)
      .map((field) => {
        const isDatabaseField = Reflect.getMetadata(DatabaseFieldSymbol, originalEnvs, field);
        const format = Reflect.getMetadata(DatabaseFieldFormatSymbol, originalEnvs, field);
        const description = Reflect.getMetadata(DatabaseFieldDescriptionSymbol, originalEnvs, field);

        return {
          field,
          isDatabaseField,
          format,
          description,
          defaultValue: (originalEnvs as Record<string, unknown>)[field], // 用于写 DB (Env Value)
          value: (activeEnvs as Record<string, unknown>)[field], // 用于读 DB (可能已经被污染，但这里我们只用它来做 log)
        };
      })
      .filter(({ isDatabaseField }) => !!isDatabaseField);

    // 仅在有变更时才打印详细日志，避免每次同步都输出大量重复信息
    Logger.debug(f`#syncFromDB... reload app settings from db.`, 'AppConfigure');
    const appSettings = (await prisma.sysAppSetting.findMany()).map(({ value, format, ...rest }) =>
      /**/
      ({ ...rest, value: format !== 'string' && value != null ? JSON.parse(value) : value, format }),
    ) as Array<{
      key: string;
      defaultValue: unknown;
      format: string;
      description?: string;
      value: unknown;
      deprecatedAt?: Date | null;
    }>;

    const fieldNamesInCode = fields.map((f) => f.field);
    const fieldNamesInDB = appSettings.map((s) => s.key);

    // =====================================================
    // 软删除：标记数据库中存在但代码中已删除的配置为 deprecated
    // 设计意图：
    // - 不物理删除，保留历史数据和配置值
    // - 便于审计和回滚（如果配置被误删除）
    // - 定期清理可由 DBA 或定时任务执行
    // =====================================================
    const orphanSettings = appSettings.filter((s) => !fieldNamesInCode.includes(s.key) && !s.deprecatedAt);
    if (orphanSettings.length > 0) {
      Logger.log(
        f`#syncFromDB 标记 ${orphanSettings.length} 个废弃配置: ${orphanSettings.map((s) => s.key).join(', ')}`,
        'AppConfigure',
      );
      await prisma.sysAppSetting.updateMany({
        where: { key: { in: orphanSettings.map((s) => s.key) } },
        data: { deprecatedAt: new Date() },
      });
    }

    // 恢复：如果配置被重新添加到代码中，清除 deprecatedAt 标记
    const restoredSettings = appSettings.filter((s) => fieldNamesInCode.includes(s.key) && Boolean(s.deprecatedAt));
    if (restoredSettings.length > 0) {
      Logger.log(
        f`#syncFromDB 恢复 ${restoredSettings.length} 个配置: ${restoredSettings.map((s) => s.key).join(', ')}`,
        'AppConfigure',
      );
      await prisma.sysAppSetting.updateMany({
        where: { key: { in: restoredSettings.map((s) => s.key) } },
        data: { deprecatedAt: null },
      });
    }

    // 如何 appSettings 中不存在，则用当前的值更新
    const nonExistsFields = fields.filter(({ field }) => !fieldNamesInDB.includes(field));

    if (nonExistsFields.length > 0) {
      Logger.log(f`#syncFromDB 创建 ${nonExistsFields.length} 个新配置字段...`, 'AppConfigure');
      await prisma.sysAppSetting.createMany({
        data: nonExistsFields.map(({ field, format, description, defaultValue }) => {
          const defaultVal =
            defaultValue !== undefined
              ? typeof defaultValue === 'string'
                ? defaultValue
                : JSON.stringify(defaultValue)
              : null;

          const newVar = {
            key: field,
            value: null, // 新记录初始值为空，由 Env 决定
            defaultValue: defaultVal,
            format: format as string,
            description: description as string | null,
          };
          Logger.log(f`#syncFromDB 创建配置: ${field} (默认值: ${defaultVal})`, 'AppConfigure');
          return newVar;
        }),
        skipDuplicates: true,
      });
    }

    // 如何 appSettings 中存在，则用当前的值更新 envs
    const existsFields = fields.filter(({ field }) => fieldNamesInDB.includes(field));

    for (const { field, value, defaultValue, description, format } of existsFields) {
      const appSetting = appSettings.find((setting) => setting.key === field);
      if (!appSetting) {
        Logger.warn(f`#syncFromDB appSetting not found for ${field}`, 'AppConfigure');
        continue;
      }

      const dbValue = appSetting.value;
      const equal = _.isEqual(value, dbValue);

      // 更新环境变量值 (用 DB Value覆盖内存里的 activeEnvs)
      if (appSetting.value != null && !equal) {
        Logger.log(f`#syncFromDB 配置覆盖: ${field} = "${value}" -> "${dbValue}"`, 'AppConfigure');
        (activeEnvs as Record<string, unknown>)[field] = dbValue;
      }

      // 检查并更新默认值和描述 (始终以 originalEnvs 为准)
      const updates: { defaultValue?: string; description?: string } = {};
      const valueToStore =
        defaultValue !== undefined
          ? typeof defaultValue === 'string'
            ? defaultValue
            : JSON.stringify(defaultValue)
          : null;

      // 如果默认值不一样，需要更新
      if (appSetting.defaultValue !== valueToStore && valueToStore !== null) {
        updates.defaultValue = valueToStore;
      }

      // 如果描述存在并且与数据库中的不同，需要更新
      if (description && description !== appSetting.description) {
        updates.description = description;
      }

      // 执行更新
      if (!_.isEmpty(updates)) {
        Logger.log(f`#syncFromDB 更新元数据: ${field} ${JSON.stringify(updates)}`, 'AppConfigure');
        try {
          // 首先检查记录是否存在
          const existingRecord = await prisma.sysAppSetting.findUnique({
            where: { key: field },
          });

          if (!existingRecord) {
            Logger.warn(f`#syncFromDB record not found for update: ${field}`, 'AppConfigure');
            // 记录不存在，创建新记录
            await prisma.sysAppSetting.create({
              data: {
                key: field,
                value: null, // 新记录初始值为空
                defaultValue: updates.defaultValue ?? null,
                format: format as string,
                description: updates.description ?? null,
              },
            });
            Logger.log(f`#syncFromDB created record for ${field} since it didn't exist`, 'AppConfigure');
          } else {
            // 记录存在，执行更新
            await prisma.sysAppSetting.update({
              where: { key: field },
              data: updates,
            });
            Logger.log(f`#syncFromDB successfully updated metadata for ${field}`, 'AppConfigure');
          }
        } catch (error: unknown) {
          Logger.error(
            f`#syncFromDB failed to update metadata for ${field}: ${error instanceof Error ? error.message : String(error)}`,
            error instanceof Error ? error.stack : undefined,
            'AppConfigure',
          );
        }
      }
    }
  }
}

export const SysEnv = new AppConfigure(AbstractEnvironmentVariables, true).vars;
