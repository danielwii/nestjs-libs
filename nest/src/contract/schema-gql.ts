import 'reflect-metadata';

import { ArgsType, Field, Float, ID, InputType, Int, TypeMetadataStorage } from '@nestjs/graphql';

import { isStandardSchema, SCHEMA_DTO_BRAND } from './schema-dto';

import type { SchemaDtoConstructor } from './schema-dto';
import type { Type } from '@nestjs/common';
import type { FieldOptions, ReturnTypeFuncValue } from '@nestjs/graphql';
import type { StandardSchemaV1 } from '@standard-schema/spec';

export type GqlInput<S extends StandardSchemaV1> = StandardSchemaV1.InferInput<S>;

interface ZodDefLike {
  type?: string;
  format?: string;
  isInt?: boolean;
  check?: string;
  checks?: Array<{
    _zod?: { def?: ZodDefLike };
    def?: ZodDefLike;
  }>;
  innerType?: unknown;
  in?: unknown;
  schema?: unknown;
  element?: unknown;
  defaultValue?: unknown;
  entries?: Record<string, string | number>;
  shape?: Record<string, unknown> | (() => Record<string, unknown>);
}

interface ZodNodeLike {
  _zod?: { def?: ZodDefLike };
  def?: ZodDefLike;
  shape?: Record<string, unknown>;
  description?: string;
  isOptional?: () => boolean;
  isNullable?: () => boolean;
  meta?: () => Record<string, unknown> | undefined;
}

interface UnwrappedFieldAnalysis {
  leafNode: ZodNodeLike;
  leafDef: ZodDefLike;
  nullable: boolean;
  hasDefaultValue: boolean;
  defaultValue?: unknown;
  description?: string;
  meta: Record<string, unknown>;
}

/**
 * 註冊表：紀錄透過 createSchemaInputType 建立的 Schema -> InputType Host 映射，
 * 支援嵌套對象 Schema 自動解析對應的 GraphQL InputType。
 */
const SCHEMA_INPUT_TYPE_REGISTRY = new WeakMap<object, Type<unknown>>();

function getZodDef(node: unknown): ZodDefLike | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const candidate = node as ZodNodeLike;
  return candidate._zod?.def ?? candidate.def;
}

/**
 * 從根 Schema 提取物件欄位定義表 (shape)。
 * 支援直接 z.object() 或包裹在 pipe / transform / readonly 外層的物件 Schema。
 */
function extractObjectShape(schema: unknown, callerName: string): Record<string, unknown> {
  let current: unknown = schema;
  const visited = new Set<unknown>();

  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const node = current as ZodNodeLike;

    if (node.shape && typeof node.shape === 'object') {
      return node.shape;
    }

    const def = getZodDef(node);
    if (!def) break;

    if (def.shape) {
      return typeof def.shape === 'function' ? def.shape() : def.shape;
    }

    current = def.innerType ?? def.in ?? def.schema;
  }

  throw new TypeError(
    `[${callerName}] Schema must be a Zod object schema with an inspectable shape for automatic GraphQL SDL derivation.`,
  );
}

/**
 * 遞歸剝離欄位外層修飾器 (optional / nullable / default / prefault / readonly / pipe)，
 * 並沿途聚合 nullable 狀態、description 與 .meta() 元數據。
 */
