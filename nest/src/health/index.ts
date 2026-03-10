// HealthModule 已通过 bootstrap/grpcBootstrap 自动注入，不再对外导出避免重复注入

// Health Registry（各 Module 注入并注册 indicator）
export { HealthRegistry } from './health-registry';

// Health Indicator 接口和工厂函数
export type { HealthIndicator, HealthIndicatorResult, HealthIndicatorType } from './health-indicator';
export { createDbHealthIndicator } from './indicators/db.health-indicator';
export { createGrpcHealthIndicator } from './indicators/grpc.health-indicator';
export { createRedisHealthIndicator } from './indicators/redis.health-indicator';
