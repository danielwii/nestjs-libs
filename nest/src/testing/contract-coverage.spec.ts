import 'reflect-metadata';

import { Body, Controller, forwardRef, Get, Headers, Module, Post, Query, Req, Res } from '@nestjs/common';
import { Args, Query as GqlQuery, Resolver } from '@nestjs/graphql';
import { Ctx, GrpcMethod, Payload } from '@nestjs/microservices';

import { createSchemaDto } from '@app/nest/contract/schema-dto';

import { collectInboundContractCoverage } from './contract-coverage';

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

describe('collectInboundContractCoverage (Multi-Protocol Inbound Coverage, Zero Escape Hatch)', () => {
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

    // 框架傳輸層上下文：@Headers, @Req, @Res 自動識別，不佔用邊界審計分母
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
  }

  // 3. gRPC Microservice Controller
  @Controller()
  class UsersGrpcController {
    // Covered: gRPC 方法入參綁定 Standard Schema
    @GrpcMethod('UsersService', 'FindOne')
    findOne(data: GrpcPayloadDto) {
      return data;
    }

    // Uncovered: gRPC 方法入參無 Schema
    @GrpcMethod('UsersService', 'UnprotectedRpc')
    unprotectedRpc(data: UnprotectedDto) {
      return data;
    }
  }

  @Module({
    controllers: [UsersController, UsersGrpcController],
    providers: [UsersResolver],
  })
  class TestRootModule {}

  it('應覆蓋 HTTP, GraphQL @Args 與 gRPC 三大協議並精確統計各協議輸入（零豁免逃生口）', () => {
    const report = collectInboundContractCoverage(TestRootModule);

    // 總輸入分母計數：
    // HTTP: 4 (createUser body, listUsers query, verifyCode body, unprotectedAction body)
    // 注意：testHeaders 上的 @Headers, @Req, @Res 均為框架上下文，不計入審計分母
    // GraphQL: 2 (queryUser args, rawArgsQuery args)
    // gRPC: 2 (findOne payload, unprotectedRpc payload)
    // Total = 4 + 2 + 2 = 8
    expect(report.total).toBe(8);
    expect(report.httpInputs).toBe(4);
    expect(report.graphqlInputs).toBe(2);
    expect(report.grpcInputs).toBe(2);

    // 覆蓋與未覆蓋統計：
    // Covered: 4 (HTTP: createUser, listUsers; GraphQL: queryUser; gRPC: findOne)
    // Uncovered: 4 (HTTP: verifyCode, unprotectedAction; GraphQL: rawArgsQuery; gRPC: unprotectedRpc)
    expect(report.covered).toBe(4);
    expect(report.uncovered).toBe(4);

    // 驗證未覆蓋清單
    expect(report.uncoveredInputs).toHaveLength(4);

    const httpUncovered = report.uncoveredInputs.find((u) => u.transport === 'http' && u.method === 'verifyCode');
    expect(httpUncovered).toBeDefined();
    expect(httpUncovered?.location).toBe('UsersController.verifyCode#0');
    expect(httpUncovered?.kind).toBe('body');
    expect(httpUncovered?.dataName).toBe('code');

    const gqlUncovered = report.uncoveredInputs.find((u) => u.transport === 'graphql' && u.method === 'rawArgsQuery');
    expect(gqlUncovered).toBeDefined();
    expect(gqlUncovered?.location).toBe('UsersResolver.rawArgsQuery#0');
    expect(gqlUncovered?.kind).toBe('args');
    expect(gqlUncovered?.dataName).toBe('filter');

    const grpcUncovered = report.uncoveredInputs.find((u) => u.transport === 'grpc' && u.method === 'unprotectedRpc');
    expect(grpcUncovered).toBeDefined();
    expect(grpcUncovered?.location).toBe('UsersGrpcController.unprotectedRpc#0');
    expect(grpcUncovered?.kind).toBe('payload');
  });

  it('支援傳入多根模組陣列，依 location 去重求並集', () => {
    @Controller('extra')
    class ExtraController {
      @Post('submit')
      submit(@Body() dto: CreateUserDto) {
        return dto;
      }
    }

    @Module({
      controllers: [ExtraController],
    })
    class ExtraModule {}

    // 1. 傳入 [TestRootModule, ExtraModule]：新增 1 個 covered 入參
    const unionReport = collectInboundContractCoverage([TestRootModule, ExtraModule]);
    expect(unionReport.total).toBe(9);
    expect(unionReport.covered).toBe(5);

    // 2. 傳入重複的模組陣列 [TestRootModule, TestRootModule]：完全去重，結果與單根一致
    const dedupReport = collectInboundContractCoverage([TestRootModule, TestRootModule]);
    expect(dedupReport.total).toBe(8);
    expect(dedupReport.covered).toBe(4);
    expect(dedupReport.httpInputs).toBe(4);
    expect(dedupReport.graphqlInputs).toBe(2);
    expect(dedupReport.grpcInputs).toBe(2);
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

    it('當模組樹包含未解析的異步 Promise 模組時應 Fail-Fast 拋錯，杜絕靜默漏掃', () => {
      const AsyncModulePromise = Promise.resolve({
        module: class AsyncFeatureModule {},
      });

      @Module({
        imports: [AsyncModulePromise as any],
        controllers: [UsersController],
      })
      class ModuleWithAsyncImport {}

      expect(() => collectInboundContractCoverage(ModuleWithAsyncImport)).toThrow(
        '[contract-coverage] Asynchronous Promise module detected in module tree.',
      );
    });
  });

  describe('邊界加固：原型鏈方法繼承與 gRPC @Payload() 顯式索引', () => {
    it('應沿原型鏈掃描 BaseController 與 BaseResolver 繼承而來的端點方法，且子類覆寫方法不重複計數', () => {
      abstract class BaseCrudController {
        @Post('base-covered')
        baseCovered(@Body() dto: CreateUserDto) {
          return dto;
        }

        @Post('base-uncovered')
        baseUncovered(@Body() dto: UnprotectedDto) {
          return dto;
        }

        @Post('overridden')
        overriddenAction(@Body() dto: unknown): unknown {
          return dto;
        }
      }

      @Controller('derived')
      class DerivedController extends BaseCrudController {
        // 子類覆寫為已綁定 Schema 的 DTO
        @Post('overridden')
        override overriddenAction(@Body() dto: CreateUserDto): unknown {
          return dto;
        }
      }

      abstract class BaseCrudResolver {
        @GqlQuery(() => String)
        baseGqlCovered(@Args('input') input: CreateUserDto) {
          return input.username;
        }

        @GqlQuery(() => String)
        baseGqlUncovered(@Args('rawFilter') rawFilter: string) {
          return rawFilter;
        }
      }

      @Resolver()
      class DerivedResolver extends BaseCrudResolver {}

      @Module({
        controllers: [DerivedController],
        providers: [DerivedResolver],
      })
      class InheritedRouteModule {}

      const report = collectInboundContractCoverage(InheritedRouteModule);
      expect(report.total).toBe(5);
      expect(report.httpInputs).toBe(3);
      expect(report.graphqlInputs).toBe(2);
      expect(report.covered).toBe(3);
      expect(report.uncovered).toBe(2);
      expect(report.uncoveredInputs.map((u) => u.location)).toEqual([
        'DerivedController.baseUncovered#0',
        'DerivedResolver.baseGqlUncovered#0',
      ]);
    });

    it('當 gRPC handler 使用 @Ctx() 與 @Payload() 將 payload 置於非 0 索引時應精確定位真實 payload 與 dataName', () => {
      @Controller()
      class ExplicitPayloadGrpcController {
        @GrpcMethod('UsersService', 'WithCtxCovered')
        withCtxCovered(@Ctx() _ctx: unknown, @Payload() data: GrpcPayloadDto) {
          return data;
        }

        @GrpcMethod('UsersService', 'WithCtxUncovered')
        withCtxUncovered(@Ctx() _ctx: unknown, @Payload('userId') userId: string) {
          return userId;
        }
      }

      @Module({
        controllers: [ExplicitPayloadGrpcController],
      })
      class ExplicitPayloadGrpcModule {}

      const report = collectInboundContractCoverage(ExplicitPayloadGrpcModule);
      expect(report.total).toBe(2);
      expect(report.grpcInputs).toBe(2);
      expect(report.covered).toBe(1);
      expect(report.uncovered).toBe(1);

      expect(report.uncoveredInputs[0]?.location).toBe('ExplicitPayloadGrpcController.withCtxUncovered#1');
      expect(report.uncoveredInputs[0]?.parameterIndex).toBe(1);
      expect(report.uncoveredInputs[0]?.dataName).toBe('userId');
    });

    it('應支援 @Body({ schema }) 原生裝飾器選項、@UsePipes() 控制器/方法級管道、多個 gRPC @Payload() 以及跨模組同名控制器去重', () => {
      const InlineBodySchema = z.object({ token: z.string().min(1) });
      const MethodPipeSchema = z.object({ page: z.coerce.number().int() });

      const createScopedController = (isCovered: boolean) => {
        @Controller('scoped')
        class DuplicateNameController {
          @Post('action')
          action(@Body() body: unknown) {
            return body;
          }
        }
        if (isCovered) {
          Reflect.defineMetadata('__pipes__', [{ schema: InlineBodySchema }], DuplicateNameController);
        }
        return DuplicateNameController;
      };

      const CoveredDupController = createScopedController(true);
      const UncoveredDupController = createScopedController(false);

      @Controller('advanced')
      class AdvancedCoverageController {
        @Post('inline-schema')
        inlineSchema(@Body({ schema: InlineBodySchema } as any) body: unknown) {
          return body;
        }

        @Post('method-pipe')
        methodPipe(@Query() query: unknown) {
          return query;
        }

        @GrpcMethod('UsersService', 'MultiPayload')
        multiPayload(@Payload('id', { schema: z.uuid() }) id: string, @Payload('rawNote') rawNote: string) {
          return { id, rawNote };
        }
      }

      const methodDesc = Object.getOwnPropertyDescriptor(AdvancedCoverageController.prototype, 'methodPipe');
      if (methodDesc?.value) {
        Reflect.defineMetadata('__pipes__', [{ schema: MethodPipeSchema }], methodDesc.value);
      }

      @Module({
        controllers: [CoveredDupController, UncoveredDupController, AdvancedCoverageController],
      })
      class AdvancedCoverageModule {}

      const report = collectInboundContractCoverage(AdvancedCoverageModule);
      // CoveredDup(1 covered) + UncoveredDup(1 uncovered) + inlineSchema(1 covered) + methodPipe(1 covered) + multiPayload(1 covered + 1 uncovered) = 6 total (4 covered, 2 uncovered)
      expect(report.total).toBe(6);
      expect(report.covered).toBe(4);
      expect(report.uncovered).toBe(2);
      expect(report.uncoveredInputs.map((u) => u.location)).toEqual([
        'DuplicateNameController.action#0',
        'AdvancedCoverageController.multiPayload#1',
      ]);
    });
  });
});
