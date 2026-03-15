/**
 * DatabaseField 声明式定义
 *
 * 替代 NestJS 版的 @DatabaseField 装饰器 + Reflect.defineMetadata
 * Effect 版用普通对象属性，零反射、编译期类型安全
 *
 * NestJS → Effect 映射：
 * - @DatabaseField('number', 'desc') → dbNumber(60000, 'desc')
 * - Reflect.defineMetadata → 普通对象属性
 * - class-validator validateSync → Schema.decodeUnknownSync
 */

import { Schema } from 'effect';

// ==================== Types ====================

export type FieldFormat = 'string' | 'number' | 'boolean' | 'json';

export interface DatabaseFieldDef<A = unknown> {
  /** 验证 DB string → A */
  readonly schema: Schema.Schema<A, string>;
  readonly format: FieldFormat;
  readonly defaultValue: A | undefined;
  readonly description?: string;
}

// ==================== 便捷工厂 ====================

export const dbString = (defaultValue?: string, description?: string): DatabaseFieldDef<string> => ({
  schema: Schema.String,
  format: 'string',
  defaultValue,
  description,
});

export const dbNumber = (defaultValue: number, description?: string): DatabaseFieldDef<number> => ({
  schema: Schema.NumberFromString,
  format: 'number',
  defaultValue,
  description,
});

export const dbBoolean = (defaultValue: boolean, description?: string): DatabaseFieldDef<boolean> => ({
  schema: Schema.transform(Schema.String, Schema.Boolean, {
    decode: (s) => s === 'true' || s === '1',
    encode: (b) => (b ? 'true' : 'false'),
  }),
  format: 'boolean',
  defaultValue,
  description,
});

export const dbJson = <A>(
  schema: Schema.Schema<A, string>,
  defaultValue: A,
  description?: string,
): DatabaseFieldDef<A> => ({
  schema,
  format: 'json',
  defaultValue,
  description,
});
