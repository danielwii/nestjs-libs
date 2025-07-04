import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, validateSync } from 'class-validator';
import { plainToInstance, Transform, TransformFnParams, Type } from 'class-transformer';
import { Logger } from '@nestjs/common';
import * as R from 'remeda';
import JSON from 'json5';
import path from 'path';
import _ from 'lodash';

import { f, onelineStackFromError } from '@app/utils/utils';
import { config } from '@dotenvx/dotenvx';
import { NODE_ENV } from './env';
import os from 'node:os';

export const booleanTransformFn = ({ key, obj }: TransformFnParams) => {
  // Logger.log(f`key: ${{ origin: obj[key] }}`, 'Transform');
  return [true, 'true', '1'].includes(obj[key]);
};
export const objectTransformFn = ({ key, value, obj }: TransformFnParams) => {
  // Logger.log(f`-[Transform]- ${{ key, value, origin: obj[key], isObject: _.isObject(obj[key]) }}`);
  try {
    return _.isObject(obj[key]) ? obj[key] : JSON.parse(obj[key] || '{}');
  } catch (e: unknown) {
    Logger.error(
      f`#objectTransformFn error ${{ key, value, origin: obj[key], isObject: _.isObject(obj[key]) }} ${e instanceof Error ? e.message : String(e)}`,
      onelineStackFromError(e),
      'Transform',
    );
    throw e;
  }
};
export const arrayTransformFn = ({ key, value, obj }: TransformFnParams) => {
  // Logger.log(f`-[Transform]- ${{ key, value, origin: obj[key], isArray: _.isArray(obj[key]) }}`);
  try {
    return _.isArray(obj[key]) ? obj[key] : JSON.parse(obj[key] || '[]');
  } catch (e: unknown) {
    Logger.error(
      f`#arrayTransformFn error ${{ key, value, origin: obj[key], isArray: _.isArray(obj[key]) }} ${e instanceof Error ? e.message : String(e)}`,
      onelineStackFromError(e),
      'Transform',
    );
    throw e;
  }
};

interface HostSetVariables {}

const DatabaseFieldSymbol = Symbol('DatabaseField');
const DatabaseFieldFormatSymbol = Symbol('DatabaseFieldFormat');
const DatabaseFieldDescriptionSymbol = Symbol('DatabaseFieldDescription');
/**
 * 标记字段是否需要同步到数据库, 用于配置项的动态更新, 默认为空的字段需要赋值为 undefined 才能进行同步
 * @param format 字段格式
 * @param description 字段描述
 * @constructor
 */
export const DatabaseField =
  (format: 'string' | 'number' | 'boolean' | 'json' = 'string', description?: string) =>
  (target: any, propertyKey: string) => {
    Logger.verbose(f`found ${propertyKey}:${format}${description ? ` (${description})` : ''}`, 'DatabaseField');
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

  // 使用 @Type(() => Number) 显式指定类型转换
  // 原因：
  // 1. 环境变量中的值都是字符串类型
  // 2. TypeScript 的类型信息在编译后会丢失
  // 3. 需要显式告诉 class-transformer 如何转换类型
  // 4. 这样可以确保在所有环境下（如 bun mastra dev）都能正确转换
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  PORT: number = 3100;
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

  @IsBoolean()
  @IsOptional()
  @Transform(booleanTransformFn)
  TRACING_ENABLED?: boolean = true;
  @IsString() @IsOptional() SERVICE_NAME?: string;
  @IsString() @IsOptional() TRACING_EXPORTER_URL?: string;

  @IsBoolean() @IsOptional() @Transform(booleanTransformFn) APP_PROXY_ENABLED?: boolean;
  @IsString() @IsOptional() APP_PROXY_HOST?: string;
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  APP_PROXY_PORT?: number;

  @IsString() DATABASE_URL!: string;
  @IsBoolean() @IsOptional() @Transform(booleanTransformFn) PRISMA_QUERY_LOGGER?: boolean;
  @IsBoolean() @IsOptional() @Transform(booleanTransformFn) PRISMA_QUERY_LOGGER_WITH_PARAMS?: boolean;
  @IsBoolean() @IsOptional() @Transform(booleanTransformFn) PRISMA_MIGRATION?: boolean;
  @DatabaseField('number', 'Prisma 事务超时时间（毫秒）') @IsNumber() PRISMA_TRANSACTION_TIMEOUT: number = 30_000;

  // 是否在遇到 uncaughtException 或 unhandledRejection 时自动退出进程
  @IsBoolean() @Transform(booleanTransformFn) EXIT_ON_ERROR: boolean = true;

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
  //       return _.isBoolean(fallback) ? _.pathOr(this as any, [field, 0]) : fallback;
  //     }
  //     this.logger.verbose(f`#getByHost (${this.hostname}) ${{ field, index }}`);
  //     return _.isBoolean(fallback)
  //       ? (_.prop(this[field], index) ?? _.pathOr(this as any, [field, 0]))
  //       : (_.prop(this[field], index) ?? fallback);
  //   } catch (e: unknown) {
  //     this.logger.error(
  //       f`#getByHost (${this.hostname}) ${field} ${e instanceof Error ? e.message : String(e)}`,
  //       onelineStackFromError(e),
  //     );
  //     return _.isBoolean(fallback) ? _.pathOr(this as any, [field, 0]) : fallback;
  //   }
  // }

  get hostIndex() {
    const part = this.hostname.split('-').pop();
    return R.isString(part) ? +part : null;
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
      this.hostKeys[host] = R.concat(this.hostKeys[host] ?? [], [key]);
      const index = this.hostIndex;
      const on = R.isNullish(index) ? !!acceptWhenNoIds : index === host;
      this.logger.debug(f`#getUniqueHost (${this.hostname}) ${{ key }} ${{ host, index, acceptWhenNoIds, on }}`);
      return on;
    } catch (e: unknown) {
      this.logger.warn(f`#getUniqueHost no hostIndex for ${this.hostname}`, 'AppConfigure');
    }
    return !!acceptWhenNoIds;
  }

  hostKeys: Record<number, Array<string>> = {};
}

