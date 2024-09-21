import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, validateSync } from 'class-validator';
import { plainToInstance, Transform, TransformFnParams } from 'class-transformer';
import { Logger } from '@nestjs/common';
import { config } from 'dotenv';
import JSON from 'json5';
import _ from 'lodash';

import { f, onelineStack } from '@app/utils';
import { NODE_ENV } from './env';
import os from 'node:os';

export const booleanTransformFn = ({ key, obj }: TransformFnParams) => {
  Logger.log(f`[Transform] ${{ key, origin: obj[key] }}`, 'Configure');
  return [true, 'true', '1'].includes(obj[key]);
};
const arrayTransformFn = ({ key, value, obj }: TransformFnParams) => {
  // Logger.log(f`-[Transform]- ${{ key, value, origin: obj[key], isArray: _.isArray(obj[key]) }}`);
  try {
    return _.isArray(obj[key]) ? obj[key] : JSON.parse(obj[key] || '[]');
  } catch (e) {
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
/**
 * 标记字段是否需要同步到数据库, 用于配置项的动态更新, 默认为空的字段需要赋值为 undefined 才能进行同步
 * @param format
 * @constructor
 */
const DatabaseField =
  (format: 'string' | 'number' | 'boolean' | 'json' = 'string') =>
  (target: any, propertyKey: string) => {
    Logger.verbose(f`found ${propertyKey}:${format}`, 'DatabaseField');
    Reflect.defineMetadata(DatabaseFieldSymbol, true, target, propertyKey);
    Reflect.defineMetadata(DatabaseFieldFormatSymbol, format, target, propertyKey);
  };

export class AbstractEnvironmentVariables implements HostSetVariables {
  private readonly logger = new Logger(this.constructor.name);
  private readonly hostname = os.hostname();

  // use doppler env instead
  @IsEnum(['prod', 'stg', 'dev']) @IsOptional() ENV: 'prod' | 'stg' | 'dev' = 'dev';
  @IsEnum(NODE_ENV) NODE_ENV: NODE_ENV = NODE_ENV.Development;
  @IsNumber() @IsOptional() PORT?: number;
  @IsString() TZ = 'UTC';

  @IsEnum(['verbose', 'debug', 'log', 'warn', 'error', 'fatal'])
  LOG_LEVEL: 'verbose' | 'debug' | 'log' | 'warn' | 'error' | 'fatal' = 'log';

  @IsString() @IsOptional() API_KEY?: string;

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
    const env = this.ENV || this.DOPPLER_ENVIRONMENT;
    const isProd = env === 'prod';
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
  ): HostSetVariables[F][0] {
    try {
      const index = this.hostIndex;
      this.logger.verbose(f`#getByHost (${this.hostname}) ${{ field, index }}`);
      return _.isBoolean(fallback)
        ? _.get(this[field], index, _.get(this, [field, 0]))
        : _.get(this[field], index, fallback);
    } catch (e) {
      this.logger.error(f`#getByHost (${this.hostname}) ${field} ${e.message} ${onelineStack(e.stack)}`);
      return _.isBoolean(fallback) ? _.get(this, [field, 0]) : fallback;
    }
  }

  get hostIndex() {
    return parseInt(this.hostname.split('-').pop());
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
      const index = +this.hostname.split('-').pop();
      const on = _.isNaN(index) ? !!acceptWhenNoIds : index === host;
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
}

export const AppEnv = new AppConfigure(AbstractEnvironmentVariables).vars;
