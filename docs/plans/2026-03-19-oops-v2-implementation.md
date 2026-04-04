# Oops V2 Implementation Plan — nestjs-libs

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add OopsError/Oops/Oops.Block/Oops.Panic class hierarchy to nestjs-libs, with backward-compatible filter updates.

**Architecture:** New exception classes in `nest/src/exceptions/`, Oops as both 422 class and namespace (Block/Panic). Filters updated to prefer `instanceof OopsError` with duck-typing fallback for backward compat.

**Tech Stack:** TypeScript, NestJS, Bun test, gRPC (@grpc/grpc-js)

---

## Pre-flight

```bash
cd /Users/daniel/Development/Code/danielwii/nestjs-libs
bun remove @types/koa  # 清理无用依赖
git checkout -b feat/oops-v2
```

---

### Task 1: OopsError Abstract Base Class

**Files:**
- Create: `nest/src/exceptions/oops-error.ts`
- Test: `nest/src/exceptions/oops-error.spec.ts`

**Step 1: Write the test**

```typescript
// nest/src/exceptions/oops-error.spec.ts
import { describe, expect, it } from 'bun:test';
import { OopsError } from './oops-error';

describe('OopsError', () => {
  it('should not be instantiable directly', () => {
    // @ts-expect-error abstract class
    expect(() => new OopsError('test')).toThrow();
  });

  it('should provide isFatal() based on httpStatus', () => {
    // Create concrete subclass for testing
    class TestOops extends OopsError {
      readonly httpStatus = 422;
      readonly errorCode = '0x0101';
      readonly oopsCode = 'TS01';
      readonly userMessage = 'test';
    }
    class TestPanic extends OopsError {
      readonly httpStatus = 500;
      readonly errorCode = '0x0401';
      readonly oopsCode = 'TS01';
      readonly userMessage = 'panic';
    }

    const oops = new TestOops('test');
    const panic = new TestPanic('panic');

    expect(oops.isFatal()).toBe(false);
    expect(panic.isFatal()).toBe(true);
  });

  it('should generate combined code', () => {
    class TestOops extends OopsError {
      readonly httpStatus = 422;
      readonly errorCode = '0x0301';
      readonly oopsCode = 'LM01';
      readonly userMessage = 'test';
    }

    const oops = new TestOops('test');
    expect(oops.getCombinedCode()).toBe('0x0301LM01');
  });

  it('should return internalDetails or message from getInternalDetails()', () => {
    class TestOops extends OopsError {
      readonly httpStatus = 422;
      readonly errorCode = '0x0101';
      readonly oopsCode = 'TS01';
      readonly userMessage = 'user msg';
      override readonly internalDetails = 'debug info';
    }

    const withDetails = new TestOops('msg');
    expect(withDetails.getInternalDetails()).toBe('debug info');

    class TestOopsNoDetails extends OopsError {
      readonly httpStatus = 422;
      readonly errorCode = '0x0101';
      readonly oopsCode = 'TS01';
      readonly userMessage = 'user msg';
    }

    const noDetails = new TestOopsNoDetails('fallback msg');
    expect(noDetails.getInternalDetails()).toBe('fallback msg');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test nest/src/exceptions/oops-error.spec.ts`
Expected: FAIL — module not found

**Step 3: Write OopsError**

```typescript
// nest/src/exceptions/oops-error.ts
import type { ErrorCodeValue } from './error-codes';

/**
 * Oops 异常基类
 *
 * 所有业务异常的抽象基类，提供：
 * - 统一的错误码体系（errorCode + oopsCode）
 * - 用户友好消息与内部详情分离
 * - isFatal() 判断是否需要告警
 *
 * 子类：
 * - Oops: 422 业务规则拒绝，不触发 Sentry
 * - Oops.Block: 4xx 请求被拦截（认证/权限/不存在）
 * - Oops.Panic: 500 系统故障，触发 Sentry
 */
export abstract class OopsError extends Error {
  /** HTTP 状态码 */
  abstract readonly httpStatus: number;

  /** 错误码维度 (0x0101 等) */
  abstract readonly errorCode: ErrorCodeValue;

  /** 细节业务码 (US01, LM01 等) */
  abstract readonly oopsCode: string;

  /** 用户友好消息（返回给客户端） */
  abstract readonly userMessage: string;

  /** 内部详情（仅日志，不返回客户端） */
  readonly internalDetails?: string;

  /** 服务提供者标识（用于追踪远程服务错误来源） */
  readonly provider?: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }

  /** 致命异常（500+）应触发 Sentry 告警 */
  isFatal(): boolean {
    return this.httpStatus >= 500;
  }

  /** 组合错误码：{维度码}{细节码} */
  getCombinedCode(): string {
    return `${this.errorCode}${this.oopsCode}`;
  }

  /** 内部调试信息（优先 internalDetails，降级到 message） */
  getInternalDetails(): string {
    return this.internalDetails ?? this.message;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test nest/src/exceptions/oops-error.spec.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add nest/src/exceptions/oops-error.ts nest/src/exceptions/oops-error.spec.ts
git commit -m "feat(exceptions): add OopsError abstract base class"
```

