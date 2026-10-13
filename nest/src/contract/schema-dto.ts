import type { ArgumentMetadata } from '@nestjs/common';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * SchemaDto 唯一品牌標記符號。
 * 用於在 JavaScript 原型鏈中安全識別由 createSchemaDto 工廠生成的 DTO 基類，
 * 同時杜絕跨多層繼承或通用基類（如分頁基類）的原型污染。
 */
export const SCHEMA_DTO_BRAND: unique symbol = Symbol.for('@danielwii/libs:schema-dto');

/**
 * 具有 Standard Schema 靜態綁定與品牌標記的 DTO 類構造器介面。
 */
export interface SchemaDtoConstructor<TOutput = unknown, TInput = unknown> {
  new (): TOutput;
  readonly schema: StandardSchemaV1<TInput, TOutput>;
  readonly [SCHEMA_DTO_BRAND]: true;
}

/**
 * 判斷目標值是否符合 Standard Schema 規範（支援 Object 與 Callable Function 如 ArkType）。
 */
export function isStandardSchema(val: unknown): val is StandardSchemaV1 {
  return ((typeof val === 'object' && val !== null) || typeof val === 'function') && '~standard' in val;
}

/**
 * 創建帶有 Standard Schema 與品牌標記的 DTO 基類工廠。
 *
 * 解決 NestJS TypeScript 反射需要具名類（Named Class）以在 `design:paramtypes` 中保留元數據的限制，
 * 同時支援強型別推導（自動將 DTO 實例型別推導為 Schema 的 Output 型別）。
 *
 * 遵循單一繼承模式 (Single Subclass DTO Pattern)，僅提供基類繼承唯一形式：
 *
 * @example
 * class VerifyCodeDto extends createSchemaDto(VerifyCodeSchema) {}
 *
 * @param schema 符合 Standard Schema 規範的校驗器（Zod, ArkType, Valibot 等）
 */
export function createSchemaDto<
  TSchema extends StandardSchemaV1,
  TOutput = StandardSchemaV1.InferOutput<TSchema>,
  TInput = StandardSchemaV1.InferInput<TSchema>,
>(schema: TSchema): SchemaDtoConstructor<TOutput, TInput> {
  if (!isStandardSchema(schema)) {
    throw new TypeError(
      '[createSchemaDto] The provided schema does not satisfy the Standard Schema specification (~standard property missing).',
    );
  }

  class SchemaDtoHost {
    static readonly schema = schema;
    static readonly [SCHEMA_DTO_BRAND] = true as const;
  }

  return SchemaDtoHost as unknown as SchemaDtoConstructor<TOutput, TInput>;
}

/**
 * 解析入站目標（類、物件或 ArgumentMetadata）所持有的 Standard Schema。
 *
 * 核心安全設計（原型繼承安全與品牌守衛）：
 * 1. 靜態類別直接持有：類自身直接定義 static readonly schema 時（hasOwnProperty === true），解析成功。
 * 2. 類繼承工廠類：檢查目標類的「直接父類」（Object.getPrototypeOf(target)）。
 *    若直接父類具有 [SCHEMA_DTO_BRAND] === true 且直接父類自身持有 schema（hasOwnProperty === true），解析成功。
 * 3. 杜絕多層繼承污染：若子類繼承了形式 A 的 DTO（如 GrandChild extends VerifyCodeDto），
 *    GrandChild 的直接父類 VerifyCodeDto 自身並無 schema（其 schema 在 host 上），因此不解析，防止子類業務字段被意外剝離。
 * 4. 杜絕通用基類污染：通用基類（如 CursoredRequestInput）未帶 [SCHEMA_DTO_BRAND]，其子類不會繼承父類 schema。
 */
export function resolveInboundSchema(target: unknown): StandardSchemaV1 | undefined {
  if (!target) return undefined;

  // 1. 支援 ArgumentMetadata 兼容物件
  if (typeof target === 'object' && ('metatype' in target || 'schema' in target)) {
    const meta = target as Partial<ArgumentMetadata> & { schema?: unknown };
    if (isStandardSchema(meta.schema)) {
      return meta.schema;
    }
    return resolveInboundSchema(meta.metatype);
  }

  // 2. 目標自身就是 StandardSchema
  if (isStandardSchema(target)) {
    return target;
  }

  // 3. 目標是建構函數 / 類 (Function)
  if (typeof target === 'function') {
    // 3.1 形式 B：類自身直接持有 static schema
    if (Object.prototype.hasOwnProperty.call(target, 'schema')) {
      const owned = (target as { schema?: unknown }).schema;
      if (isStandardSchema(owned)) {
        return owned;
      }
    }

    // 3.2 形式 A：直接父類帶有品牌標記且直接父類自身持有 static schema
    const directParent = Object.getPrototypeOf(target);
    if (
      directParent &&
      typeof directParent === 'function' &&
      (directParent as { [SCHEMA_DTO_BRAND]?: boolean })[SCHEMA_DTO_BRAND] === true &&
      Object.prototype.hasOwnProperty.call(directParent, 'schema')
    ) {
      const parentSchema = (directParent as { schema?: unknown }).schema;
      if (isStandardSchema(parentSchema)) {
        return parentSchema;
      }
    }
  }

  return undefined;
}
