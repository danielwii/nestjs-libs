import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import {
  Args,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  Mutation,
  Query,
  registerEnumType,
  Resolver,
} from '@nestjs/graphql';

import { resolveInboundSchema, SCHEMA_DTO_BRAND } from './schema-dto';
import { createSchemaArgsType, createSchemaInputType } from './schema-gql';

import { describe, expect, it } from 'bun:test';
import { printSchema } from 'graphql';
import { z } from 'zod';

enum ArticleVisibility {
  PUBLIC = 'PUBLIC',
  PRIVATE = 'PRIVATE',
}

registerEnumType(ArticleVisibility, { name: 'ArticleVisibility' });

describe('schema-gql (100% Zod v4 AST Native Auto-Derivation)', () => {
  const TagInputSchema = z
    .object({
      label: z.string().min(1),
    })
    .readonly();

  class TagInput extends createSchemaInputType(TagInputSchema, 'TagInput') {}

  const CreateArticleSchema = z.object({
    title: z.string().min(1).describe('文章標題'),
    viewCount: z.number().int(),
    rank: z.int(),
    score: z.number(),
    authorId: z.string().uuid(),
    traceId: z.uuid(),
    customId: z.string().meta({ gqlType: 'ID' }),
    isPublished: z.boolean(),
    visibility: z.enum(ArticleVisibility),
    summary: z.string().describe('可選摘要').optional(),
    nullableNote: z.string().nullable(),
    defaultCategory: z.string().default('general'),
    optionalDefaultLimit: z.number().int().optional().default(20),
    prefaultNote: z.string().prefault('fallback'),
    tags: z.array(z.string()),
    nullableItemTags: z.array(z.string().nullable()),
    optionalNullableItemTags: z.array(z.string().nullable()).optional(),
    nestedTag: TagInputSchema.optional(),
  });

  const QueryArgsSchema = z.object({
    keyword: z.string().describe('搜尋關鍵字'),
    limit: z.number().int().optional(),
  });

  describe('createSchemaInputType factory', () => {
    it('應 100% 從 Zod v4 AST 自動推導建立帶有 @InputType 與字段元數據的基類，且受 resolveInboundSchema 認可', () => {
      class CreateArticleInput extends createSchemaInputType(CreateArticleSchema, 'CreateArticleInput') {}

      // 1. 驗證 Schema 綁定與品牌標記
      expect(CreateArticleInput.schema).toBe(CreateArticleSchema as any);
      expect((CreateArticleInput as any)[SCHEMA_DTO_BRAND]).toBe(true);

      // 2. 驗證可被單一真理源 resolveInboundSchema 識別
      const resolved = resolveInboundSchema(CreateArticleInput);
      expect(resolved).toBe(CreateArticleSchema as any);

      // 3. 驗證 NestJS GraphQL 原生元數據正確附加並可被子類繼承
      const classType = Reflect.getMetadata('graphql:class_type', CreateArticleInput);
      expect(classType).toBe('inputType');

      // TagInput 作為嵌套引用
      expect(TagInput.schema).toBe(TagInputSchema as any);
    });

    it('若傳入無效 Schema 或非物件 Schema 應拋出 TypeError (Fail-Fast)', () => {
      expect(() => createSchemaInputType({} as any, 'InvalidInput')).toThrow(TypeError);
      expect(() => createSchemaInputType(z.string() as any, 'InvalidScalarInput')).toThrow(TypeError);
    });

    it('若嵌套物件 Schema 未先透過 createSchemaInputType 註冊應拋出 TypeError (Fail-Fast)', () => {
      const UnregisteredNestedSchema = z.object({
        nested: z.object({ foo: z.string() }),
      });
      expect(() => createSchemaInputType(UnregisteredNestedSchema, 'BadParentInput')).toThrow(TypeError);
    });
  });

  describe('createSchemaArgsType factory', () => {
    it('應 100% 從 Zod v4 AST 自動推導建立帶有 @ArgsType 與字段元數據的基類，且受 resolveInboundSchema 認可', () => {
      class QueryArgsDto extends createSchemaArgsType(QueryArgsSchema) {}

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

  describe('端到端 GraphQL SDL 真實生成驗證 (GraphQLSchemaFactory Dogfooding)', () => {
    it('應能被 NestJS GraphQLSchemaFactory 完整編譯並生成精確的 GraphQL SDL（含 String/Int/Float/ID/Boolean/Enum/List/Nullable/Description/NestedInput）', async () => {
      class CreateArticleInput extends createSchemaInputType(CreateArticleSchema, 'CreateArticleInput') {}
      class SearchArticleArgs extends createSchemaArgsType(QueryArgsSchema) {}

      @Resolver()
      class ArticleTestResolver {
        @Query(() => String)
        searchArticles(@Args() args: SearchArticleArgs): string {
          return args.keyword;
        }

        @Query(() => String)
        findByTag(@Args('tag') tag: TagInput): string {
          return tag.label;
        }

        @Mutation(() => String)
        createArticle(@Args('input') input: CreateArticleInput): string {
          return input.title;
        }
      }

      const app = await NestFactory.createApplicationContext(GraphQLSchemaBuilderModule, { logger: false });
      try {
        const factory = app.get(GraphQLSchemaFactory);
        const schema = await factory.create([ArticleTestResolver]);
        const sdl = printSchema(schema);

        // 驗證 ArgsType 展開至 Query 參數且保留 nullable 與 description
        expect(sdl).toContain('searchArticles(');
        expect(sdl).toContain('"""搜尋關鍵字"""');
        expect(sdl).toContain('keyword: String!');
        expect(sdl).toContain('limit: Int');

        // 驗證 InputType 所有標量、枚舉、陣列、可選與嵌套類型精確推導
        expect(sdl).toContain('input CreateArticleInput {');
        expect(sdl).toContain('"""文章標題"""');
        expect(sdl).toContain('title: String!');
        expect(sdl).toContain('viewCount: Int!');
        expect(sdl).toContain('rank: Int!');
        expect(sdl).toContain('score: Float!');
        expect(sdl).toContain('authorId: ID!');
        expect(sdl).toContain('traceId: ID!');
        expect(sdl).toContain('customId: ID!');
        expect(sdl).toContain('isPublished: Boolean!');
        expect(sdl).toContain('visibility: ArticleVisibility!');
        expect(sdl).toContain('"""可選摘要"""');
        expect(sdl).toContain('summary: String');
        expect(sdl).not.toContain('summary: String!');
        expect(sdl).toContain('nullableNote: String');
        expect(sdl).not.toContain('nullableNote: String!');
        expect(sdl).toContain('defaultCategory: String! = "general"');
        expect(sdl).toContain('optionalDefaultLimit: Int = 20');
        expect(sdl).toContain('prefaultNote: String');
        expect(sdl).not.toContain('prefaultNote: String!');
        expect(sdl).toContain('tags: [String!]!');
        expect(sdl).toContain('nullableItemTags: [String]!');
        expect(sdl).toContain('optionalNullableItemTags: [String]');
        expect(sdl).not.toContain('optionalNullableItemTags: [String]!');
        expect(sdl).toContain('nestedTag: TagInput');
        expect(sdl).toContain('input TagInput {');
        expect(sdl).toContain('label: String!');
      } finally {
        await app.close();
      }
    });
  });

  describe('編譯期型別安全驗證 (Type-Level Invariants)', () => {
    it('靜態型別負向約束：子類實例具備完整推導欄位，訪問未定義欄位時 tsc 報錯', () => {
      class MyArgs extends createSchemaArgsType(QueryArgsSchema) {}

      const instance = new MyArgs();
      const validKw: string = instance.keyword;
      expect(typeof validKw).toBe('undefined');

      // @ts-expect-error 訪問 Schema 之外未定義的欄位應報錯
      const invalid = instance.ghostField;
      expect(invalid).toBeUndefined();
    });
  });
});
