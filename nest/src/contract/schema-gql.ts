import 'reflect-metadata';

import { ArgsType, Field, Float, ID, InputType, Int } from '@nestjs/graphql';

import { isStandardSchema, SCHEMA_DTO_BRAND } from './schema-dto';

import type { SchemaDtoConstructor } from './schema-dto';
import type { ReturnTypeFuncValue } from '@nestjs/graphql';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/** 幽靈類型載體：T 只在類型層存在，運行時攜帶 GraphQL 類型引用函數 */
export interface GqlType<T> {
  readonly __type?: T;
  readonly typeFn: () => ReturnTypeFuncValue;
}

/**
 * 類型化 GraphQL 詞彙表。
 * 僅在編譯期攜帶 TS 類型標記，運行時提供精確的 GraphQL 標量、枚舉或類型引用。
 */
export const gql = {
  int: { typeFn: () => Int } as GqlType<number>,
  float: { typeFn: () => Float } as GqlType<number>,
  id: { typeFn: () => ID } as GqlType<string>,
  string: { typeFn: () => String } as GqlType<string>,
  boolean: { typeFn: () => Boolean } as GqlType<boolean>,
  enum: <E extends Record<string, string | number>>(registered: E): GqlType<E[keyof E]> => ({
    typeFn: () => registered,
  }),
  input: <C extends new () => object>(cls: C): GqlType<InstanceType<C>> => ({
    typeFn: () => cls,
  }),
  list: <T>(item: GqlType<T>): GqlType<T[]> => ({
    typeFn: () => [item.typeFn()],
  }),
};

/**
 * GraphQL 字段表類型定義。
 * 字段表的類型由 StandardSchemaV1.InferInput<S> 算出（GraphQL 交來的是轉型前的值）。
 *
 * 滿足編譯期三條約束（早於 CI，tsc 直接攔截）：
 *   C1 鍵與 schema 輸入鍵完全一致：缺鍵、多鍵都是編譯錯誤。
 *   C2 GraphQL 類型與該鍵 TS 類型相容：number 不能配 gql.string 等。
 *   C3 nullable 必須與 TS 類型一致：可為 undefined 或 null 的鍵必須寫 true，否則必須寫 false；寫反是編譯錯誤。
 */
export type GqlFieldTable<I> = {
  [K in keyof I]-?: {
    type: GqlType<NonNullable<I[K]>>;
    nullable: undefined extends I[K] ? true : null extends I[K] ? true : false;
    description?: string;
  };
};

export type GqlInput<S extends StandardSchemaV1> = StandardSchemaV1.InferInput<S>;

/**
 * 創建 GraphQL @InputType() 類型的 Schema DTO 基類工廠。
 *
 * @param schema 符合 Standard Schema 規範的校驗器
 * @param name GraphQL SDL 中的 InputType 唯一名稱
 * @param fields 類型化字段表（編譯期驗證 C1-C3 約束）
 */
export function createSchemaInputType<S extends StandardSchemaV1>(
  schema: S,
  name: string,
  fields: GqlFieldTable<GqlInput<S>>,
): SchemaDtoConstructor<StandardSchemaV1.InferOutput<S>, StandardSchemaV1.InferInput<S>> {
  if (!isStandardSchema(schema)) {
    throw new TypeError(
      '[createSchemaInputType] The provided schema does not satisfy the Standard Schema specification.',
    );
  }

  class SchemaInputHost {
    static readonly schema = schema;
    static readonly [SCHEMA_DTO_BRAND] = true as const;
  }

  // 1. 附加 @InputType(name)
  InputType(name)(SchemaInputHost);

  // 2. 遍歷字段表，附加 @Field()
  attachFields(SchemaInputHost.prototype, fields);

  return SchemaInputHost;
}

/**
 * 創建 GraphQL @ArgsType() 類型的 Schema DTO 基類工廠。
 * 用於將標量 `@Args('x', { type })` 收整為整體 DTO 時，SDL 中展開成相同的參數列表，契約不變 (I6)。
 *
 * @param schema 符合 Standard Schema 規範的校驗器
 * @param fields 類型化字段表（編譯期驗證 C1-C3 約束）
 */
export function createSchemaArgsType<S extends StandardSchemaV1>(
  schema: S,
  fields: GqlFieldTable<GqlInput<S>>,
): SchemaDtoConstructor<StandardSchemaV1.InferOutput<S>, StandardSchemaV1.InferInput<S>> {
  if (!isStandardSchema(schema)) {
    throw new TypeError(
      '[createSchemaArgsType] The provided schema does not satisfy the Standard Schema specification.',
    );
  }

  class SchemaArgsHost {
    static readonly schema = schema;
    static readonly [SCHEMA_DTO_BRAND] = true as const;
  }

  // 1. 附加 @ArgsType()
  ArgsType()(SchemaArgsHost);

  // 2. 遍歷字段表，附加 @Field()
  attachFields(SchemaArgsHost.prototype, fields);

  return SchemaArgsHost;
}

interface GqlFieldConfig {
  type: {
    typeFn: () => ReturnTypeFuncValue;
  };
  nullable?: boolean;
  description?: string;
}

function attachFields(prototype: object, fields: Record<string, GqlFieldConfig>): void {
  for (const [propertyKey, config] of Object.entries(fields)) {
    const typeFn = config.type.typeFn;
    const decorator = Field(typeFn, {
      nullable: config.nullable ?? false,
      description: config.description,
    });
    decorator(prototype, propertyKey);
  }
}
