import 'reflect-metadata';

import { Body, Controller, forwardRef, Get, Headers, Module, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Args, Query as GqlQuery, Resolver } from '@nestjs/graphql';
import { GrpcMethod } from '@nestjs/microservices';

import { RawInput } from '@app/nest/contract/raw-input';
import { createSchemaDto } from '@app/nest/contract/schema-dto';

import { collectInboundContractCoverage } from './contract-coverage';

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

describe('collectInboundContractCoverage (Multi-Protocol Inbound Coverage)', () => {
  const UserSchema = z.object({
    username: z.string().min(3),
    email: z.string().email(),
  });

  const QuerySchema = z.object({
    page: z.number().int().default(1),
  });

  const GrpcSchema = z.object({
    id: z.string().uuid(),
  });

  class CreateUserDto extends createSchemaDto(UserSchema) {}

  class SearchQueryDto {
    static readonly schema = QuerySchema;
    page!: number;
  }

  class GrpcPayloadDto extends createSchemaDto(GrpcSchema) {}

  class UnprotectedDto {
    name!: string;
  }

  // 1. HTTP Controller
  @Controller('users')
  class UsersController {
    // Covered: 形式 A DTO
    @Post()
    createUser(@Body() dto: CreateUserDto) {
      return dto;
    }

    // Covered: 形式 B DTO
    @Get()
    listUsers(@Query() query: SearchQueryDto) {
      return query;
    }

    // Uncovered: 單欄位提取未加 Schema
    @Post('verify')
    verifyCode(@Body('code') code: string) {
      return { code };
    }

    // Uncovered: 未綁定 Schema 的普通類
    @Post('unprotected')
    unprotectedAction(@Body() body: UnprotectedDto) {
      return body;
    }

    // Exempted: 顯式標記 @RawInput 豁免
    @Post('webhook/raw')
    rawWebhook(
      @RawInput('Third-party raw cryptographic signature verification', '待提供官方 Schema 後退場')
      @Body()
      rawPayload: any,
    ) {
      return rawPayload;
    }

    // 框架傳輸層上下文：@Headers, @Req, @Res 自動豁免，不佔用邊界審計分母
    @Get('headers-test')
    testHeaders(@Headers('x-trace-id') traceId: string, @Req() req: any, @Res() res: any) {
      return { traceId, req, res };
    }
  }

  // 2. GraphQL Resolver
  @Resolver()
  class UsersResolver {
    // Covered: @Args 綁定 Standard Schema DTO
    @GqlQuery(() => String)
    queryUser(@Args('input') input: CreateUserDto) {
      return input.username;
    }

    // Uncovered: @Args 未綁定 Schema
    @GqlQuery(() => String)
    rawArgsQuery(@Args('filter') filter: string) {
      return filter;
    }

    // Exempted: @Args 使用 @RawInput 豁免
    @GqlQuery(() => String)
    exemptArgsQuery(
      @RawInput('Dynamic GraphQL JSON filter passthrough', '待規範標準過濾器結構後退場')
      @Args('jsonFilter')
      jsonFilter: any,
    ) {
      return jsonFilter;
    }
  }

  // 3. gRPC Microservice Controller
  @Controller()
  class UsersGrpcController {
    // Covered: gRPC 方法入參綁定 Standard Schema
    @GrpcMethod('UsersService', 'FindOne')
    findOne(data: GrpcPayloadDto) {
      return data;
    }

    // Uncovered: gRPC 方法入參無 Schema 且無豁免
    @GrpcMethod('UsersService', 'UnprotectedRpc')
    unprotectedRpc(data: UnprotectedDto) {
      return data;
    }

    // Exempted: gRPC 方法入參標記 @RawInput
    @GrpcMethod('UsersService', 'RawRpc')
    rawRpc(
      @RawInput('Protobuf binary stream handled via low-level parser', '持續保留')
      data: any,
    ) {
      return data;
    }
  }

  @Module({
    controllers: [UsersController, UsersGrpcController],
    providers: [UsersResolver],
  })
  class TestRootModule {}

  it('應覆蓋 HTTP, GraphQL @Args 與 gRPC 三大協議並精確統計各協議輸入', () => {
    const report = collectInboundContractCoverage(TestRootModule);

    // 總輸入分母計數：
    // HTTP: 5 (createUser body, listUsers query, verifyCode body, unprotectedAction body, rawWebhook body)
    // 注意：testHeaders 上的 @Headers, @Req, @Res 均為框架上下文，不計入審計分母
    // GraphQL: 3 (queryUser args, rawArgsQuery args, exemptArgsQuery args)
    // gRPC: 3 (findOne payload, unprotectedRpc payload, rawRpc payload)
    // Total = 5 + 3 + 3 = 11
    expect(report.total).toBe(11);
    expect(report.httpInputs).toBe(5);
    expect(report.graphqlInputs).toBe(3);
    expect(report.grpcInputs).toBe(3);

    // 覆蓋與未覆蓋統計：
    // Covered: 4 (HTTP: createUser, listUsers; GraphQL: queryUser; gRPC: findOne)
    // Exempted: 3 (HTTP: rawWebhook; GraphQL: exemptArgsQuery; gRPC: rawRpc)
    // Uncovered: 4 (HTTP: verifyCode, unprotectedAction; GraphQL: rawArgsQuery; gRPC: unprotectedRpc)
    expect(report.covered).toBe(4);
    expect(report.exempt).toBe(3);
    expect(report.uncovered).toBe(4);

    // 驗證未覆蓋清單
    expect(report.uncoveredInputs).toHaveLength(4);

    const httpUncovered = report.uncoveredInputs.find((u) => u.transport === 'http' && u.method === 'verifyCode');
    expect(httpUncovered).toBeDefined();
    expect(httpUncovered?.kind).toBe('body');
    expect(httpUncovered?.dataName).toBe('code');

    const gqlUncovered = report.uncoveredInputs.find((u) => u.transport === 'graphql' && u.method === 'rawArgsQuery');
    expect(gqlUncovered).toBeDefined();
    expect(gqlUncovered?.kind).toBe('args');
    expect(gqlUncovered?.dataName).toBe('filter');

    const grpcUncovered = report.uncoveredInputs.find((u) => u.transport === 'grpc' && u.method === 'unprotectedRpc');
    expect(grpcUncovered).toBeDefined();
    expect(grpcUncovered?.kind).toBe('payload');

    // 驗證豁免清單包含退場條件
    expect(report.exemptInputs).toHaveLength(3);
    const rawWebhookExempt = report.exemptInputs.find((e) => e.method === 'rawWebhook');
    expect(rawWebhookExempt?.exitCondition).toBe('待提供官方 Schema 後退場');
  });

  it('支援 DynamicModule 與 forwardRef 模組樹深度解析', () => {
    @Resolver()
    class DynamicFeatureResolver {
      @GqlQuery(() => String)
      queryDynamic(@Args('term') term: string) {
        return term;
      }
    }

    const DynamicFeatureModule = {
      module: class FeatureModule {},
      providers: [DynamicFeatureResolver],
    };

    @Module({
      imports: [forwardRef(() => DynamicFeatureModule as any)],
    })
    class RootDynamicModule {}

    const report = collectInboundContractCoverage(RootDynamicModule);
    expect(report.total).toBe(1);
    expect(report.graphqlInputs).toBe(1);
    expect(report.uncovered).toBe(1);
    expect(report.uncoveredInputs[0]?.transport).toBe('graphql');
  });

  describe('零入參防護門禁 (Fail-Fast Zero Inputs Invariant)', () => {
    it('當模組完全沒有入站參數時應拋出異常，嚴禁報 100% 虛假覆蓋', () => {
      @Controller('empty')
      class EmptyController {
        @Get('ping')
        ping() {
          return 'pong';
        }
      }

      @Module({
        controllers: [EmptyController],
      })
      class EmptyModule {}

      expect(() => collectInboundContractCoverage(EmptyModule)).toThrow(
        '[contract-coverage] No inbound inputs discovered in module tree.',
      );
    });
  });
});
