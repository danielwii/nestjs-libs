/**
 * 目标：api 模式下，每个 HTTP 响应默认带一组适合 API 的安全响应头，使用方可以整份替换，或只给某些路径前缀放宽。
 *   默认值取自 OWASP REST Security Cheat Sheet「Security Headers」给 API 的那几条：
 *   `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`；
 *   其余头（HSTS、X-Content-Type-Options 等）用 helmet 8 的默认。
 * 设计：
 *  - 整份替换，不合并：合并会让「最后发出去的是什么」要读两处才知道。使用方要在默认上加一条，就自己展开 {@link API_SECURITY_HEADERS}
 *    再改，写在它自己的 `main.ts` 里看得见。`defaults` 与每个 `routes[].helmet` 原样交给 helmet、不经加工；helmet 的
 *    `contentSecurityPolicy.useDefaults` 默认是 `true`，会把 helmet 自带的指令并进来，要响应头上只有自己写的指令就写 `useDefaults: false`。
 *  - 按路径前缀分派：「请求路径等于前缀，或以前缀 + `/` 开头」才算落在它下面，所以 `/graphql` 不会匹配 `/graphqlx`；多个前缀重叠时
 *    按数组顺序第一个生效。根路径 `/` 不能作前缀（按这个规则它只匹配 `/` 本身，容易被当成全站），要改全站用 `defaults`。
 *  - 每个 helmet 中间件在启动时建好，不按请求建。
 *  - 抽成导出函数 {@link applySecurityHeaders}，bootstrap 在 api 模式调用它：测试直接对它做，不用跑整个 `bootstrap()`。
 * 保证：
 *  - 参数写错（前缀不以 `/` 开头、以 `/` 结尾、就是 `/`、重复）时 {@link applySecurityHeaders} 在启动时抛 `Oops.Panic.Config`，
 *    不带着错误的策略跑。类型 `` `/${string}` `` 在编译期已挡住一部分，运行时再挡一次是因为参数可能从配置读、或用 `as` 绕过。
 *  - 控制器里自己 `res.setHeader(...)` 的仍然覆盖这里设的头（这里先设、控制器后设）。
 * 不覆盖：
 *  - 只在 api 模式挂（调用点在 bootstrap 的 `if (isApi)` 里）；grpc、scheduler 模式不挂 helmet，这里不管。
 *  - `Cache-Control`、`Permissions-Policy`、HSTS 的取值：沿用 helmet 的默认，不在这里改。
 *  - 不检查 helmet 选项本身是否合理（交给 helmet；它在启动时对冲突的选项会抛）。
 * 退出条件：无。
 */
import { Oops } from '@app/nest/exceptions/oops';

import helmet from 'helmet';

import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { HelmetOptions } from 'helmet';

/**
 * api 模式的默认安全响应头。`useDefaults: false`：不让 helmet 把它自己的默认指令（`script-src 'self'` 等）并进来，
 * CSP 上只有这两条指令。
 */
export const API_SECURITY_HEADERS: Readonly<HelmetOptions> = {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] },
  },
  referrerPolicy: { policy: 'no-referrer' },
  frameguard: { action: 'deny' },
};

export interface SecurityHeadersRoute {
  /** 路径前缀：以 `/` 开头、不以 `/` 结尾、不是 `/` 本身（全站用 `defaults`）。请求路径等于它，或以「它 + `/`」开头，就算落在它下面。 */
  readonly prefix: `/${string}`;
  /** 这些路由用的 helmet 选项：整份替换，不和默认合并。 */
  readonly helmet: HelmetOptions;
}

export interface SecurityHeadersOptions {
  /** 全站默认：整份替换 {@link API_SECURITY_HEADERS}，不合并。不给就用 {@link API_SECURITY_HEADERS}。 */
  readonly defaults?: HelmetOptions;
  /** 按路由放宽：按数组顺序找，第一个匹配的生效；都不匹配用 `defaults`。不给就是空数组。 */
  readonly routes?: readonly SecurityHeadersRoute[];
}

interface ResolvedSecurityHeaders {
  readonly defaults: HelmetOptions;
  readonly routes: readonly SecurityHeadersRoute[];
}

/** 补默认值并校验前缀；任何一条不满足就抛，错误信息写出是哪个前缀、错在哪。 */
function resolveSecurityHeaders(options: SecurityHeadersOptions | undefined): ResolvedSecurityHeaders {
  const routes = options?.routes ?? [];
  const seen = new Set<string>();
  for (const { prefix } of routes) {
    const shown = JSON.stringify(prefix);
    if (typeof prefix !== 'string' || !prefix.startsWith('/')) {
      throw Oops.Panic.Config(`securityHeaders.routes: prefix ${shown} must start with "/"`);
    }
    if (prefix === '/') {
      throw Oops.Panic.Config(
        `securityHeaders.routes: prefix ${shown} would be the whole site; use securityHeaders.defaults to change every route`,
      );
    }
    if (prefix.endsWith('/')) {
      throw Oops.Panic.Config(`securityHeaders.routes: prefix ${shown} must not end with "/"`);
    }
    if (seen.has(prefix)) {
      throw Oops.Panic.Config(`securityHeaders.routes: prefix ${shown} is listed more than once`);
    }
    seen.add(prefix);
  }
  return { defaults: options?.defaults ?? API_SECURITY_HEADERS, routes };
}

/**
 * 校验 `options` 并把按路由分派的 helmet 挂到 `app` 上；参数错就抛 `Oops.Panic.Config`。bootstrap 只在 api 模式调用。
 *
 * 必须在 `app.enableCors(...)` 之前调用：cors 中间件会直接结束允许来源的 OPTIONS 预检，挂在它后面预检响应就没有这些头。
 * 中间件挂在 app 根上，所以 `req.path`（不含查询串）就是完整路径。
 */
export function applySecurityHeaders(app: INestApplication, options?: SecurityHeadersOptions): void {
  const resolved = resolveSecurityHeaders(options);
  const defaultMiddleware = helmet(resolved.defaults);
  const routeMiddlewares = resolved.routes.map((route) => ({ prefix: route.prefix, middleware: helmet(route.helmet) }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const matched = routeMiddlewares.find(({ prefix }) => req.path === prefix || req.path.startsWith(`${prefix}/`));
    (matched?.middleware ?? defaultMiddleware)(req, res, next);
  });
}
