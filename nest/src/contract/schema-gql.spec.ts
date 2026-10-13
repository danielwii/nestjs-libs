import 'reflect-metadata';

import { resolveInboundSchema, SCHEMA_DTO_BRAND } from './schema-dto';
import { createSchemaArgsType, createSchemaInputType, gql } from './schema-gql';

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

describe('schema-gql (GraphQL Variants for Standard Schema)', () => {
  const CreateArticleSchema = z.object({
    title: z.string().min(1),
    viewCount: z.number().int(),
    score: z.number(),
    authorId: z.string().uuid(),
    isPublished: z.boolean(),
    summary: z.string().optional(),
    tags: z.array(z.string()),
  });

  const QueryArgsSchema = z.object({
    keyword: z.string(),
    limit: z.number().int().optional(),
  });

  describe('createSchemaInputType factory', () => {
    it('應成功建立帶有 @InputType 與字段元數據的基類，且受 resolveInboundSchema 認可', () => {
      class CreateArticleInput extends createSchemaInputType(CreateArticleSchema, 'CreateArticleInput', {
        title: { type: gql.string, nullable: false, description: '文章標題' },
        viewCount: { type: gql.int, nullable: false },
        score: { type: gql.float, nullable: false },
        authorId: { type: gql.id, nullable: false },
        isPublished: { type: gql.boolean, nullable: false },
        summary: { type: gql.string, nullable: true, description: '可選摘要' },
        tags: { type: gql.list(gql.string), nullable: false },
      }) {}

      // 1. 驗證 Schema 綁定與品牌標記
      expect(CreateArticleInput.schema).toBe(CreateArticleSchema as any);
      expect((CreateArticleInput as any)[SCHEMA_DTO_BRAND]).toBe(true);

      // 2. 驗證可被單一真理源 resolveInboundSchema 識別
      const resolved = resolveInboundSchema(CreateArticleInput);
      expect(resolved).toBe(CreateArticleSchema as any);

      // 3. 驗證 NestJS GraphQL 原生元數據正確附加並可被子類繼承
      const classType = Reflect.getMetadata('graphql:class_type', CreateArticleInput);
      expect(classType).toBe('inputType');
    });

    it('若傳入無效 Schema 應拋出 TypeError (Fail-Fast)', () => {
      expect(() => createSchemaInputType({} as any, 'InvalidInput', {} as any)).toThrow(TypeError);
    });
  });

  describe('createSchemaArgsType factory', () => {
    it('應成功建立帶有 @ArgsType 與字段元數據的基類，且受 resolveInboundSchema 認可', () => {
      class QueryArgsDto extends createSchemaArgsType(QueryArgsSchema, {
        keyword: { type: gql.string, nullable: false },
        limit: { type: gql.int, nullable: true },
      }) {}

      // 1. 驗證 Schema 綁定與品牌標記
      expect(QueryArgsDto.schema).toBe(QueryArgsSchema as any);
      expect((QueryArgsDto as any)[SCHEMA_DTO_BRAND]).toBe(true);

      // 2. 驗證可被單一真理源 resolveInboundSchema 識別
      const resolved = resolveInboundSchema(QueryArgsDto);
      expect(resolved).toBe(QueryArgsSchema as any);

      // 3. 驗證 NestJS GraphQL ArgsType 原生元數據正確附加並可被子類繼承
      const classType = Reflect.getMetadata('graphql:class_type', QueryArgsDto);
      expect(classType).toBe('args');
    });
  });

  describe('C1-C3 編譯期型別安全驗證 (Type-Level Invariants)', () => {
    it('靜態型別負向約束：子類實例訪問未定義欄位時 tsc 報錯', () => {
      class MyArgs extends createSchemaArgsType(QueryArgsSchema, {
        keyword: { type: gql.string, nullable: false },
        limit: { type: gql.int, nullable: true },
      }) {}

      const instance = new MyArgs();
      const validKw: string = instance.keyword;
      expect(typeof validKw).toBe('undefined');

      // @ts-expect-error 訪問 Schema 之外未定義的欄位應報錯
      const invalid = instance.ghostField;
      expect(invalid).toBeUndefined();
    });
  });
});