---

### Task 2: Oops (422) + Oops.Block (4xx) + Oops.Panic (500)

**Files:**
- Create: `nest/src/exceptions/oops.ts`
- Test: `nest/src/exceptions/oops.spec.ts`

**Step 1: Write the test**

```typescript
// nest/src/exceptions/oops.spec.ts
import { describe, expect, it } from 'bun:test';
import { Oops } from './oops';
import { OopsError } from './oops-error';

describe('Oops (422)', () => {
  it('should have httpStatus 422', () => {
    const err = new Oops({
      errorCode: '0x0101',
      oopsCode: 'TS01',
      userMessage: 'test',
      internalDetails: 'details',
    });
    expect(err.httpStatus).toBe(422);
    expect(err.isFatal()).toBe(false);
    expect(err instanceof OopsError).toBe(true);
    expect(err instanceof Oops).toBe(true);
  });
});

describe('Oops.Block (4xx)', () => {
  it('should accept 401/403/404/409 status', () => {
    const err = new Oops.Block({
      httpStatus: 401,
      errorCode: '0x0103',
      oopsCode: 'AU01',
      userMessage: 'unauthorized',
    });
    expect(err.httpStatus).toBe(401);
    expect(err.isFatal()).toBe(false);
    expect(err instanceof OopsError).toBe(true);
    expect(err instanceof Oops.Block).toBe(true);
    expect(err instanceof Oops).toBe(false);
  });
});

describe('Oops.Panic (500)', () => {
  it('should have httpStatus 500 and be fatal', () => {
    const err = new Oops.Panic({
      errorCode: '0x0401',
      oopsCode: 'SY01',
      userMessage: '系统繁忙',
      internalDetails: 'DB down',
    });
    expect(err.httpStatus).toBe(500);
    expect(err.isFatal()).toBe(true);
    expect(err instanceof OopsError).toBe(true);
    expect(err instanceof Oops.Panic).toBe(true);
    expect(err instanceof Oops).toBe(false);
  });
});

describe('instanceof discrimination', () => {
  it('should distinguish all three types', () => {
    const oops = new Oops({ errorCode: '0x0101', oopsCode: 'TS01', userMessage: 'biz' });
    const block = new Oops.Block({ httpStatus: 404, errorCode: '0x0101', oopsCode: 'TS01', userMessage: 'not found' });
    const panic = new Oops.Panic({ errorCode: '0x0401', oopsCode: 'SY01', userMessage: 'panic' });

    // All are OopsError
    expect(oops instanceof OopsError).toBe(true);
    expect(block instanceof OopsError).toBe(true);
    expect(panic instanceof OopsError).toBe(true);

    // Each is only its own type
    expect(oops instanceof Oops).toBe(true);
    expect(oops instanceof Oops.Block).toBe(false);
    expect(oops instanceof Oops.Panic).toBe(false);

    expect(block instanceof Oops).toBe(false);
    expect(block instanceof Oops.Block).toBe(true);
    expect(block instanceof Oops.Panic).toBe(false);

    expect(panic instanceof Oops).toBe(false);
    expect(panic instanceof Oops.Block).toBe(false);
    expect(panic instanceof Oops.Panic).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test nest/src/exceptions/oops.spec.ts`
Expected: FAIL

**Step 3: Write Oops + Block + Panic**

