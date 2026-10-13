import { createSchemaDto, isStandardSchema, resolveInboundSchema, SCHEMA_DTO_BRAND, SchemaDto } from './schema-dto';

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { ArgumentMetadata } from '@nestjs/common';
import type { StandardSchemaV1 } from '@standard-schema/spec';

describe('SchemaDto & resolveInboundSchema', () => {
  const UserSchema = z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    age: z.number().int().positive().optional(),
  });

  const PaginationSchema = z.object({
    cursor: z.string().optional(),
    limit: z.number().int().default(20),
  });

  describe('createSchemaDto factory', () => {
    it('應成功建立帶有品牌標記和靜態 schema 的基類', () => {
      const BaseDto = createSchemaDto(UserSchema, 'UserDto');

      expect(isStandardSchema(BaseDto.schema)).toBe(true);
      expect((BaseDto as any)[SCHEMA_DTO_BRAND]).toBe(true);
      expect(BaseDto.name).toBe('UserDto');
    });

    it('未指定類名時應預設為 AnonymousSchemaDto', () => {
      const BaseDto = SchemaDto(UserSchema);
      expect(BaseDto.name).toBe('AnonymousSchemaDto');
      expect((BaseDto as any)[SCHEMA_DTO_BRAND]).toBe(true);
    });

    it('若傳入不符合 Standard Schema 的物件應拋出 TypeError (Fail-Fast)', () => {
      expect(() => createSchemaDto({} as any)).toThrow(TypeError);
      expect(() => createSchemaDto(null as any)).toThrow(TypeError);
      expect(() => createSchemaDto(undefined as any)).toThrow(TypeError);
    });
  });

  describe('resolveInboundSchema', () => {
    it('形式 A：支援 class extends createSchemaDto(S) {} 形式的 DTO 解析', () => {
      class CreateUserDto extends createSchemaDto(UserSchema, 'CreateUserBase') {}

      const resolved = resolveInboundSchema(CreateUserDto);
      expect(resolved).toBeDefined();
      expect(resolved).toBe(UserSchema);
    });

    it('形式 B：支援原生類自身直接顯式聲明 static readonly schema 的 DTO 解析', () => {
      class PlainUserDto {
        static readonly schema = UserSchema;
        id!: string;
        email!: string;
      }

      const resolved = resolveInboundSchema(PlainUserDto);
      expect(resolved).toBeDefined();
      expect(resolved).toBe(UserSchema);
    });

    it('形式 C：支援工廠具名產生的 DTO 類直接解析', () => {
      const FactoryUserDto = createSchemaDto(UserSchema, 'FactoryUserDto');

      const resolved = resolveInboundSchema(FactoryUserDto);
      expect(resolved).toBeDefined();
      expect(resolved).toBe(UserSchema);
    });

    it('防原型污染 1：形式 A 的孫類（多層繼承）不應解析出父類的 schema', () => {
      class ParentDto extends createSchemaDto(UserSchema, 'ParentDto') {}
      // 孫類：GrandChildDto 繼承自 ParentDto，但 GrandChildDto 沒有聲明自身 schema，
      // ParentDto 自身也無 ownProperty 'schema'（schema 在 host 上）
      class GrandChildDto extends ParentDto {
        extraField!: string;
      }

      const resolved = resolveInboundSchema(GrandChildDto);
      expect(resolved).toBeUndefined();
    });

    it('防原型污染 2：未帶品牌標記的通用基類（如分頁基類），其子類不應繼承 schema', () => {
      // 模擬未走 createSchemaDto 的通用基類
      class CursoredRequestInput {
        static readonly schema = PaginationSchema;
        cursor?: string;
        limit?: number;
      }

      // 子類有自己的業務字段
      class QueryArticlesDto extends CursoredRequestInput {
        category!: string;
      }

      // 基類自身可解析
      expect(resolveInboundSchema(CursoredRequestInput)).toBe(PaginationSchema);

      // 子類絕不能隱式繼承基類 schema，防止 category 被 closed schema strip
      const resolved = resolveInboundSchema(QueryArticlesDto);
      expect(resolved).toBeUndefined();
    });

    it('直接傳入 StandardSchema 物件時應原樣返回', () => {
      expect(resolveInboundSchema(UserSchema)).toBe(UserSchema);
    });

    it('傳入 ArgumentMetadata 時應自動提取 metatype 或 schema', () => {
      class UpdateUserDto extends createSchemaDto(UserSchema) {}

      const metaWithMetatype: ArgumentMetadata = {
        type: 'body',
        metatype: UpdateUserDto,
      };
      expect(resolveInboundSchema(metaWithMetatype)).toBe(UserSchema);

      const metaWithSchema: ArgumentMetadata & { schema: StandardSchemaV1 } = {
        type: 'body',
        metatype: Object,
        schema: UserSchema,
      };
      expect(resolveInboundSchema(metaWithSchema)).toBe(UserSchema);
    });

    it('傳入無效目標或空值時應安全返回 undefined', () => {
      expect(resolveInboundSchema(undefined)).toBeUndefined();
      expect(resolveInboundSchema(null)).toBeUndefined();
      expect(resolveInboundSchema(class EmptyClass {})).toBeUndefined();
      expect(resolveInboundSchema('string-primitive')).toBeUndefined();
      expect(resolveInboundSchema({})).toBeUndefined();
    });
  });
});
