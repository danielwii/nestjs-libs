/**
 * ESLint Plugin: effect-log
 *
 * Effect + LogTape 日志规范检查。
 *
 * 规则：
 * - prefer-f-template: Effect.log* 带插值必须用 f 标签（自动着色，autofix）
 *
 * 推荐配置（recommendedRules）：
 * - prefer-f-template: warn
 * - allowTaggedTemplates: true（兼容 LogTape 的 logger.info`...` 语法）
 *
 * @example eslint.config.mjs
 * ```js
 * import { effectLogPlugin, effectLogRecommendedRules } from './libs/eslint-plugin-effect-log.mjs';
 *
 * export default defineConfig({
 *   plugins: { 'effect-log': effectLogPlugin },
 *   rules: { ...effectLogRecommendedRules },
 * });
 * ```
 */

const EFFECT_LOG_METHODS = new Set([
  'log', 'logTrace', 'logDebug', 'logInfo', 'logWarning', 'logError', 'logFatal',
]);

/**
 * Rule: prefer-f-template
 *
 * ❌ Effect.log(`msg ${value}`)     — 无类型着色
 * ✅ Effect.log(f`msg ${value}`)    — r() 自动着色
 * ✅ Effect.log('plain string')     — 无插值，不需要 f
 * ✅ Effect.log(`no interpolation`) — 无插值，不需要 f
 *
 * Autofix: 在反引号前插入 f
 */
const preferFTemplate = {
  meta: {
    type: 'suggestion',
    fixable: 'code',
    docs: {
      description: 'Enforce f`` tagged template in Effect.log* calls with interpolation',
    },
    messages: {
      useF: 'Use f`...` instead of `...` in Effect.log* for type-aware coloring.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type !== 'MemberExpression' ||
          node.callee.object.type !== 'Identifier' ||
          node.callee.object.name !== 'Effect' ||
          node.callee.property.type !== 'Identifier' ||
          !EFFECT_LOG_METHODS.has(node.callee.property.name)
        ) {
          return;
        }

        for (const arg of node.arguments) {
          if (arg.type === 'TemplateLiteral' && arg.expressions.length > 0) {
            context.report({
              node: arg,
              messageId: 'useF',
              fix(fixer) {
                return fixer.insertTextBefore(arg, 'f');
              },
            });
          }
        }
      },
    };
  },
};

export const effectLogPlugin = {
  rules: {
    'prefer-f-template': preferFTemplate,
  },
};

/**
 * 推荐规则配置 — 直接展开到 rules 里
 *
 * 包含：
 * - effect-log/prefer-f-template: warn
 * - @typescript-eslint/no-unused-expressions: allowTaggedTemplates（LogTape 兼容）
 */
export const effectLogRecommendedRules = {
  'effect-log/prefer-f-template': 'warn',
  // LogTape 的 logger.info`...` 是 tagged template expression，
  // 默认被 no-unused-expressions 报错。允许 tagged templates。
  '@typescript-eslint/no-unused-expressions': ['error', { allowTaggedTemplates: true }],
};