```typescript
// nest/src/exceptions/oops.ts
import { OopsError } from './oops-error';

import type { ErrorCodeValue } from './error-codes';

// ==================== Config Interfaces ====================

interface OopsConfig {
  errorCode: ErrorCodeValue;
  oopsCode: string;
  userMessage: string;
  internalDetails?: string;
  provider?: string;
}

interface BlockConfig extends OopsConfig {
  httpStatus: 400 | 401 | 403 | 404 | 409 | 429;
}

interface PanicConfig {
  errorCode: ErrorCodeValue;
  oopsCode?: string;
  userMessage: string;
  internalDetails?: string;
  provider?: string;
}

// ==================== Oops (422) ====================

/**
 * 业务逻辑拒绝 — 422 Unprocessable Entity
 *
 * 请求合法，进了门，但业务逻辑说不行。
 * WARN 日志，不触发 Sentry。
 */
class Oops extends OopsError {
  readonly httpStatus = 422 as const;
  readonly errorCode: ErrorCodeValue;
  readonly oopsCode: string;
  readonly userMessage: string;
  override readonly internalDetails?: string;
  override readonly provider?: string;

  constructor(config: OopsConfig) {
    super(config.internalDetails ?? config.userMessage);
    this.errorCode = config.errorCode;
    this.oopsCode = config.oopsCode;
    this.userMessage = config.userMessage;
    this.internalDetails = config.internalDetails;
    this.provider = config.provider;
  }
}

// ==================== Namespace (Block + Panic) ====================

namespace Oops {
  /**
   * 请求被拦截 — 4xx
   *
   * 门口就被挡了：认证失败、无权限、资源不存在、状态冲突。
   * WARN 日志，不触发 Sentry。
   */
  export class Block extends OopsError {
    readonly httpStatus: 400 | 401 | 403 | 404 | 409 | 429;
    readonly errorCode: ErrorCodeValue;
    readonly oopsCode: string;
    readonly userMessage: string;
    override readonly internalDetails?: string;
    override readonly provider?: string;

    constructor(config: BlockConfig) {
      super(config.internalDetails ?? config.userMessage);
      this.httpStatus = config.httpStatus;
      this.errorCode = config.errorCode;
      this.oopsCode = config.oopsCode;
      this.userMessage = config.userMessage;
      this.internalDetails = config.internalDetails;
      this.provider = config.provider;
    }
  }

  /**
   * 系统故障 — 500 Internal Server Error
   *
   * 大楼停电了：DB 挂了、外部服务不可达、配置缺失。
   * ERROR 日志，触发 Sentry。
   */
  export class Panic extends OopsError {
    readonly httpStatus = 500 as const;
    readonly errorCode: ErrorCodeValue;
    readonly oopsCode: string;
    readonly userMessage: string;
    override readonly internalDetails?: string;
    override readonly provider?: string;

    constructor(config: PanicConfig) {
      super(config.internalDetails ?? config.userMessage);
      this.errorCode = config.errorCode;
      this.oopsCode = config.oopsCode ?? '';
      this.userMessage = config.userMessage;
      this.internalDetails = config.internalDetails;
      this.provider = config.provider;
    }
  }
}

export { Oops };
export type { OopsConfig, BlockConfig, PanicConfig };
```

**Step 4: Run test to verify it passes**

Run: `bun test nest/src/exceptions/oops.spec.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add nest/src/exceptions/oops.ts nest/src/exceptions/oops.spec.ts
git commit -m "feat(exceptions): add Oops (422) + Oops.Block (4xx) + Oops.Panic (500)"
```

---

### Task 3: Generic Factory Methods

**Files:**
- Create: `nest/src/exceptions/oops-factories.ts`
- Test: `nest/src/exceptions/oops-factories.spec.ts`

**Step 1: Write the test**

