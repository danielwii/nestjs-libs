import { requestRouteForLog } from '../interceptors/log-redaction';

import morgan from 'morgan';

import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Combined format plus `xff` and response time, with the request line's URL replaced by `:route`.
 *
 * `:url` would write the raw URL, whose path segments and query string can carry credentials (an invite token in
 * `/api/invites/<token>`, a `?token=` link). Morgan writes the line when the response finishes, by which time Express
 * has matched the route, so `:route` writes the route template; see {@link requestRouteForLog} for unmatched paths.
 */
export const ACCESS_LOG_FORMAT =
  ':remote-addr xff=":xff" - :remote-user [:date[clf]] ":method :route HTTP/:http-version" :status :res[content-length] ":response-time ms" ":referrer" ":user-agent"';

export interface AccessLogOptions {
  /** Where lines go; morgan's default (stdout) when omitted. */
  stream?: morgan.StreamOptions;
}

/** The HTTP access-log middleware `bootstrap` mounts for the api mode. */
export function createAccessLogMiddleware(
  options: AccessLogOptions = {},
): (req: IncomingMessage, res: ServerResponse, next: (err?: Error) => void) => void {
  // morgan 的 `:remote-addr` 取的是 `req.ip || req.connection.remoteAddress` —— 两种语义，
  // 且日志里看不出用的是哪一种。2026-09-01 实测同一次请求 morgan 打 `10.30.1.237`、
  // 而 `req.ip` 是 `139.178.131.16`（真实客户端），拿着日志无法判断哪个可信。
  // 补一个 `:xff` token 把推导来源一起打出来：XFF 缺席时 Express 会退回 socket 对端
  // （= 网格代理 IP），此时 `:remote-addr` 看起来合法但不是客户端。
  morgan.token('xff', (req) => {
    const raw = (req as { headers?: Record<string, unknown> }).headers?.['x-forwarded-for'];
    if (Array.isArray(raw)) return raw.join(', ');
    return typeof raw === 'string' ? raw : '-';
  });
  // morgan types `req` as a bare IncomingMessage; at runtime it is Express's request, with route / baseUrl / originalUrl
  morgan.token('route', (req) => requestRouteForLog(req));

  return morgan(ACCESS_LOG_FORMAT, {
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- boolean OR, not nullish fallback
    skip: (req) => req.url?.startsWith('/health') || req.url === '/',
    stream: options.stream,
  });
}
