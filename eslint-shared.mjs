/**
 * 共享 ESLint 配置
 *
 * 所有项目通过 import 引用，保持规则统一。
 * modx tooling 负责初始化骨架（生成 eslint.config.mjs），运行时直接引用此文件。
 *
 * Usage in project eslint.config.mjs:
 *   import { createEslintConfig } from './libs/eslint-shared.mjs';
 *   export default createEslintConfig({ rootDir: import.meta.dirname, ignores: ['src/cli'] });
 */

import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { effectLogPlugin, effectLogRecommendedRules } from './eslint-plugin-effect-log.mjs';

/**
 * @param {object} options
 * @param {string} options.rootDir - 项目根目录（传 import.meta.dirname）
 * @param {string} [options.tsconfigPath] - tsconfig.json 路径（相对项目根）
 * @param {string[]} [options.ignores] - 额外的 ignore 模式
 */
export function createEslintConfig({ rootDir, tsconfigPath = './tsconfig.json', ignores = [] }) {
  return defineConfig(
    {
      ignores: [
        '**/*.mjs',
        'dist/*',
        'build/*',
        '**/*.js',
        '**/*.spec.ts',
        '**/*.test.ts',
        '**/__tests__/**',
        'test/**/*',
        ...ignores,
      ],
    },
    eslint.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    {
      languageOptions: {
        globals: { ...globals.node },
        sourceType: 'module',
        parserOptions: {
          project: tsconfigPath,
          tsconfigRootDir: rootDir,
        },
      },
    },
    {
      plugins: {
        'effect-log': effectLogPlugin,
      },
      rules: {
        // ====== Type Safety ======
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': 'allow-with-description', 'ts-expect-error': 'allow-with-description' }],

        // ====== Deprecation（渐进迁移，不阻断） ======
        '@typescript-eslint/no-deprecated': 'warn',

        // ====== Code Style ======
        '@typescript-eslint/consistent-type-imports': 'error',
        '@typescript-eslint/prefer-nullish-coalescing': ['warn', { ignoreConditionalTests: true, ignoreMixedLogicalExpressions: true }],
        '@typescript-eslint/prefer-optional-chain': 'warn',
        '@typescript-eslint/no-unnecessary-condition': 'warn',
        'prefer-const': 'warn',

        // ====== LogTape ======
        // LogTape 使用 tagged template literal 调用（如 logger.info`msg`）
        '@typescript-eslint/no-unused-expressions': ['error', { allowTaggedTemplates: true }],

        // ====== Relaxed (NestJS / Effect compat) ======
        '@typescript-eslint/no-unnecessary-type-parameters': 'off',
        '@typescript-eslint/require-await': 'off',
        '@typescript-eslint/no-empty-object-type': 'off',
        '@typescript-eslint/no-non-null-assertion': 'error',
        '@typescript-eslint/no-extraneous-class': 'off',
        '@typescript-eslint/unbound-method': ['error', { ignoreStatic: true }],
        '@typescript-eslint/no-redundant-type-constituents': 'off',
        '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],

        // ====== Effect + LogTape ======
        ...effectLogRecommendedRules,

        // ====== Unsafe (逐步收紧) ======
        '@typescript-eslint/no-unsafe-argument': 'warn',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
      },
    },
  );
}