function analyzeFieldSchema(fieldSchema: unknown): UnwrappedFieldAnalysis {
  let current: unknown = fieldSchema;
  let nullable = false;
  let hasDefaultValue = false;
  let defaultValue: unknown;
  let description: string | undefined;
  const mergedMeta: Record<string, unknown> = {};
  const visited = new Set<unknown>();

  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const node = current as ZodNodeLike;
    const nodeMeta = typeof node.meta === 'function' ? node.meta() : undefined;

    if (nodeMeta && typeof nodeMeta === 'object') {
      for (const [k, v] of Object.entries(nodeMeta)) {
        if (mergedMeta[k] === undefined) {
          mergedMeta[k] = v;
        }
      }
    }

    if (description === undefined) {
      const metaDesc = typeof nodeMeta?.description === 'string' ? nodeMeta.description : undefined;
      description = node.description ?? metaDesc;
    }

    const def = getZodDef(node);
    if (!def) {
      return { leafNode: node, leafDef: {}, nullable, hasDefaultValue, defaultValue, description, meta: mergedMeta };
    }

    if (def.type === 'optional' || def.type === 'nullable') {
      nullable = true;
      if (def.innerType) {
        current = def.innerType;
        continue;
      }
    }

    if (def.type === 'default') {
      const resolvedDefault = def.defaultValue;
      if (!hasDefaultValue && resolvedDefault !== undefined && typeof resolvedDefault !== 'function') {
        hasDefaultValue = true;
        defaultValue = resolvedDefault;
      } else if (!hasDefaultValue) {
        nullable = true;
      }
      if (def.innerType) {
        current = def.innerType;
        continue;
      }
    }

    if (def.type === 'prefault') {
      nullable = true;
      if (def.innerType) {
        current = def.innerType;
        continue;
      }
    }

    if (def.type === 'nonoptional') {
      if (def.innerType) {
        current = def.innerType;
        continue;
      }
    }

    if (def.type === 'readonly' || def.type === 'catch') {
      if (def.innerType) {
        current = def.innerType;
        continue;
      }
    }

    if (def.type === 'pipe' || def.type === 'transform') {
      const next = def.in ?? def.innerType ?? def.schema;
      if (next) {
        current = next;
        continue;
      }
    }

    return { leafNode: node, leafDef: def, nullable, hasDefaultValue, defaultValue, description, meta: mergedMeta };
  }

  return {
    leafNode: (current as ZodNodeLike | undefined) ?? {},
    leafDef: getZodDef(current) ?? {},
    nullable,
    hasDefaultValue,
    defaultValue,
    description,
    meta: mergedMeta,
  };
}

function isIntegerDef(def: ZodDefLike): boolean {
  if (def.type === 'int' || def.format === 'safeint' || def.format === 'int32' || def.isInt === true) {
    return true;
  }
  if (Array.isArray(def.checks)) {
    return def.checks.some((chk) => {
      const cDef = chk._zod?.def ?? chk.def;
      return cDef?.format === 'safeint' || cDef?.format === 'int32' || cDef?.isInt === true || cDef?.check === 'int';
    });
  }
  return false;
}

function isUuidOrIdDef(def: ZodDefLike, meta: Record<string, unknown>): boolean {
  if (meta.gqlId === true || meta.id === true || meta.gqlType === 'ID' || meta.gqlType === ID) {
    return true;
  }
  if (def.type === 'uuid' || def.type === 'guid' || def.format === 'uuid' || def.format === 'guid') {
    return true;
  }
  if (Array.isArray(def.checks)) {
    return def.checks.some((chk) => {
      const cDef = chk._zod?.def ?? chk.def;
      return cDef?.format === 'uuid' || cDef?.format === 'guid';
    });
  }
  return false;
}

