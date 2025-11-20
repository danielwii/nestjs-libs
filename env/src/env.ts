import { IsBoolean, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';

export enum NODE_ENV {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

// NODE_ENV 为 production，业务中并不一定是生产环境，因此需要 ENV 来标记
export const isProduction = process.env.NODE_ENV === NODE_ENV.Production;
export const isTest = process.env.NODE_ENV === NODE_ENV.Test;

/**
 * 系统级环境变量配置（适用于所有项目）
 * 
 * 这些配置不依赖于特定的业务逻辑，是框架和基础设施层面的配置。
 * 应用级配置（AppEnvs）应放在具体项目的 src/env.ts 中。
 */
export class SystemEnvironmentVariables {
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
  I18N_EXCEPTION_ENABLED?: boolean = false;
}

// 实例化系统环境变量（可选，如果需要验证的话）
export const SysEnvs = new SystemEnvironmentVariables();