```typescript
// nest/src/exceptions/oops-factories.spec.ts
import { describe, expect, it } from 'bun:test';
import { Oops } from './oops';
import { OopsError } from './oops-error';
import './oops-factories'; // side-effect: attaches static methods

describe('Oops factory methods (422)', () => {
  it('Oops.Validation()', () => {
    const err = Oops.Validation('Invalid input', 'field X is missing');
    expect(err).toBeInstanceOf(Oops);
    expect(err.httpStatus).toBe(422);
    expect(err.userMessage).toBe('Invalid input');
    expect(err.internalDetails).toBe('field X is missing');
  });

  it('Oops.NotFound()', () => {
    const err = Oops.NotFound('User', 'u_123');
    expect(err).toBeInstanceOf(Oops);
    expect(err.httpStatus).toBe(422);
    expect(err.userMessage).toContain('User');
  });

  it('Oops.ExternalServiceExpected()', () => {
    const err = Oops.ExternalServiceExpected('PaymentGateway', 'timeout');
    expect(err).toBeInstanceOf(Oops);
    expect(err.provider).toBe('PaymentGateway');
  });
});

describe('Oops.Block factory methods (4xx)', () => {
  it('Block.Unauthorized()', () => {
    const err = Oops.Block.Unauthorized('bad token');
    expect(err).toBeInstanceOf(Oops.Block);
    expect(err.httpStatus).toBe(401);
  });

  it('Block.Forbidden()', () => {
    const err = Oops.Block.Forbidden('admin only');
    expect(err).toBeInstanceOf(Oops.Block);
    expect(err.httpStatus).toBe(403);
  });

  it('Block.NotFound()', () => {
    const err = Oops.Block.NotFound('User', 'u_123');
    expect(err).toBeInstanceOf(Oops.Block);
    expect(err.httpStatus).toBe(404);
  });

  it('Block.Conflict()', () => {
    const err = Oops.Block.Conflict('duplicate entry');
    expect(err).toBeInstanceOf(Oops.Block);
    expect(err.httpStatus).toBe(409);
  });
});

describe('Oops.Panic factory methods (500)', () => {
  it('Panic.Database()', () => {
    const err = Oops.Panic.Database('query timeout');
    expect(err).toBeInstanceOf(Oops.Panic);
    expect(err.httpStatus).toBe(500);
    expect(err.userMessage).toBe('系统繁忙，请稍后重试');
  });

  it('Panic.ExternalService()', () => {
    const err = Oops.Panic.ExternalService('Redis', 'connection refused');
    expect(err).toBeInstanceOf(Oops.Panic);
    expect(err.provider).toBe('Redis');
    expect(err.userMessage).toBe('服务暂时不可用，请稍后重试');
  });

  it('Panic.Config()', () => {
    const err = Oops.Panic.Config('missing API key');
    expect(err).toBeInstanceOf(Oops.Panic);
    expect(err.userMessage).toBe('系统维护中，请稍后重试');
  });
});

describe('all factory results are OopsError', () => {
  it('instanceof OopsError should match all', () => {
    expect(Oops.Validation('x')).toBeInstanceOf(OopsError);
    expect(Oops.Block.Unauthorized()).toBeInstanceOf(OopsError);
    expect(Oops.Panic.Database('x')).toBeInstanceOf(OopsError);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test nest/src/exceptions/oops-factories.spec.ts`
Expected: FAIL

**Step 3: Write factory methods**

