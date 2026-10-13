import 'reflect-metadata';

import { Body, Controller, forwardRef, Get, Module, Param, ParseIntPipe, Post, Query, Req, Res } from '@nestjs/common';

import { RawInput } from '@app/nest/contract/raw-input';
import { createSchemaDto } from '@app/nest/contract/schema-dto';
import { ZodValidationPipe } from '@app/nest/pipes/zod.validation.pipe';

import { collectInboundContractCoverage } from './contract-coverage';

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

describe('collectInboundContractCoverage (Zero-Boot Static Reflection)', () => {
  const UserSchema = z.object({
    username: z.string().min(3),
    email: z.string().email(),
  });

  const QuerySchema = z.object({
    page: z.number().int().default(1),
  });

  // 形式 A：createSchemaDto 基類繼承
  class CreateUserDto extends createSchemaDto(UserSchema, 'CreateUserDto') {}

  // 形式 B：純類 static schema
  class SearchQueryDto {
    static readonly schema = QuerySchema;
    page!: number;
  }

  // 無 Schema 的普通 DTO
  class UnprotectedDto {
    name!: string;
  }

  @Controller('users')
  class UsersController {
    // 1. Covered: 形式 A DTO
    @Post()
    createUser(@Body() dto: CreateUserDto) {
      return dto;
    }

    // 2. Covered: 形式 B DTO
    @Get()
    listUsers(@Query() query: SearchQueryDto) {
      return query;
    }

    // 3. Covered: 使用 NestJS 原生 ParseIntPipe 進行邊界校驗
    @Get(':id')
    getUserById(@Param('id', ParseIntPipe) id: number) {
      return { id };
    }

    // 4. Covered: 行內配置 ZodValidationPipe
    @Post('inline')
    inlineValidate(
      @Body(new ZodValidationPipe(UserSchema))
      body: any,
    ) {
      return body;
    }

    // 5. Uncovered: 單欄位提取未加 Pipe（CALO-SERVER-R 盲區，@Body('code') code: string）
    @Post('verify')
    verifyCode(@Body('code') code: string) {
      return { code };
    }

    // 6. Uncovered: 未綁定 Schema 的普通類
    @Post('unprotected')
    unprotectedAction(@Body() body: UnprotectedDto) {
      return body;
    }

    // 7. Uncovered: 未加 Pipe 的 Query
    @Get('search/raw')
    rawSearch(@Query('keyword') keyword: string) {
      return { keyword };
    }

    // 8. Exempted: 顯式標記 @RawInput 豁免
    @Post('webhook/raw')
    rawWebhook(
      @RawInput('Third-party raw cryptographic signature verification')
      @Body()
      rawPayload: any,
    ) {
      return rawPayload;
    }

    // 9. 框架內部對象注入：不應算作入站未受信任邊界
    @Get('health/stream')
    streamHealth(@Req() req: any, @Res() res: any) {
      return { ok: true };
    }
  }

  @Module({
    controllers: [UsersController],
  })
  class UsersModule {}

  @Module({
    imports: [UsersModule],
  })
  class AppModule {}

  it('應精確統計各類入站參數的覆蓋狀態、豁免與未覆蓋清單', () => {
    const report = collectInboundContractCoverage(AppModule);

    // 總共審計到的入境參數：
    // Covered: 4 個 (createUser body, listUsers query, getUserById param, inlineValidate body)
    // Uncovered: 3 個 (verifyCode body('code'), unprotectedAction body, rawSearch query('keyword'))
    // Exempted: 1 個 (rawWebhook body with @RawInput)
    // 框架對象 (@Req, @Res) 不計入入站審計
    expect(report.coveredInputs).toBe(4);
    expect(report.uncoveredInputs).toBe(3);
    expect(report.exemptInputs).toBe(1);
    expect(report.totalInputs).toBe(8);

    // 覆蓋率計算：covered / (total - exempt) = 4 / (8 - 1) = 4 / 7 ≈ 0.5714
    expect(report.coverageRate).toBe(0.5714);

    // 驗證未覆蓋清單細節
    expect(report.uncovered).toHaveLength(3);

    const singleFieldUncovered = report.uncovered.find(
      (item) => item.method === 'verifyCode' && item.dataName === 'code',
    );
    expect(singleFieldUncovered).toBeDefined();
    expect(singleFieldUncovered?.paramCategory).toBe('body');
    expect(singleFieldUncovered?.reason).toContain("extracts single field 'code' without validation pipe");

    const unprotectedDtoUncovered = report.uncovered.find((item) => item.method === 'unprotectedAction');
    expect(unprotectedDtoUncovered).toBeDefined();
    expect(unprotectedDtoUncovered?.metatypeName).toBe('UnprotectedDto');

    const queryUncovered = report.uncovered.find((item) => item.method === 'rawSearch' && item.dataName === 'keyword');
    expect(queryUncovered).toBeDefined();

    // 驗證豁免清單細節
    expect(report.exempted).toHaveLength(1);
    expect(report.exempted[0]?.method).toBe('rawWebhook');
    expect(report.exempted[0]?.reason).toBe('Third-party raw cryptographic signature verification');
  });

  it('支援 DynamicModule 與 forwardRef 模組樹解析', () => {
    @Controller('feature')
    class FeatureController {
      @Get('info')
      getInfo(@Query('filter') filter: string) {
        return filter;
      }
    }

    const DynamicFeatureModule = {
      module: class FeatureModule {},
      controllers: [FeatureController],
    };

    @Module({
      imports: [forwardRef(() => DynamicFeatureModule as any)],
    })
    class RootDynamicModule {}

    const report = collectInboundContractCoverage(RootDynamicModule);
    expect(report.totalInputs).toBe(1);
    expect(report.uncoveredInputs).toBe(1);
    expect(report.uncovered[0]?.controller).toBe('FeatureController');
  });

  it('當模組完全沒有入站參數時應回報 100% 覆蓋率', () => {
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

    const report = collectInboundContractCoverage(EmptyModule);
    expect(report.totalInputs).toBe(0);
    expect(report.coveredInputs).toBe(0);
    expect(report.uncoveredInputs).toBe(0);
    expect(report.exemptInputs).toBe(0);
    expect(report.coverageRate).toBe(1);
  });
});
