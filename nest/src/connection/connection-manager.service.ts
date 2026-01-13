import { Injectable, Logger } from '@nestjs/common';

import type { BeforeApplicationShutdown } from '@nestjs/common';
import type { Response } from 'express';
import type { WebSocket } from 'ws';

/**
 * SSE 关闭原因代码
 *
 * 设计意图：
 * - 客户端可以根据不同的关闭原因采取不同的策略
 * - SERVER_RESTART: 立即重连，不走退避逻辑
 * - NORMAL: 正常关闭，可能需要退避重连
 */
export const SSE_CLOSE_REASON = {
  SERVER_RESTART: 'server_restart',
  NORMAL: 'normal',
} as const;

/**
 * WebSocket 关闭代码
 *
 * 遵循 RFC 6455 规范：
 * - 4000-4999: 应用自定义代码
 * - 4000: 服务器重启，客户端应立即重连
 */
export const WS_CLOSE_CODE = {
  SERVER_RESTART: 4000,
} as const;

type SSEConnection = {
  res: Response;
  userId?: string;
  connectedAt: number;
};

type WSConnection = {
  socket: WebSocket;
  userId?: string;
  connectedAt: number;
};

/**
 * ConnectionManagerService
 *
 * 设计意图：
 * - 集中管理所有长连接（SSE、WebSocket）
 * - 在应用关闭前通知所有客户端，实现优雅关闭
 * - 客户端收到关闭通知后可以立即重连到新 Pod
 *
 * 优雅关闭流程：
 * 1. K8s 发送 SIGTERM
 * 2. NestJS 触发 beforeApplicationShutdown
 * 3. 本服务向所有 SSE 连接发送 server_restart 事件
 * 4. 本服务关闭所有 WebSocket 连接（code=4000）
 * 5. 客户端收到信号后立即重连到其他 Pod
 *
 * ═══════════════════════════════════════════════════════════════════
 * 客户端集成指南
 * ═══════════════════════════════════════════════════════════════════
 *
 * 【SSE 聊天流】
 *
 * 信号格式：
 * ```
 * event: server_restart
 * data: {"reason":"server_restart","message":"Server is restarting...","reconnect":true}
 * ```
 *
 * 客户端处理（以 Dart/Flutter 为例）：
 * ```dart
 * eventSource.addEventListener('server_restart', (event) {
 *   final data = jsonDecode(event.data);
 *   if (data['reconnect'] == true) {
 *     // 当前请求会中断，需要用户重新发起
 *     // 可以提示用户"连接中断，请重试"
 *     showRetryDialog();
 *   }
 * });
 * ```
 *
 * 【GraphQL WebSocket 订阅】
 *
 * 信号：WebSocket close 事件，code=4000
 *
 * 客户端处理（以 Dart/Flutter graphql_flutter 为例）：
 * ```dart
 * // graphql_flutter 的 WebSocketLink 配置
 * WebSocketLink(
 *   url: 'wss://api.example.com/graphql',
 *   config: SocketClientConfig(
 *     autoReconnect: true,
 *     onConnectionLost: (code, reason) {
 *       if (code == 4000) {
 *         // 服务器重启，立即重连（不走退避）
 *         // graphql_flutter 会自动重连并恢复订阅
 *         log('Server restart, reconnecting immediately...');
 *       }
 *     },
 *   ),
 * );
 * ```
 *
 * 重连后行为：
 * - 订阅会自动重建
 * - deviceShadowUpdates 会立即推送当前设备状态
 * - quotaUpdates 会立即推送当前配额
 * - 不会丢失关键数据
 *
 * ═══════════════════════════════════════════════════════════════════
 */
