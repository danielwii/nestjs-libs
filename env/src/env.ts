export enum NODE_ENV {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

// NODE_ENV 为 production，业务中并不一定是生产环境，因此需要 ENV 来标记
export const isProduction = process.env.NODE_ENV === NODE_ENV.Production;
export const isTest = process.env.NODE_ENV === NODE_ENV.Test;
