/**
 * ESLint Configuration for TypeScript Projects
 *
 * 基于 typescript-eslint strictTypeChecked 配置，针对 NestJS 项目优化。
 *
 * ============================================================================
 * 关键规则最佳实践
 * ============================================================================
 *
 * ## @typescript-eslint/no-floating-promises
 *
 * 检测未处理的 Promise（"floating" Promise），防止错误被静默忽略。
 *
 * 【必须处理 Promise 的方式】
 * - `await promise`
 * - `promise.then(...).catch(...)`
 * - `return promise`
 * - `void promise`（显式忽略，仅用于确实不关心结果的场景）
 *
 * 【常见陷阱】
 * ```typescript
 * // 错误：数组中的 Promise 未处理
 * [1, 2, 3].map(async x => x + 1);  // floating!
 *
 * // 正确：使用 Promise.all
 * await Promise.all([1, 2, 3].map(async x => x + 1));
 *
 * // 错误：.then() 只有一个参数
 * promise.then(() => {});  // 没有 catch!
 *
 * // 正确
 * promise.then(() => {}).catch(console.error);
 * // 或
 * await promise;
 * ```
 *
 * 【显式忽略】
 * 当确实不关心 Promise 结果时，使用 `void` 前缀：
 * ```typescript
 * void someAsyncOperation();  // 显式标记为忽略
 * ```
 *
 * 【配置选项】
 * - `ignoreVoid: true`（默认）- 允许 void 前缀忽略
 * - `allowForKnownSafePromises` - 配置安全的 Promise 类型（如某些库的返回值）
 *
 * 参考：https://typescript-eslint.io/rules/no-floating-promises
 *
 * ----------------------------------------------------------------------------
 *
 * ## @typescript-eslint/consistent-type-imports
 *
 * 强制使用 `import type` 导入仅作为类型使用的值。
 *
 * 【为什么重要】
 * 1. **避免副作用**：类型导入不会执行模块代码
 * 2. **支持 Isolated Transpilation**：Babel/SWC/esbuild 等工具无法判断导入是类型还是值
 * 3. **配合 verbatimModuleSyntax**：TypeScript 5.0+ 推荐
 *
 * 【示例】
 * ```typescript
 * // 错误：SomeType 仅用作类型
 * import { SomeType } from './types';
 *
 * // 正确：显式标记为类型导入
 * import type { SomeType } from './types';
 *
 * // 混合导入：部分是值，部分是类型
 * import { SomeClass, type SomeType } from './module';
 * ```
 *
 * 【自动修复】
 * ESLint --fix 可以自动转换，IDE 也会提示修复。
 *
 * 【配合 tsconfig.json】
 * ```json
 * {
 *   "compilerOptions": {
 *     "verbatimModuleSyntax": true  // TS 5.0+ 推荐
 *   }
 * }
 * ```
 *
 * 参考：https://typescript-eslint.io/blog/consistent-type-imports-and-exports-why-and-how
 *
 * ----------------------------------------------------------------------------
 *
 * ## @typescript-eslint/no-unnecessary-condition
 *
 * 此规则基于 TypeScript 类型系统判断条件是否"必要"。
 * 如果类型说非空，但运行时可能为空，会产生误报。
 *
 * 【常见误报场景】
 * 1. NestJS switchToHttp().getRequest() - 类型说非空，GraphQL 场景可能为空
 * 2. 外部库类型定义不准确
 * 3. 数组索引访问（启用 noUncheckedIndexedAccess 可解决）
 *
 * 【处理方式】
 * | 场景                     | 处理方式                                        |
 * |--------------------------|------------------------------------------------|
 * | 确实多余的检查           | 删除多余的 ?. 或 ??                            |
 * | 类型定义不准确（本地）   | 修正类型：`param: Type | undefined`            |
 * | 外部库类型不准确         | eslint-disable + 注释说明原因                  |
 * | 数组索引访问             | 使用 .at(0) 或启用 noUncheckedIndexedAccess    |
 *
 * 【eslint-disable 注释模板】
 * ```typescript
 * // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 运行时 req 可能为空
 * if (!req) { ... }
 * ```
 *
 * 参考：https://typescript-eslint.io/rules/no-unnecessary-condition
 *
 * ----------------------------------------------------------------------------
 *
 * ## @typescript-eslint/prefer-nullish-coalescing
 *
 * 推荐使用 ?? 替代 || 进行空值合并。
 *
 * 【注意】Boolean OR 逻辑不应替换！
 * ```typescript
 * // 错误：这是 boolean OR，不是 nullish fallback
 * const isHealthCheck = req.path?.startsWith('/health') || req.path === '/';
 *
 * // 正确：添加 eslint-disable 说明
 * // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- boolean OR, not nullish fallback
 * const isHealthCheck = req.path?.startsWith('/health') || req.path === '/';
 * ```
 *
 * ----------------------------------------------------------------------------
 *
 * ## unknown 类型错误处理
 *
 * TypeScript catch 块中 error 类型是 unknown，不要用 `as` 断言。
 *
 * 【最佳实践：Type Guard 模式】
 * ```typescript
 * // 定义 Type Guard
 * function hasErrorMessage(error: unknown): error is { message: string } {
 *   return (
 *     typeof error === 'object' &&
 *     error !== null &&
 *     'message' in error &&
 *     typeof (error as Record<string, unknown>).message === 'string'
 *   );
 * }
 *
 * // 定义 Helper
 * function getErrorMessage(error: unknown): string {
 *   if (hasErrorMessage(error)) return error.message;
 *   if (error instanceof Error) return error.message;
 *   return String(error);
 * }
 *
 * // 使用
 * catch (error: unknown) {
 *   const message = getErrorMessage(error);  // 类型安全
 * }
 * ```
 *
 * 参考：Kent C. Dodds - Get a catch block error message with TypeScript
 *
 * ============================================================================
 * tsconfig.json 推荐配置
 * ============================================================================
 *
 * 以下配置与 ESLint 规则配合使用效果最佳：
 *
 * ```json
 * {
 *   "compilerOptions": {
 *     "strict": true,
 *     "noUncheckedIndexedAccess": true,  // 数组访问返回 T | undefined
 *     "exactOptionalPropertyTypes": true, // 可选属性更严格
 *     "verbatimModuleSyntax": true        // TS 5.0+ 类型导入更严格
 *   }
 * }
 * ```
 *
 * ============================================================================
 * 其他重要规则说明
 * ============================================================================
 *
 * ## @typescript-eslint/no-explicit-any
 *
 * 禁止使用 `any` 类型，强制使用 `unknown` 或具体类型。
 *
 * 【any vs unknown】
 * - `any`：关闭类型检查，任何操作都允许（危险！）
 * - `unknown`：类型安全的"任意类型"，必须先检查类型才能使用
 *
 * 【替代方案】
 * ```typescript
 * // 错误
 * function parse(json: string): any { ... }
 *
 * // 正确：使用 unknown + 类型守卫
 * function parse(json: string): unknown { ... }
 * const result = parse(data);
 * if (typeof result === 'object' && result !== null) {
 *   // 现在可以安全使用
 * }
 *
 * // 或使用泛型
 * function parse<T>(json: string): T { ... }
 * ```
 *
 * ----------------------------------------------------------------------------
 *
 * ## @typescript-eslint/no-unsafe-* 系列
 *
 * 这些规则检测 any 类型的传播，建议逐步收紧：
 *
 * | 规则                    | 说明                      | 建议级别 |
 * |-------------------------|---------------------------|----------|
 * | no-unsafe-argument      | 禁止 any 作为函数参数     | warn     |
 * | no-unsafe-assignment    | 禁止 any 赋值给变量       | off→warn |
 * | no-unsafe-call          | 禁止调用 any 类型的函数   | off→warn |
 * | no-unsafe-member-access | 禁止访问 any 类型的属性   | off→warn |
 * | no-unsafe-return        | 禁止返回 any 类型         | off→warn |
 *
 * 【渐进式收紧策略】
 * 1. 新项目：全部 error
 * 2. 迁移中项目：从 off 逐步升级到 warn 再到 error
 * 3. 使用 eslint-disable 标记遗留代码，附带修复计划
 *
 * ----------------------------------------------------------------------------
 *
 * ## @typescript-eslint/unbound-method
 *
 * 检测类方法未绑定 this 的问题。
 *
 * 【问题场景】
 * ```typescript
 * class Foo {
 *   name = 'foo';
 *   greet() { return this.name; }
 * }
 * const foo = new Foo();
 * const greet = foo.greet;  // this 丢失!
 * greet();  // undefined
 * ```
 *
 * 【NestJS 例外】
 * NestJS 的静态方法（如 Module.forRoot()）不需要绑定：
 * ```typescript
 * // 配置 { ignoreStatic: true }
 * ConfigModule.forRoot({ ... })  // OK
 * ```
 *
 * ============================================================================
 */

