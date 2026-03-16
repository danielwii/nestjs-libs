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
 * - Ref 替代 class 可变状态
 */

import { Context, Effect, Layer, Ref } from 'effect';

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
    const sseRef = yield* Ref.make<Set<SSEConnection>>(new Set());
    const wsRef = yield* Ref.make<Set<WSConnection>>(new Set());
    const shuttingDownRef = yield* Ref.make(false);

    // Finalizer: 优雅关闭所有连接
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Ref.set(shuttingDownRef, true);

        const sseConns = yield* Ref.get(sseRef);
        const wsConns = yield* Ref.get(wsRef);

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
          const isDown = yield* Ref.get(shuttingDownRef);
          if (isDown) {
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
          yield* Ref.update(sseRef, (set) => {
            set.add(conn);
            return set;
          });
          conn.onClose(() => {
            sseRef.pipe(
              Ref.update((set) => {
                set.delete(conn);
                return set;
              }),
              Effect.runSync,
            );
          });
        }),

      registerWS: (conn) =>
        Effect.gen(function* () {
          const isDown = yield* Ref.get(shuttingDownRef);
          if (isDown) {
            yield* Effect.sync(() => {
              conn.close(WS_CLOSE_CODE.SERVER_RESTART, 'Server is restarting');
            });
            return;
          }
          yield* Ref.update(wsRef, (set) => {
            set.add(conn);
            return set;
          });
        }),

      unregisterWS: (conn) =>
        Ref.update(wsRef, (set) => {
          set.delete(conn);
          return set;
        }),

      getActiveCount: () =>
        Effect.all({
          sse: Ref.get(sseRef).pipe(Effect.map((s) => s.size)),
          ws: Ref.get(wsRef).pipe(Effect.map((s) => s.size)),
        }),

      isShuttingDown: () => Ref.get(shuttingDownRef),
    };

    return service;
  }),
);
