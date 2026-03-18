/**
 * Config Printer — 启动时配置概览打印
 *
 * ## 设计原则
 *
 * 1. **运维可观测性优先**：启动日志必须让运维一眼判断服务状态
 *    - 配置模式（env-only / db-readonly / db-readwrite）
 *    - 哪些外部依赖可用（API key ✓/✗）
 *    - 哪些功能开启（feature on/off）
 *
 * 2. **安全**：敏感值（API key/secret）只打 ✓/✗，不打值
 *
 * 3. **分类语义**：
 *    - Providers: 外部服务 API key 可用性（有 key = 可调用）
 *    - Features:  boolean 功能开关（on/off）
 *    - Params:    数值型业务参数（直接打值，非敏感）
 *
 * 4. **环境适配**：
 *    - 开发：多行树形 + ANSI 语义色（key=cyan, ✓=green, ✗=red, number=yellow）
 *    - 生产：单行纯文本（JSON 日志友好，无 ANSI 转义）
 *
 * 5. **项目职责分离**：
 *    - libs 提供 `printConfig` 工具（本文件）
 *    - 各项目在 `src/config.ts` 声明 Config + `printXxxConfig` 函数
 *    - 启动时在 Effect.gen 中读取 Config 后调用
 *
 * ## 配置生命周期（完整启动日志分层）
 *
 * | Phase | 模块 | 负责方 |
 * |-------|------|--------|
 * | 1. Env Loading | instrument.ts | dotenvx（preload 阶段） |
 * | 2. Infra Init | Redis/Lock/Prisma | addon Layer（各自打印） |
 * | 3. Config Validation | Config | 项目 printConfig（本工具）|
 * | 4. DB Sync | AppSettings | makeAppSettingsLive（有 Prisma 时）|
 * | 5. Startup Banner | Bootstrap | libs startupBanner |
 *
 * @example
 * ```ts
 * // src/config.ts
 * export const printMyConfig = (config: MyConfigType) =>
 *   printConfig({
 *     mode: 'env-only',
 *     providers: { API_KEY: Option.isSome(config.apiKey) },
 *     features: { FEATURE_X: config.featureX },
 *     parameters: { TIMEOUT_MS: config.timeoutMs },
 *   });
 *
 * // src/server.ts
 * const config = yield* MyConfig;
 * yield* printMyConfig(config);
 * ```
 */
import { f } from '@app/utils/logging';

import { Effect } from 'effect';

// ==================== Types ====================

export type ConfigMode = 'env-only' | 'db-readonly' | 'db-readwrite';

export interface ConfigPrintOptions {
  /** 配置模式 */
  mode: ConfigMode;
  /** Provider API key 可用性（只打 ✓/✗） */
  providers?: Record<string, boolean>;
  /** Feature 开关 */
  features?: Record<string, boolean>;
  /** 数值型业务参数（直接打值） */
  parameters?: Record<string, string | number | boolean>;
}

// ==================== Helpers ====================

const modeLabel: Record<ConfigMode, string> = {
  'env-only': 'no DB sync',
  'db-readonly': 'read from DB',
  'db-readwrite': 'read + write to DB',
};

const isProd = () => process.env.NODE_ENV === 'production';

// Dev: ANSI colored, Prod: plain text
const green = (s: string) => (isProd() ? s : `\x1b[32m${s}\x1b[0m`);
const red = (s: string) => (isProd() ? s : `\x1b[31m${s}\x1b[0m`);
const cyan = (s: string) => (isProd() ? s : `\x1b[36m${s}\x1b[0m`);

const formatProviders = (providers: Record<string, boolean>): string =>
  Object.entries(providers)
    .map(([k, v]) => `${cyan(k)}=${v ? green('✓') : red('✗')}`)
    .join('  ');

const formatFeatures = (features: Record<string, boolean>): string =>
  Object.entries(features)
    .map(([k, v]) => `${cyan(k)}=${v ? green('on') : red('off')}`)
    .join('  ');

const formatEntries = (entries: Record<string, string | number | boolean>): string =>
  Object.entries(entries)
    .map(([k, v]) => f`${k}=${v}`)
    .join('  ');

// ==================== Main ====================

export const printConfig = (options: ConfigPrintOptions) =>
  Effect.gen(function* () {
    const fieldCount =
      Object.keys(options.providers ?? {}).length +
      Object.keys(options.features ?? {}).length +
      Object.keys(options.parameters ?? {}).length;

    const lines: string[] = [];

    if (options.providers && Object.keys(options.providers).length > 0) {
      lines.push(`Providers: ${formatProviders(options.providers)}`);
    }
    if (options.features && Object.keys(options.features).length > 0) {
      lines.push(`Features:  ${formatFeatures(options.features)}`);
    }
    if (options.parameters && Object.keys(options.parameters).length > 0) {
      lines.push(`Params:    ${formatEntries(options.parameters)}`);
    }

    if (isProd()) {
      yield* Effect.logInfo(
        f`config mode=${options.mode} (${modeLabel[options.mode]}) ${fieldCount} fields | ${lines.join(' | ')}`,
      );
    } else {
      yield* Effect.logInfo(f`Config (${options.mode}, ${modeLabel[options.mode]}, ${fieldCount} fields)`);
      for (let i = 0; i < lines.length; i++) {
        const prefix = i === lines.length - 1 ? '└─' : '├─';
        yield* Effect.logInfo(f`${prefix} ${lines[i]}`);
      }
    }
  }).pipe(Effect.annotateLogs('module', 'Config'));
