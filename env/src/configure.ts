import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, validateSync } from 'class-validator';
import { plainToInstance, Transform, TransformFnParams } from 'class-transformer';
import { Logger } from '@nestjs/common';
import { config } from 'dotenv';
import { uid } from 'radash';
import JSON from 'json5';
import _ from 'lodash';

import { f, onelineStack } from '@app/utils';
import { NODE_ENV } from './env';
import os from 'node:os';

export const booleanTransformFn = ({ key, obj }: TransformFnParams) => {
  Logger.debug(f`[Transform] ${{ key, origin: obj[key] }}`, 'Configure');
  return [true, 'true', '1'].includes(obj[key]);
};
const arrayTransformFn = ({ key, value, obj }: TransformFnParams) => {
  // Logger.log(f`-[Transform]- ${{ key, value, origin: obj[key], isArray: _.isArray(obj[key]) }}`);
  try {
    return _.isArray(obj[key]) ? obj[key] : JSON.parse(obj[key] || '[]');
  } catch (e: any) {
    Logger.error(
      f`#arrayTransformFn error ${{ key, value, origin: obj[key], isArray: _.isArray(obj[key]) }} ${e.message} ${onelineStack(e.stack)}`,
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
  @IsNumber() @IsOptional() PORT?: number;
  @IsString() TZ = 'UTC';

  @IsEnum(['verbose', 'debug', 'log', 'warn', 'error', 'fatal'])
  LOG_LEVEL: 'verbose' | 'debug' | 'log' | 'warn' | 'error' | 'fatal' = 'log';

  @DatabaseField('string', '系统API密钥，用于验证系统级内部API请求，不要外部使用') @IsString() API_KEY: string = uid(64);

  // used to debug dependency issues
  @IsString() @IsOptional() NEST_DEBUG?: string;

  @IsString() @IsOptional() DOPPLER_ENVIRONMENT?: string;

  @IsBoolean()
  @IsOptional()
  @Transform(booleanTransformFn)
  TRACING_ENABLED?: boolean;
  @IsString() @IsOptional() SERVICE_NAME?: string;
  @IsString() @IsOptional() TRACING_EXPORTER_URL?: string;

  @IsBoolean() @IsOptional() @Transform(booleanTransformFn) APP_PROXY_ENABLED?: boolean;
  @IsString() @IsOptional() APP_PROXY_HOST?: string;
  @IsNumber() @IsOptional() APP_PROXY_PORT?: number;

  get environment() {
    const env = this.ENV || this.DOPPLER_ENVIRONMENT || 'dev';
    const isProd = env === 'prd';
    return {
      env,
      isProd,
    };
  }

  /**
   * Retrieves the value of a specified field based on the hostname of the current system.
   *
   * @template F - The type of the field to retrieve
   * @param {F} field - The field to retrieve the value from
   * @param {HostSetVariables[F][0] | boolean} [fallback] - The fallback value to use if the retrieval fails
   * @returns {HostSetVariables[F][0]} - The retrieved value of the specified field
   */
  getByHost<F extends keyof HostSetVariables>(
    field: F,
    fallback?: HostSetVariables[F][0] | boolean,
  ): HostSetVariables[F][0] | undefined {
    try {
      const index = this.hostIndex;
      if (_.isNil(index)) {
        this.logger.warn(f`#getByHost (${this.hostname}) ${{ field, index }}`);
        return _.isBoolean(fallback) ? _.get(this, [field, 0]) : fallback;
      }
      this.logger.verbose(f`#getByHost (${this.hostname}) ${{ field, index }}`);
      return _.isBoolean(fallback)
        ? _.get(this[field], index, _.get(this, [field, 0]))
        : _.get(this[field], index, fallback);
    } catch (e: any) {
      this.logger.error(f`#getByHost (${this.hostname}) ${field} ${e.message} ${onelineStack(e.stack)}`);
      return _.isBoolean(fallback) ? _.get(this, [field, 0]) : fallback;
    }
  }

  get hostIndex() {
    const part = this.hostname.split('-').pop();
    return _.isString(part) ? +part : null;
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
      this.hostKeys[host] = _.concat([...(this.hostKeys[host] ?? []), key]);
      const index = this.hostIndex;
      const on = _.isNil(index) ? !!acceptWhenNoIds : index === host;
      this.logger.debug(f`#getUniqueHost (${this.hostname}) ${{ key }} ${{ host, index, acceptWhenNoIds, on }}`);
      return on;
    } catch (e) {}
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
  constructor(readonly EnvsClass: new () => T) {
    const envFilePath = _.cond([
      [_.matches(NODE_ENV.Test), _.constant(['.env.local', '.env.test'])],
      [_.matches(NODE_ENV.Production), _.constant(['.env.local', '.env'])],
      // development or other
      [_.stubTrue, _.constant(['.env.development.local', '.env.local', '.env.development', '.env'])],
    ])(process.env.NODE_ENV);

    this.logger.log(f`envFilePath: ${envFilePath}`);
    _.forEach(envFilePath, (env) => {
      config({ path: env, debug: false, override: false });
    });
    this.vars = this.validate();
  }

  private validate() {
    const config = process.env;
    const validatedConfig = plainToInstance(this.EnvsClass, config, {
      enableImplicitConversion: true,
    });

    if (process.env.NODE_ENV !== NODE_ENV.Test) {
      this.logger.verbose(`[Config] validate...`);
      const errors = validateSync(validatedConfig, {
        skipMissingProperties: false,
      });

      if (errors.length > 0) {
        this.logger.warn(`[Config] these configs are not valid`);
        console.log(_.map(errors, (e) => `${e.property}=`).join('\n'));
        throw new Error(errors.toString());
      }

      _.each(validatedConfig, (value, key) => {
        if (key.includes('_ENABLE')) this.logger.log(f`[Feature] ${{ key, value /* origin: config[key] */ }}`);
      });
      _.each(validatedConfig, (value, key) => {
        if (key.startsWith('APP_')) this.logger.log(f`[App.Feature] ${{ key, value /* origin: config[key] */ }}`);
      });
    }
    // Logger.log(f`[Config] ${validatedConfig}`);
    return validatedConfig;
  }

  static async syncFromDB(prisma: any, envs: Record<string, any>) {
    const fields = _(Object.getOwnPropertyNames(envs))
      .map((field) => {
        const isDatabaseField = Reflect.getMetadata(DatabaseFieldSymbol, envs, field);
        const format = Reflect.getMetadata(DatabaseFieldFormatSymbol, envs, field);
        const description = Reflect.getMetadata(DatabaseFieldDescriptionSymbol, envs, field);
        
        // 添加详细日志，特别关注 DEFAULT_LLM_MODEL
        if (field === 'DEFAULT_LLM_MODEL') {
          Logger.log(
            f`#syncFromDB metadata for DEFAULT_LLM_MODEL: ${
              { isDatabaseField, format, description, value: envs[field] }
            }`,
            'AppConfigure'
          );
        }
        
        return { field, isDatabaseField, format, description, value: envs[field] };
      })
      .filter(({ isDatabaseField }) => isDatabaseField)
      .value();
    
    // 添加所有待同步字段的详细日志
    Logger.debug(f`#syncFromDB fields to sync: ${fields}`, 'AppConfigure');

    Logger.debug(f`#syncFromDB... reload app settings from db.`, 'AppConfigure');
    const appSettings = _.map(await prisma.appSetting.findMany(), ({ value, format, ...rest }) =>
      /**/
      ({ ...rest, value: format !== 'string' ? JSON.parse(value) : value, format }),
    );
    
    // 添加数据库中所有设置的详细日志
    Logger.debug(f`#syncFromDB appSettings from DB: ${appSettings}`, 'AppConfigure');
    
    const fieldNamesInDB = _.map(appSettings, (s) => s.key);
    // 如何 appSettings 中不存在，则用当前的值更新
    const nonExistsFields = _.filter(fields, ({ field }) => !fieldNamesInDB.includes(field));
    Logger.debug(f`#syncFromDB nonExistsFields: ${nonExistsFields}`, 'AppConfigure');
    
    if (nonExistsFields.length) {
      Logger.debug(f`#syncFromDB creating ${nonExistsFields.length} new fields...`, 'AppConfigure');
      await prisma.appSetting.createMany({
        data: nonExistsFields.map(({ field, format, description }) => {
          const value = format === 'string' ? envs[field] : JSON.stringify(envs[field]);
          const newVar = { 
            key: field, 
            default_value: value, 
            format,
            description 
          };
          Logger.verbose(f`#syncFromDB create... ${newVar}`, 'AppConfigure');
          return newVar;
        }),
        skipDuplicates: true,
      });
    }

    // 如何 appSettings 中存在，则用当前的值更新 envs
    const existsFields = _.filter(fields, ({ field }) => fieldNamesInDB.includes(field));
    Logger.debug(f`#syncFromDB existsFields count: ${existsFields.length}`, 'AppConfigure');
    
    for (const { field, value, description, format } of existsFields) {
      const appSetting = _.find(appSettings, { key: field });
      
      // 添加详细信息日志，特别是对 DEFAULT_LLM_MODEL
      if (field === 'DEFAULT_LLM_MODEL') {
        Logger.log(
          f`#syncFromDB DEFAULT_LLM_MODEL details: ${{
            field,
            value,
            description,
            format,
            appSetting_value: appSetting.value,
            appSetting_default_value: appSetting.default_value,
            appSetting_description: appSetting.description
          }}`,
          'AppConfigure'
        );
      }
      
      const dbValue = appSetting.value;
      const equal = _.isEqual(value, dbValue);
      
      // 更新环境变量值
      if (!_.isNil(appSetting.value) && !equal) {
        Logger.verbose(f`#syncFromDB update env value... ${field}: "${value}" -> "${dbValue}"`, 'AppConfigure');
        envs[field] = dbValue;
      }
      
      // 检查并更新默认值和描述
      const updates: { default_value?: string, description?: string } = {};
      const valueToStore = value !== undefined ? (typeof value === 'string' ? value : JSON.stringify(value)) : null;
      
      // 如果默认值不一样，需要更新
      if (appSetting.default_value !== valueToStore && valueToStore !== null) {
        updates.default_value = valueToStore;
        Logger.debug(f`#syncFromDB will update default_value for ${field}: "${appSetting.default_value}" -> "${valueToStore}"`, 'AppConfigure');
      }
      
      // 如果描述存在并且与数据库中的不同，需要更新
      if (description && description !== appSetting.description) {
        updates.description = description;
        Logger.debug(f`#syncFromDB will update description for ${field}: "${appSetting.description}" -> "${description}"`, 'AppConfigure');
      }
      
      // 执行更新
      if (!_.isEmpty(updates)) {
        Logger.verbose(f`#syncFromDB update metadata... ${field}: ${updates}`, 'AppConfigure');
        try {
          // 首先检查记录是否存在
          const existingRecord = await prisma.appSetting.findUnique({
            where: { key: field },
          });
          
          if (!existingRecord) {
            Logger.warn(f`#syncFromDB record not found for update: ${field}`, 'AppConfigure');
            // 记录不存在，创建新记录
            await prisma.appSetting.create({
              data: {
                key: field,
                value: format === 'string' ? value : JSON.stringify(value),
                default_value: updates.default_value,
                format,
                description: updates.description,
              },
            });
            Logger.log(f`#syncFromDB created record for ${field} since it didn't exist`, 'AppConfigure');
          } else {
            // 记录存在，执行更新
            await prisma.appSetting.update({
              where: { key: field },
              data: updates,
            });
            Logger.log(f`#syncFromDB successfully updated metadata for ${field}`, 'AppConfigure');
          }
        } catch (error: any) {
          Logger.error(f`#syncFromDB failed to update metadata for ${field}: ${error.message}`, error.stack, 'AppConfigure');
        }
      }
    }
  }
}

export const AppEnv = new AppConfigure(AbstractEnvironmentVariables).vars;