function resolveGqlTypeFn(
  analysis: UnwrappedFieldAnalysis,
  propertyKey: string,
  callerName: string,
): () => ReturnTypeFuncValue {
  const { leafNode, leafDef, meta } = analysis;

  // 1. 優先支援 Zod v4 原生 .meta({ gqlType: 'ID' }) / .meta({ gqlId: true })
  if (meta.gqlId === true || meta.id === true || meta.gqlType === 'ID' || meta.gqlType === ID) {
    return () => ID;
  }
  if (meta.gqlType === 'Int' || meta.gqlType === Int) {
    return () => Int;
  }
  if (meta.gqlType === 'Float' || meta.gqlType === Float) {
    return () => Float;
  }
  if (typeof meta.gqlType === 'function' || (typeof meta.gqlType === 'object' && meta.gqlType !== null)) {
    const customType = meta.gqlType as ReturnTypeFuncValue;
    return () => customType;
  }

  // 2. 檢查是否為已透過 createSchemaInputType 註冊的嵌套 Schema
  const registeredTopInput = SCHEMA_INPUT_TYPE_REGISTRY.get(leafNode);
  if (registeredTopInput) {
    return () => registeredTopInput;
  }

  // 3. 根據 Zod v4 _zod.def.type 自動推導
  switch (leafDef.type) {
    case 'string':
    case 'uuid':
    case 'guid':
    case 'cuid':
    case 'cuid2':
    case 'ulid':
    case 'nanoid': {
      if (isUuidOrIdDef(leafDef, meta)) {
        return () => ID;
      }
      return () => String;
    }

    case 'number':
    case 'int': {
      if (isIntegerDef(leafDef)) {
        return () => Int;
      }
      return () => Float;
    }

    case 'boolean':
      return () => Boolean;

    case 'date':
      return () => Date;

    case 'enum':
    case 'nativeEnum': {
      if (leafDef.entries && typeof leafDef.entries === 'object') {
        const enumRef = leafDef.entries;
        return () => enumRef;
      }
      throw new TypeError(`[${callerName}] Enum field '${propertyKey}' is missing enum entries.`);
    }

    case 'array': {
      if (!leafDef.element) {
        throw new TypeError(`[${callerName}] Array field '${propertyKey}' is missing an element schema.`);
      }
      const elementAnalysis = analyzeFieldSchema(leafDef.element);
      const elementTypeFn = resolveGqlTypeFn(elementAnalysis, `${propertyKey}[]`, callerName);
      return () => [elementTypeFn()];
    }

    case 'object': {
      const registeredInput = SCHEMA_INPUT_TYPE_REGISTRY.get(leafNode);
      if (registeredInput) {
        return () => registeredInput as ReturnTypeFuncValue;
      }
      throw new TypeError(
        `[${callerName}] Nested object field '${propertyKey}' must be created via createSchemaInputType() first or annotated with .meta({ gqlType }).`,
      );
    }

    default:
      throw new TypeError(
        `[${callerName}] Unsupported Zod schema type '${leafDef.type ?? 'unknown'}' on field '${propertyKey}'.`,
      );
  }
}

function resolveFieldNullableOption(analysis: UnwrappedFieldAnalysis): boolean | 'items' | 'itemsAndList' {
  if (analysis.leafDef.type === 'array' && analysis.leafDef.element) {
    const elementAnalysis = analyzeFieldSchema(analysis.leafDef.element);
    if (elementAnalysis.nullable) {
      return analysis.nullable ? 'itemsAndList' : 'items';
    }
  }
  return analysis.nullable;
}

function attachAutoDerivedFields(prototype: object, schema: unknown, callerName: string): void {
  const shape = extractObjectShape(schema, callerName);
  for (const [propertyKey, fieldSchema] of Object.entries(shape)) {
    const analysis = analyzeFieldSchema(fieldSchema);
    const typeFn = resolveGqlTypeFn(analysis, propertyKey, callerName);
    const nullableOpt = resolveFieldNullableOption(analysis);
    const fieldOptions: FieldOptions =
      nullableOpt === true
        ? {
            nullable: true,
            description: analysis.description,
            ...(analysis.hasDefaultValue ? { defaultValue: analysis.defaultValue } : {}),
          }
        : {
            nullable: nullableOpt,
            description: analysis.description,
            ...(analysis.hasDefaultValue ? { defaultValue: analysis.defaultValue } : {}),
          };
    const decorator = Field(typeFn, fieldOptions);
    decorator(prototype, propertyKey);
  }
}

interface GqlLazyMetadataStorageLike {
  store: (fn: () => void) => void;
}

function getGqlLazyStorage(): GqlLazyMetadataStorageLike | undefined {
  return (globalThis as { GqlLazyMetadataStorageHost?: GqlLazyMetadataStorageLike }).GqlLazyMetadataStorageHost;
}

/**
 * 讓 `class MyInput extends createSchemaInputType(schema, 'MyInput') {}`
 * 無需在子類重複標註 `@InputType()` 即可被 NestJS GraphQL `GraphQLSchemaFactory` 自動識別。
 */