```typescript
// nest/src/exceptions/oops-factories.ts
import { ErrorCodes } from './error-codes';
import { Oops } from './oops';

// ==================== Oops (422) Factories ====================

/** 通用参数验证失败 */
Oops.Validation = function (message: string, details?: string): Oops {
  return new Oops({
    errorCode: ErrorCodes.CLIENT_VALIDATION_FAILED,
    oopsCode: 'GN01',
    userMessage: message,
    internalDetails: details,
  });
};

/** 通用资源未找到 */
Oops.NotFound = function (resource: string, id?: string): Oops {
  return new Oops({
    errorCode: ErrorCodes.CLIENT_INPUT_ERROR,
    oopsCode: 'GN02',
    userMessage: `${resource}不存在`,
    internalDetails: id ? `${resource} not found: ${id}` : `${resource} not found`,
  });
};

/** 外部服务可预期错误（服务回了但拒绝了） */
Oops.ExternalServiceExpected = function (provider: string, details?: string): Oops {
  return new Oops({
    errorCode: ErrorCodes.EXTERNAL_API_UNAVAILABLE,
    oopsCode: 'GN03',
    userMessage: '服务暂时不可用，请稍后重试',
    internalDetails: details ? `[${provider}] ${details}` : `[${provider}] service error`,
    provider,
  });
};

// ==================== Oops.Block (4xx) Factories ====================

/** 未认证 — 401 */
Oops.Block.Unauthorized = function (details?: string): Oops.Block {
  return new Oops.Block({
    httpStatus: 401,
    errorCode: ErrorCodes.CLIENT_AUTH_REQUIRED,
    oopsCode: 'GN04',
    userMessage: '认证失败，请重新登录',
    internalDetails: details,
  });
};

/** 无权限 — 403 */
Oops.Block.Forbidden = function (resource?: string): Oops.Block {
  return new Oops.Block({
    httpStatus: 403,
    errorCode: ErrorCodes.CLIENT_PERMISSION_DENIED,
    oopsCode: 'GN05',
    userMessage: '无权访问',
    internalDetails: resource ? `Forbidden: ${resource}` : undefined,
  });
};

/** 资源不存在 — 404 */
Oops.Block.NotFound = function (resource: string, id?: string): Oops.Block {
  return new Oops.Block({
    httpStatus: 404,
    errorCode: ErrorCodes.CLIENT_INPUT_ERROR,
    oopsCode: 'GN02',
    userMessage: `${resource}不存在`,
    internalDetails: id ? `${resource} not found: ${id}` : `${resource} not found`,
  });
};

/** 资源冲突 — 409 */
Oops.Block.Conflict = function (details: string): Oops.Block {
  return new Oops.Block({
    httpStatus: 409,
    errorCode: ErrorCodes.CLIENT_RESOURCE_CONFLICT,
    oopsCode: 'GN06',
    userMessage: '操作冲突，请重试',
    internalDetails: details,
  });
};

// ==================== Oops.Panic (500) Factories ====================

/** 数据库致命错误 — "系统繁忙" */
Oops.Panic.Database = function (operation: string): Oops.Panic {
  return new Oops.Panic({
    errorCode: ErrorCodes.SYSTEM_DATABASE_ERROR,
    userMessage: '系统繁忙，请稍后重试',
    internalDetails: `Database operation failed: ${operation}`,
  });
};

/** 外部服务不可达 — "服务暂时不可用" */
Oops.Panic.ExternalService = function (service: string, details?: string): Oops.Panic {
  return new Oops.Panic({
    errorCode: ErrorCodes.EXTERNAL_SERVICE_ERROR,
    userMessage: '服务暂时不可用，请稍后重试',
    internalDetails: `External service error: ${service}${details ? `, ${details}` : ''}`,
    provider: service,
  });
};

/** 配置/初始化错误 — "系统维护中" */
Oops.Panic.Config = function (details: string): Oops.Panic {
  return new Oops.Panic({
    errorCode: ErrorCodes.SYSTEM_INTERNAL_ERROR,
    userMessage: '系统维护中，请稍后重试',
    internalDetails: `Configuration error: ${details}`,
  });
};

// ==================== Type Augmentation ====================

declare module './oops' {
  interface Oops {
    // instance — no additions
  }
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Oops {
    // Oops (422) factory methods
    function Validation(message: string, details?: string): Oops;
    function NotFound(resource: string, id?: string): Oops;
    function ExternalServiceExpected(provider: string, details?: string): Oops;

    // Block (4xx) factory methods
    namespace Block {
      function Unauthorized(details?: string): Oops.Block;
      function Forbidden(resource?: string): Oops.Block;
      function NotFound(resource: string, id?: string): Oops.Block;
      function Conflict(details: string): Oops.Block;
    }

    // Panic (500) factory methods
    namespace Panic {
      function Database(operation: string): Oops.Panic;
      function ExternalService(service: string, details?: string): Oops.Panic;
      function Config(details: string): Oops.Panic;
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test nest/src/exceptions/oops-factories.spec.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add nest/src/exceptions/oops-factories.ts nest/src/exceptions/oops-factories.spec.ts
git commit -m "feat(exceptions): add generic factory methods for Oops/Block/Panic"
```

---

### Task 4: Update Exception Filters (backward-compatible)

**Files:**
- Modify: `nest/src/exceptions/any-exception.filter.ts`
- Modify: `nest/src/exceptions/grpc-exception.filter.ts`
- Modify: `nest/src/exceptions/grpc-exception.filter.spec.ts`

**Step 1: Update AnyExceptionFilter**

