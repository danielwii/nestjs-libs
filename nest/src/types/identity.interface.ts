import type { Request } from 'express';

/**
 * 基础身份用户信息
 * @template T 客户端自定义扩展属性的类型
 */
export type IdentityUser<T = Record<string, unknown>> = {
  uid?: string;
  userId?: string;
} & T;

/**
 * 业务请求接口
 * 显式扩展 Express 的 Request，注入业务特有的属性
 */
export interface IdentityRequest<TUser = Record<string, unknown>> extends Request {
  user?: IdentityUser<TUser>;
  visitorId?: string;
}