@Injectable()
export class ConnectionManagerService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(this.constructor.name);

  /** 活跃的 SSE 连接 */
  private readonly sseConnections = new Set<SSEConnection>();

  /** 活跃的 WebSocket 连接 (graphql-ws) */
  private readonly wsConnections = new Set<WSConnection>();

  /** 是否正在关闭 */
  private isShuttingDown = false;

  /**
   * 注册 SSE 连接
   *
   * @param res Express Response 对象
   * @param userId 可选的用户 ID，用于日志
   */
  registerSSE(res: Response, userId?: string): void {
    if (this.isShuttingDown) {
      // 关闭中不接受新连接，直接发送重启信号
      this.sendSSERestartSignal(res);
      return;
    }

    const connection: SSEConnection = {
      res,
      userId,
      connectedAt: Date.now(),
    };
    this.sseConnections.add(connection);

    // 连接关闭时自动清理
    const cleanup = () => {
      this.sseConnections.delete(connection);
      this.logger.debug(`#unregisterSSE userId=${userId ?? 'anonymous'} activeConnections=${this.sseConnections.size}`);
    };

    res.on('close', cleanup);
    res.on('finish', cleanup);
    res.on('error', cleanup);

    this.logger.debug(`#registerSSE userId=${userId ?? 'anonymous'} activeConnections=${this.sseConnections.size}`);
  }

  /**
   * 注册 WebSocket 连接
   *
   * 设计意图：
   * - 由 graphql-ws 的 onConnect 钩子调用
   * - 存储 socket 引用以便 shutdown 时关闭
   *
   * @param socket 原生 WebSocket 对象
   * @param userId 可选的用户 ID
   */
  registerWS(socket: WebSocket, userId?: string): void {
    if (this.isShuttingDown) {
      // 关闭中不接受新连接，直接关闭
      socket.close(WS_CLOSE_CODE.SERVER_RESTART, 'Server is restarting');
      return;
    }

    const connection: WSConnection = {
      socket,
      userId,
      connectedAt: Date.now(),
    };
    this.wsConnections.add(connection);

    this.logger.debug(`#registerWS userId=${userId ?? 'anonymous'} activeConnections=${this.wsConnections.size}`);
  }

  /**
   * 注销 WebSocket 连接
   *
   * 设计意图：
   * - 由 graphql-ws 的 onDisconnect 钩子调用
   * - 清理内存中的连接引用
   *
   * @param socket 原生 WebSocket 对象
   */
  unregisterWS(socket: WebSocket): void {
    for (const connection of this.wsConnections) {
      if (connection.socket === socket) {
        this.wsConnections.delete(connection);
        this.logger.debug(
          `#unregisterWS userId=${connection.userId ?? 'anonymous'} activeConnections=${this.wsConnections.size}`,
        );
        break;
      }
    }
  }

  /**
   * 检查是否正在关闭
   */
  get shuttingDown(): boolean {
    return this.isShuttingDown;
  }

  /**
   * 获取当前活跃连接数
   */
  getActiveConnectionCount(): { sse: number; ws: number } {
    return {
      sse: this.sseConnections.size,
      ws: this.wsConnections.size,
    };
  }

  /**
   * 应用关闭前钩子
   *
   * 设计意图：
   * - 在 NestJS 开始关闭流程前通知所有客户端
   * - 使用 beforeApplicationShutdown 而非 onApplicationShutdown
   *   因为前者在关闭流程更早执行，给客户端更多重连时间
   */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.isShuttingDown = true;
    const sseCount = this.sseConnections.size;
    const wsCount = this.wsConnections.size;

    this.logger.log(
      `#beforeApplicationShutdown signal=${signal ?? 'unknown'} sseConnections=${sseCount} wsConnections=${wsCount}`,
    );

    // 并行关闭 SSE 和 WebSocket 连接
    const tasks: Promise<void>[] = [];

    if (sseCount > 0) {
      this.logger.log(`#beforeApplicationShutdown 开始通知 ${sseCount} 个 SSE 连接...`);
      tasks.push(this.notifyAllSSEConnections());
    }

    if (wsCount > 0) {
      this.logger.log(`#beforeApplicationShutdown 开始关闭 ${wsCount} 个 WebSocket 连接...`);
      tasks.push(this.closeAllWSConnections());
    }

    await Promise.allSettled(tasks);
    this.logger.log(`#beforeApplicationShutdown 所有连接关闭完成`);
  }

  /**
   * 通知所有 SSE 连接服务器即将重启
   */
  private async notifyAllSSEConnections(): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const connection of this.sseConnections) {
      promises.push(this.notifySSEConnection(connection));
    }

    // 等待所有通知发送完成，但不阻塞太久
    await Promise.race([Promise.allSettled(promises), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }

  /**
   * 通知单个 SSE 连接
   */
  private async notifySSEConnection(connection: SSEConnection): Promise<void> {
    const { res, userId } = connection;

    try {
      this.sendSSERestartSignal(res);
      this.logger.debug(`#notifySSEConnection userId=${userId ?? 'anonymous'} 通知发送成功`);
    } catch (error) {
      this.logger.debug(
        `#notifySSEConnection userId=${userId ?? 'anonymous'} 通知发送失败: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  /**
   * 发送 SSE 重启信号
   *
   * 格式说明：
   * - event: server_restart - 事件名称，客户端监听此事件
   * - data: JSON 对象，包含原因和建议
   * - 连续两个换行符表示消息结束
   */
  private sendSSERestartSignal(res: Response): void {
    const payload = {
      reason: SSE_CLOSE_REASON.SERVER_RESTART,
      message: 'Server is restarting, please reconnect immediately',
      reconnect: true,
    };

    // 发送特殊的 server_restart 事件
    res.write(`event: server_restart\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);

    // 然后正常关闭连接
    res.end();
  }

  /**
   * 关闭所有 WebSocket 连接
   *
   * 设计意图：
   * - 使用自定义关闭代码 4000 (SERVER_RESTART)
   * - 客户端收到 code=4000 后应立即重连，不走退避逻辑
   */
  private async closeAllWSConnections(): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const connection of this.wsConnections) {
      promises.push(this.closeWSConnection(connection));
    }

    // 等待所有关闭完成，但不阻塞太久
    await Promise.race([Promise.allSettled(promises), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }

  /**
   * 关闭单个 WebSocket 连接
   */
  private async closeWSConnection(connection: WSConnection): Promise<void> {
    const { socket, userId } = connection;

    try {
      socket.close(WS_CLOSE_CODE.SERVER_RESTART, 'Server is restarting, please reconnect immediately');
      this.logger.debug(`#closeWSConnection userId=${userId ?? 'anonymous'} 关闭成功`);
    } catch (error) {
      this.logger.debug(
        `#closeWSConnection userId=${userId ?? 'anonymous'} 关闭失败: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }
}
