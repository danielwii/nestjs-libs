/**
 * Health Indicator Registry
 *
 * 中心化注册表，各 Module 在 onModuleInit 时注册自己的 indicator。
 * HealthController 从 registry 读取并按 type 分组。
 *
 * 使用方式：
 * ```typescript
 * @Module({ ... })
 * export class PrismaModule implements OnModuleInit {
 *   constructor(private readonly healthRegistry: HealthRegistry) {}
 *
 *   onModuleInit() {
 *     this.healthRegistry.register(
 *       createDbHealthIndicator(() => this.prisma.client.$queryRawUnsafe('SELECT 1'))
 *     );
 *   }
 * }
 * ```
 */

import { Injectable } from '@nestjs/common';

import type { HealthIndicator, HealthIndicatorType } from './health-indicator';

@Injectable()
export class HealthRegistry {
  private readonly indicators: HealthIndicator[] = [];

  register(indicator: HealthIndicator): void {
    this.indicators.push(indicator);
  }

  getByType(type: HealthIndicatorType): HealthIndicator[] {
    return this.indicators.filter((i) => i.type === type);
  }

  getAll(): HealthIndicator[] {
    return [...this.indicators];
  }
}