import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import eslint from '@eslint/js';
import globals from 'globals';

export default defineConfig(
  {
    ignores: [
      'eslint.config.mjs',
      'dist/*',
      'build/*',
      '**/*.js',
      '**/*.spec.ts',
      '**/*.test.ts',
      '**/__tests__/**',
      'test/**/*',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
      sourceType: 'module',
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // ========================================================================
      // Type Safety - 类型安全（严格执行）
      // ========================================================================
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/ban-ts-comment': ['error', {
        'ts-ignore': 'allow-with-description',
        'ts-expect-error': 'allow-with-description',
      }],

      // ========================================================================
      // Code Style - 代码风格（警告级别，允许 eslint-disable）
      // ========================================================================
      '@typescript-eslint/consistent-type-imports': 'error',

      // 推荐 ?? 替代 ||，但 boolean OR 场景需要 eslint-disable
      '@typescript-eslint/prefer-nullish-coalescing': 'warn',

      '@typescript-eslint/prefer-optional-chain': 'warn',

      // 基于类型判断条件必要性，外部库类型不准确时需要 eslint-disable
      // 见文件顶部注释了解处理方式
      // 已禁用：该规则对索引访问和外部 JSON 数据有已知的误报问题
      // 参考：https://typescript-eslint.io/rules/no-unnecessary-condition/#limitations
      '@typescript-eslint/no-unnecessary-condition': 'off',

      'prefer-const': 'warn',

      // ========================================================================
      // Relaxed Rules - 放宽规则（NestJS 兼容）
      // ========================================================================

      // NestJS 装饰器模式需要调用方类型推断
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',

      // NestJS 生命周期方法可能是 async 但不 await
      '@typescript-eslint/require-await': 'off',

      // NestJS DTO 和接口常用空对象类型
      '@typescript-eslint/no-empty-object-type': 'off',

      // NestJS Module/Controller/Service 类可能没有实例成员
      '@typescript-eslint/no-extraneous-class': 'off',

      // NestJS 静态方法引用不需要绑定
      '@typescript-eslint/unbound-method': ['error', { ignoreStatic: true }],

      // GraphQL 返回类型可能包含冗余联合
      '@typescript-eslint/no-redundant-type-constituents': 'off',

      // 模板字符串允许 number 和 boolean
      '@typescript-eslint/restrict-template-expressions': ['error', {
        allowNumber: true,
        allowBoolean: true,
      }],

      // ========================================================================
      // Unsafe Rules - 不安全规则（逐步收紧）
      // ========================================================================
      // 这些规则在迁移旧代码时可能产生大量警告，建议逐步启用

      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
);
