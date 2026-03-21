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
  /** 是否为项目级 scoped 字段（写入项目 scope 而非 'shared'） */
  readonly scoped?: boolean;
}

// ==================== 便捷工厂 ====================

interface DatabaseFieldOptions {
  readonly description?: string;
  readonly scoped?: boolean;
}

/** 第二参数可以是 string（description）或 options object */
type DescriptionOrOptions = string | DatabaseFieldOptions;

const resolveOptions = (descOrOpts?: DescriptionOrOptions): { description?: string; scoped?: boolean } =>
  typeof descOrOpts === 'string' ? { description: descOrOpts } : (descOrOpts ?? {});

export const dbString = (defaultValue?: string, descOrOpts?: DescriptionOrOptions): DatabaseFieldDef<string> => {
  const { description, scoped } = resolveOptions(descOrOpts);
  return { schema: Schema.String, format: 'string', defaultValue, description, scoped };
};

export const dbNumber = (defaultValue: number, descOrOpts?: DescriptionOrOptions): DatabaseFieldDef<number> => {
  const { description, scoped } = resolveOptions(descOrOpts);
  return { schema: Schema.NumberFromString, format: 'number', defaultValue, description, scoped };
};

export const dbBoolean = (defaultValue: boolean, descOrOpts?: DescriptionOrOptions): DatabaseFieldDef<boolean> => {
  const { description, scoped } = resolveOptions(descOrOpts);
  return {
    schema: Schema.transform(Schema.String, Schema.Boolean, {
      decode: (s) => s === 'true' || s === '1',
      encode: (b) => (b ? 'true' : 'false'),
    }),
    format: 'boolean',
    defaultValue,
    description,
    scoped,
  };
};

export const dbJson = <A>(
  schema: Schema.Schema<A, string>,
  defaultValue: A,
  descOrOpts?: DescriptionOrOptions,
): DatabaseFieldDef<A> => {
  const { description, scoped } = resolveOptions(descOrOpts);
  return { schema, format: 'json', defaultValue, description, scoped };
};