In `any-exception.filter.ts`, add import and update `handleBusinessException`:

- Add import: `import { OopsError } from './oops-error'; import { Oops } from './oops'; import './oops-factories';`
- In `catch()`, add `instanceof OopsError` check BEFORE `isBusinessException()` duck-typing
- In `handleBusinessException`, add three-way `instanceof` discrimination (Panic/Block/Oops)
- Keep `isBusinessException()` as fallback for backward compat
- Update log labels: `FatalException` → `Oops.Panic`, `BusinessException` → `Oops`/`Oops.Block`

**Step 2: Update GrpcExceptionFilter**

- Add `instanceof OopsError` check before duck-typing `isOopsException()`
- Block exceptions: map to specific gRPC status (UNAUTHENTICATED/PERMISSION_DENIED/NOT_FOUND) instead of OK
- Oops (422): keep OK pattern (existing behavior)
- Panic (500): keep INTERNAL (existing behavior)

**Step 3: Update grpc-exception.filter.spec.ts**

Add new test cases using actual Oops/Block/Panic instances (not just mock objects):

```typescript
import { Oops } from './oops';
import './oops-factories';

describe('Oops V2 instances', () => {
  it('Oops (422) should return OK with metadata', async () => {
    const { host, sentMetadata } = mockGrpcHost();
    const exception = Oops.Validation('bad input', 'field missing');
    const result$ = filter.catch(exception, host);
    const response = await firstValueFrom(result$);
    expect(response).toEqual({});
    expect(sentMetadata).toHaveLength(1);
  });

  it('Oops.Block (401) should throw UNAUTHENTICATED', async () => {
    const { host } = mockGrpcHost();
    const exception = Oops.Block.Unauthorized('expired token');
    const result$ = filter.catch(exception, host);
    try {
      await firstValueFrom(result$);
      expect(true).toBe(false);
    } catch (error: unknown) {
      const grpcError = error as { code: number };
      expect(grpcError.code).toBe(status.UNAUTHENTICATED);
    }
  });

  it('Oops.Panic (500) should throw INTERNAL', async () => {
    const { host } = mockGrpcHost();
    const exception = Oops.Panic.Database('query failed');
    const result$ = filter.catch(exception, host);
    try {
      await firstValueFrom(result$);
      expect(true).toBe(false);
    } catch (error: unknown) {
      const grpcError = error as { code: number };
      expect(grpcError.code).toBe(status.INTERNAL);
    }
  });
});
```

**Step 4: Run all tests**

Run: `bun test`
Expected: ALL PASS (existing + new)

**Step 5: Commit**

```bash
git add nest/src/exceptions/any-exception.filter.ts nest/src/exceptions/grpc-exception.filter.ts nest/src/exceptions/grpc-exception.filter.spec.ts
git commit -m "feat(exceptions): update filters with OopsError instanceof + backward compat"
```

---

### Task 5: Update Exports + Deprecate IBusinessException

**Files:**
- Modify: `nest/src/exceptions/business-exception.interface.ts`
- Modify: `nest/src/index.ts`

**Step 1: Deprecate IBusinessException**

Add `@deprecated` JSDoc to `IBusinessException` in `business-exception.interface.ts`.

**Step 2: Update exports**

```typescript
// nest/src/index.ts
export * from './common/interface';
export * from './common/response';
export * from './exceptions/business-exception.interface'; // @deprecated — backward compat
export * from './exceptions/error-codes';
export * from './exceptions/oops-error';
export * from './exceptions/oops';
export './exceptions/oops-factories'; // side-effect: attaches factory methods
```

**Step 3: Run typecheck + tests**

Run: `bun run typecheck && bun test`
Expected: PASS

**Step 4: Commit**

```bash
git add nest/src/exceptions/business-exception.interface.ts nest/src/index.ts
git commit -m "feat(exceptions): export OopsError/Oops + deprecate IBusinessException"
```

---

### Task 6: Clean Up + Final Verification

**Step 1: Run full verification**

```bash
bun run typecheck
bun run lint
bun test
```

**Step 2: Verify backward compatibility**

Existing consumers that use `IBusinessException` + duck-typing should still work. The filter handles both paths.

**Step 3: Final commit (if any lint fixes)**

```bash
git add -A
git commit -m "chore: lint fixes"
```