function registerSubclassAutoPromotion(hostClass: Type<unknown>, kind: 'inputType' | 'args', name?: string): void {
  const lazyStorage = getGqlLazyStorage();
  if (!lazyStorage) return;

  lazyStorage.store(() => {
    const allOperations = [
      ...TypeMetadataStorage.getQueriesMetadata(),
      ...TypeMetadataStorage.getMutationsMetadata(),
      ...TypeMetadataStorage.getSubscriptionsMetadata(),
    ];

    const collection = (
      TypeMetadataStorage as unknown as {
        metadataByTargetCollection?: {
          get: (target: object) => {
            params: { getByName: (methodName: string) => Array<{ kind?: string; typeFn?: () => unknown }> };
          };
        };
      }
    ).metadataByTargetCollection;

    if (!collection) return;

    const promoteTarget = (candidate: unknown) => {
      if (
        typeof candidate !== 'function' ||
        (candidate !== hostClass && !Object.prototype.isPrototypeOf.call(hostClass, candidate))
      ) {
        return;
      }

      const targetType = candidate as Type<unknown>;

      if (kind === 'inputType') {
        if (targetType !== hostClass) {
          const hostMeta = TypeMetadataStorage.getInputTypeMetadataByTarget(hostClass);
          if (hostMeta) {
            hostMeta.isAbstract = true;
          }
        }
        const existing = TypeMetadataStorage.getInputTypeMetadataByTarget(targetType);
        if (!existing) {
          TypeMetadataStorage.addInputTypeMetadata({
            target: targetType,
            name: name ?? targetType.name,
            isAbstract: false,
          });
        }
      } else {
        const existing = TypeMetadataStorage.getArgumentsMetadataByTarget(targetType);
        if (!existing) {
          TypeMetadataStorage.addArgsMetadata({
            target: targetType,
            name: targetType.name || hostClass.name,
          });
        }
      }
    };

    for (const op of allOperations) {
      const params = collection.get(op.target).params.getByName(op.methodName);
      for (const param of params) {
        const rawType = param.typeFn?.();
        const candidate = Array.isArray(rawType) ? rawType[0] : rawType;
        promoteTarget(candidate);
      }
    }

    for (const inputMeta of TypeMetadataStorage.getInputTypesMetadata()) {
      const fields = (
        collection.get(inputMeta.target) as unknown as {
          fields?: { getAll: () => Array<{ typeFn?: () => unknown }> };
        }
      ).fields?.getAll();
      if (!fields) continue;
      for (const field of fields) {
        const rawType = field.typeFn?.();
        const candidate = Array.isArray(rawType) ? rawType[0] : rawType;
        promoteTarget(candidate);
      }
    }
  });
}

/**
 * 創建 GraphQL @InputType() 類型的 Schema DTO 基類工廠（100% 從 Zod v4 AST 自動推導，零手寫字段表）。
 *
 * @param schema 符合 Standard Schema 規範的 Zod v4 物件 Schema
 * @param name GraphQL SDL 中的 InputType 唯一名稱
 */
export function createSchemaInputType<S extends StandardSchemaV1>(
  schema: S,
  name: string,
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

  Object.defineProperty(SchemaInputHost, 'name', { value: name });

  // 1. 從 Zod v4 AST 自動推導並附加 @Field()
  attachAutoDerivedFields(SchemaInputHost.prototype, schema, 'createSchemaInputType');

  // 2. 附加 @InputType(name)
  InputType(name)(SchemaInputHost);
  registerSubclassAutoPromotion(SchemaInputHost, 'inputType', name);

  // 3. 註冊 Schema -> Host 映射以支援嵌套對象自動關聯
  SCHEMA_INPUT_TYPE_REGISTRY.set(schema, SchemaInputHost);
  SCHEMA_INPUT_TYPE_REGISTRY.set(SchemaInputHost, SchemaInputHost);

  return SchemaInputHost;
}

/**
 * 創建 GraphQL @ArgsType() 類型的 Schema DTO 基類工廠（100% 從 Zod v4 AST 自動推導，零手寫字段表）。
 * 用於將標量 `@Args('x', { type })` 收整為整體 DTO 時，SDL 中展開成相同的參數列表，確保 GraphQL SDL 契約不變。
 *
 * @param schema 符合 Standard Schema 規範的 Zod v4 物件 Schema
 */
export function createSchemaArgsType<S extends StandardSchemaV1>(
  schema: S,
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

  // 1. 從 Zod v4 AST 自動推導並附加 @Field()
  attachAutoDerivedFields(SchemaArgsHost.prototype, schema, 'createSchemaArgsType');

  // 2. 附加 @ArgsType()
  ArgsType()(SchemaArgsHost);
  registerSubclassAutoPromotion(SchemaArgsHost, 'args');

  return SchemaArgsHost;
}
