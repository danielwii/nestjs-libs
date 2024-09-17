export enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

// NODE_ENV 为 production，业务中并不一定是生产环境，因此需要 ENV 来标记
export const isProduction = process.env.NODE_ENV === Environment.Production;
export const isTest = process.env.NODE_ENV === Environment.Test;
// 生产环境
export const isProd = process.env.ENV === 'prod';
export const isStg = process.env.ENV === 'stg';
export const isCloud = isProd || isStg;
export const isDev = !isCloud;
