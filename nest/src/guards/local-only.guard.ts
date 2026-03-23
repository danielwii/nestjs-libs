/**
 * LocalOnlyGuard
 *
 * 限制端点只能从 localhost 访问。
 * 用于 debug/诊断/管理端点，防止公网直接调用。
 *
 * 安全模型：
 * - K8s 经过 LB/proxy 的请求 IP 不是 127.0.0.1，天然被挡
 * - kubectl port-forward / kubectl exec curl 是 127.0.0.1，正常通过
 * - 不信任 X-Forwarded-For（可伪造）
 *
 * 用法：
 * ```
 * @UseGuards(LocalOnlyGuard)
 * @Controller('debug/memory')
 * ```
 *
 * 或用组合装饰器：
 * ```
 * @LocalOnly()
 * @Controller('debug/memory')
 * ```
 */

import { Injectable, UseGuards } from '@nestjs/common';

import { Oops } from '@app/nest/exceptions/oops';

import '@app/nest/exceptions/oops-factories';

import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

@Injectable()
export class LocalOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    // 非 HTTP 上下文放行（避免误用于 gRPC handler 时报运行时错误）
    if (context.getType() !== 'http') return true;

    const req = context.switchToHttp().getRequest<Request>();
    const ip = req.ip ?? req.socket.remoteAddress;

    if (!ip || !LOCALHOST_IPS.has(ip)) {
      throw Oops.Block.Forbidden(`This endpoint is only accessible from localhost (ip=${ip})`);
    }

    return true;
  }
}

/**
 * 组合装饰器 — 语义更清晰
 *
 * ```
 * @LocalOnly()
 * @Controller('debug/memory')
 * ```
 */
export const LocalOnly = () => UseGuards(LocalOnlyGuard);