export class AppConfigure<T extends AbstractEnvironmentVariables> {
  private readonly logger = new Logger(this.constructor.name);

  public readonly vars: T;

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
          return ['.env.local', '.env.test'];
        case NODE_ENV.Production:
          return ['.env.local', '.env'];
        default:
          return ['.env.development.local', '.env.local', '.env.development', '.env'];
      }
    })();

    if (this.sys) this.logger.log(f`load env from paths: ${envFilePath}`);
    R.forEach(envFilePath, (env) => {
      // 使用 process.env.PWD 而不是 process.cwd() 的原因：
      // 1. process.cwd() 在 monorepo 项目中可能会指向子目录（如 .mastra/output）
      // 2. process.env.PWD 会保持原始的工作目录，即项目根目录
      // 3. 这样可以确保 .env 文件从正确的项目根目录加载，而不是从构建输出目录加载
      const fullPath = path.resolve(process.env.PWD || '', env);
      if (this.sys) this.logger.log(f`envFilePath: ${fullPath}`);
      config({ path: fullPath, override: false, ignore: ['MISSING_ENV_FILE'] });
    });
    this.vars = this.validate();
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
        console.log(R.map(errors, (e) => `${e.property}=`).join('\n'));
        throw new Error(errors.toString());
      }

      if (this.sys) {
        // display all envs not includes _ENABLE and not starts with APP_
        R.forEachObj(validatedConfig, (value, key) => {
          if (
            key.includes('_ENABLE') ||
            key.startsWith('APP_') ||
            !R.isIncludedIn(key as string, AbstractEnvironmentVariables.allFields) ||
            ['logger'].includes(key)
          )
            return;
          const isDatabaseField = Reflect.getMetadata(DatabaseFieldSymbol, AbstractEnvironmentVariables.prototype, key);
          this.logger.log(f`[SYS] ${isDatabaseField ? '<- DB -> ' : ''}${{ key, value }}`);
        });
      }

      R.forEachObj(validatedConfig, (value, key) => {
        if (
          !this.sys &&
          !R.isIncludedIn(key as string, Object.getOwnPropertyNames(AbstractEnvironmentVariables.prototype))
        )
          return; // exclude sys envs
        const isDatabaseField = Reflect.getMetadata(DatabaseFieldSymbol, AbstractEnvironmentVariables.prototype, key);
        if (key.includes('_ENABLE'))
          this.logger.log(
            f`[${this.sys ? 'SYS' : 'App'}] ${isDatabaseField ? '<- DB -> ' : ''}${{ key, value /* origin: config[key] */ }}`,
          );
      });
      R.forEachObj(validatedConfig, (value, key) => {
        if (
          !this.sys &&
          !R.isIncludedIn(key as string, Object.getOwnPropertyNames(AbstractEnvironmentVariables.prototype))
        )
          return; // exclude sys envs
        const isDatabaseField = Reflect.getMetadata(DatabaseFieldSymbol, AbstractEnvironmentVariables.prototype, key);
        if (key.startsWith('APP_'))
          this.logger.log(
            f`[${this.sys ? 'SYS' : 'App'}] ${isDatabaseField ? '<- DB -> ' : ''}${{ key, value /* origin: config[key] */ }}`,
          );
      });
    }
    Logger.verbose(f`[${this.sys ? 'SYS' : 'App'}] Configure validated`, 'Configure');
    return validatedConfig;
  }

  static async syncFromDB(prisma: any, envs: Record<string, any>) {
    const fields = R.pipe(
      Object.getOwnPropertyNames(envs),
      R.map((field) => {
        const isDatabaseField = Reflect.getMetadata(DatabaseFieldSymbol, envs, field);
        const format = Reflect.getMetadata(DatabaseFieldFormatSymbol, envs, field);
        const description = Reflect.getMetadata(DatabaseFieldDescriptionSymbol, envs, field);

        // 添加详细日志，特别关注 DEFAULT_LLM_MODEL
        if (field === 'DEFAULT_LLM_MODEL') {
          Logger.log(
            f`#syncFromDB metadata for DEFAULT_LLM_MODEL: ${{
              isDatabaseField,
              format,
              description,
              value: envs[field],
            }}`,
            'AppConfigure',
          );
        }

        return { field, isDatabaseField, format, description, value: envs[field] };
      }),
      R.filter(({ isDatabaseField }) => !!isDatabaseField),
    );

    // 添加所有待同步字段的详细日志
    Logger.debug(f`#syncFromDB fields to sync: ${fields}`, 'AppConfigure');

    Logger.debug(f`#syncFromDB... reload app settings from db.`, 'AppConfigure');
    const appSettings = R.map(await prisma.sysAppSetting.findMany(), ({ value, format, ...rest }) =>
      /**/
      ({ ...rest, value: format !== 'string' ? JSON.parse(value) : value, format }),
    ) as Array<{ key: string; defaultValue: unknown; format: string; description?: string; value: unknown }>;

    // 添加数据库中所有设置的详细日志
    Logger.debug(f`#syncFromDB appSettings from DB: ${appSettings}`, 'AppConfigure');

    const fieldNamesInDB = R.map(appSettings, (s) => s.key);
    // 如何 appSettings 中不存在，则用当前的值更新
    const nonExistsFields = R.filter(fields, ({ field }) => !fieldNamesInDB.includes(field));
    Logger.debug(f`#syncFromDB nonExistsFields: ${nonExistsFields}`, 'AppConfigure');

    if (nonExistsFields.length) {
      Logger.debug(f`#syncFromDB creating ${nonExistsFields.length} new fields...`, 'AppConfigure');
      await prisma.sysAppSetting.createMany({
        data: nonExistsFields.map(({ field, format, description }) => {
          const value = format === 'string' ? envs[field] : JSON.stringify(envs[field]);
          const newVar = {
            key: field,
            defaultValue: value,
            format,
            description,
          };
          Logger.verbose(f`#syncFromDB create... ${newVar}`, 'AppConfigure');
          return newVar;
        }),
        skipDuplicates: true,
      });
    }

    // 如何 appSettings 中存在，则用当前的值更新 envs
    const existsFields = R.filter(fields, ({ field }) => fieldNamesInDB.includes(field));
    Logger.debug(f`#syncFromDB existsFields count: ${existsFields.length}`, 'AppConfigure');

    for (const { field, value, description, format } of existsFields) {
      const appSetting = R.find(appSettings, (setting) => setting.key === field);
      if (!appSetting) {
        Logger.warn(f`#syncFromDB appSetting not found for ${field}`, 'AppConfigure');
        continue;
      }

      // 添加详细信息日志，特别是对 DEFAULT_LLM_MODEL
      if (field === 'DEFAULT_LLM_MODEL') {
        Logger.log(
          f`#syncFromDB DEFAULT_LLM_MODEL details: ${{
            field,
            value,
            description,
            format,
            appSetting_value: appSetting.value,
            appSetting_defaultValue: appSetting.defaultValue,
            appSetting_description: appSetting.description,
          }}`,
          'AppConfigure',
        );
      }

      const dbValue = appSetting.value;
      const equal = R.isDeepEqual(value, dbValue);

      // 更新环境变量值
      if (!R.isNullish(appSetting.value) && !equal) {
        Logger.verbose(f`#syncFromDB update env value... ${field}: "${value}" -> "${dbValue}"`, 'AppConfigure');
        envs[field] = dbValue;
      }

      // 检查并更新默认值和描述
      const updates: { defaultValue?: string; description?: string } = {};
      const valueToStore = value !== undefined ? (typeof value === 'string' ? value : JSON.stringify(value)) : null;

      // 如果默认值不一样，需要更新
      if (appSetting.defaultValue !== valueToStore && valueToStore !== null) {
        updates.defaultValue = valueToStore;
        Logger.debug(
          f`#syncFromDB will update defaultValue for ${field}: "${appSetting.defaultValue}" -> "${valueToStore}"`,
          'AppConfigure',
        );
      }

      // 如果描述存在并且与数据库中的不同，需要更新
      if (description && description !== appSetting.description) {
        updates.description = description;
        Logger.debug(
          f`#syncFromDB will update description for ${field}: "${appSetting.description}" -> "${description}"`,
          'AppConfigure',
        );
      }

      // 执行更新
      if (!R.isEmpty(updates)) {
        Logger.verbose(f`#syncFromDB update metadata... ${field}: ${updates}`, 'AppConfigure');
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
                value: format === 'string' ? value : JSON.stringify(value),
                defaultValue: updates.defaultValue,
                format,
                description: updates.description,
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
