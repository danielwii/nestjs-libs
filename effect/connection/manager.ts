import { f } from '@app/utils/logging';

/**
 * Connection Manager — 长连接生命周期管理
 *
 * 对标 NestJS ConnectionManagerService：
 * - SSE/WebSocket 连接注册与跟踪
 * - 优雅关闭：SIGTERM → 通知所有客户端 → 客户端重连到新 Pod
 * - K8s 滚动更新零中断
 *
 * Effect 模式：
 * - Context.Tag（Port）+ Layer.scoped（Adapter）
 * - addFinalizer 替代 beforeApplicationShutdown
 * - 闭包变量替代 Ref — conn.onClose 回调在 Node event loop 执行，不在 Effect Runtime
 */

import { Context, Effect, Layer } from 'effect';

// ==================== Types ====================

export const SSE_CLOSE_REASON = {
  SERVER_RESTART: 'server_restart',
  NORMAL: 'normal',
} as const;

export const WS_CLOSE_CODE = {
  SERVER_RESTART: 4000,
} as const;

interface SSEConnection {
  readonly write: (data: string) => void;
  readonly end: () => void;
  readonly onClose: (fn: () => void) => void;
  readonly userId?: string;
  readonly connectedAt: number;
}

interface WSConnection {
  readonly close: (code: number, reason: string) => void;
  readonly userId?: string;
  readonly connectedAt: number;
}

// ==================== Service Interface ====================

export interface ConnectionManagerService {
  readonly registerSSE: (conn: SSEConnection) => Effect.Effect<void>;
  readonly registerWS: (conn: WSConnection) => Effect.Effect<void>;
  readonly unregisterWS: (conn: WSConnection) => Effect.Effect<void>;
  readonly getActiveCount: () => Effect.Effect<{ sse: number; ws: number }>;
  readonly isShuttingDown: () => Effect.Effect<boolean>;
}

// ==================== Tag ====================

export class ConnectionManager extends Context.Tag('ConnectionManager')<
  ConnectionManager,
  ConnectionManagerService
>() {}

// ==================== Layer ====================

export const ConnectionManagerLive: Layer.Layer<ConnectionManager> = Layer.scoped(
  ConnectionManager,
  Effect.gen(function* () {
    // 闭包变量替代 Ref — conn.onClose 回调在 Node event loop 执行，不在 Effect Runtime
    // Effect.runSync 在回调里可能没有 Runtime context，用普通 Set 更安全
    // （同 Redis circuit breaker 的设计决策）
    const sseConns = new Set<SSEConnection>();
    const wsConns = new Set<WSConnection>();
    let shuttingDown = false;

    // Finalizer: 优雅关闭所有连接
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        shuttingDown = true;

        yield* Effect.log(f`Closing connections: sse=${sseConns.size} ws=${wsConns.size}`);

        // 通知 SSE 客户端
        for (const conn of sseConns) {
          yield* Effect.sync(() => {
            try {
              const payload = JSON.stringify({
                reason: SSE_CLOSE_REASON.SERVER_RESTART,
                message: 'Server is restarting, please reconnect immediately',
                reconnect: true,
              });
              conn.write(`event: server_restart\ndata: ${payload}\n\n`);
              conn.end();
            } catch {
              /* connection may already be closed */
            }
          });
        }

        // 关闭 WebSocket 连接
        for (const conn of wsConns) {
          yield* Effect.sync(() => {
            try {
              conn.close(WS_CLOSE_CODE.SERVER_RESTART, 'Server is restarting');
            } catch {
              /* connection may already be closed */
            }
          });
        }

        yield* Effect.log('All connections closed');
      }),
    );

    const service: ConnectionManagerService = {
      registerSSE: (conn) =>
        Effect.gen(function* () {
          if (shuttingDown) {
            yield* Effect.sync(() => {
              const payload = JSON.stringify({
                reason: SSE_CLOSE_REASON.SERVER_RESTART,
                message: 'Server is restarting',
                reconnect: true,
              });
              conn.write(`event: server_restart\ndata: ${payload}\n\n`);
              conn.end();
            });
            return;
          }
          sseConns.add(conn);
          conn.onClose(() => {
            sseConns.delete(conn);
          });
        }),

      registerWS: (conn) =>
        Effect.gen(function* () {
          if (shuttingDown) {
            yield* Effect.sync(() => {
              conn.close(WS_CLOSE_CODE.SERVER_RESTART, 'Server is restarting');
            });
            return;
          }
          wsConns.add(conn);
        }),

      unregisterWS: (conn) =>
        Effect.sync(() => {
          wsConns.delete(conn);
        }),

      getActiveCount: () =>
        Effect.sync(() => ({
          sse: sseConns.size,
          ws: wsConns.size,
        })),

      isShuttingDown: () => Effect.sync(() => shuttingDown),
    };

    return service;
  }),
);
