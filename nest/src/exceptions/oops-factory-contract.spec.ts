import { ErrorCodes } from './error-codes';
import { Oops } from './oops';
import { OopsError } from './oops-error';

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

type OopsVariant = 'Oops' | 'Block' | 'Panic';

interface FactoryCase {
  path: string;
  create: () => OopsError;
  expected: {
    variant: OopsVariant;
    httpStatus: number;
    errorCode: ErrorCodes;
    oopsCode: string;
    userMessage: string;
    internalDetails: string | undefined;
    provider: string | undefined;
    cause: unknown;
  };
}

const aiRateLimitCause = new Error('quota exceeded');
const databaseCause = new Error('database unavailable');
const externalServiceCause = new Error('connection refused');
const configCause = new Error('missing environment variable');
const invariantCause = new Error('invalid internal state');
const aiModelCause = new Error('provider request failed');
const aiObjectCause = new Error('no object generated');

const factoryCases: FactoryCase[] = [
  {
    path: 'Oops.Validation',
    create: () => Oops.Validation('Invalid input', 'field X is missing'),
    expected: {
      variant: 'Block',
      httpStatus: 400,
      errorCode: ErrorCodes.CLIENT_INPUT_ERROR,
      oopsCode: 'GN01',
      userMessage: 'Invalid input',
      internalDetails: 'field X is missing',
      provider: undefined,
      cause: undefined,
    },
  },
  {
    path: 'Oops.ExternalServiceExpected',
    create: () => Oops.ExternalServiceExpected('PaymentGateway', 'declined'),
    expected: {
      variant: 'Oops',
      httpStatus: 422,
      errorCode: ErrorCodes.EXTERNAL_API_UNAVAILABLE,
      oopsCode: 'GN03',
      userMessage: '服务暂时不可用，请稍后重试',
      internalDetails: '[PaymentGateway] declined',
      provider: 'PaymentGateway',
      cause: undefined,
    },
  },
  {
    path: 'Oops.Block.Unauthorized',
    create: () => Oops.Block.Unauthorized('bad token'),
    expected: {
      variant: 'Block',
      httpStatus: 401,
      errorCode: ErrorCodes.CLIENT_AUTH_REQUIRED,
      oopsCode: 'GN04',
      userMessage: '认证失败，请重新登录',
      internalDetails: 'bad token',
      provider: undefined,
      cause: undefined,
    },
  },
  {
    path: 'Oops.Block.Forbidden',
    create: () => Oops.Block.Forbidden('admin only'),
    expected: {
      variant: 'Block',
      httpStatus: 403,
      errorCode: ErrorCodes.CLIENT_PERMISSION_DENIED,
      oopsCode: 'GN05',
      userMessage: '无权访问',
      internalDetails: 'Forbidden: admin only',
      provider: undefined,
      cause: undefined,
    },
  },
  {
    path: 'Oops.Block.NotFound',
    create: () => Oops.Block.NotFound('Device', 'd_123'),
    expected: {
      variant: 'Block',
      httpStatus: 404,
      errorCode: ErrorCodes.CLIENT_INPUT_ERROR,
      oopsCode: 'GN02',
      userMessage: 'Device不存在',
      internalDetails: 'Device not found: d_123',
      provider: undefined,
      cause: undefined,
    },
  },
  {
    path: 'Oops.Block.Conflict',
    create: () => Oops.Block.Conflict('duplicate entry'),
    expected: {
      variant: 'Block',
      httpStatus: 409,
      errorCode: ErrorCodes.CLIENT_RESOURCE_CONFLICT,
      oopsCode: 'GN06',
      userMessage: '操作冲突，请重试',
      internalDetails: 'duplicate entry',
      provider: undefined,
      cause: undefined,
    },
  },
  {
    path: 'Oops.Block.RateLimited',
    create: () => Oops.Block.RateLimited('chat', 2500),
    expected: {
      variant: 'Block',
      httpStatus: 429,
      errorCode: ErrorCodes.CLIENT_RATE_LIMITED,
      oopsCode: 'GN07',
      userMessage: '请求过于频繁，请稍后再试',
      internalDetails: 'Rate limited: chat (retry after 2500ms)',
      provider: undefined,
      cause: undefined,
    },
  },
  {
    path: 'Oops.Block.AIModelRateLimited',
    create: () => Oops.Block.AIModelRateLimited('vertex:gemini', { cause: aiRateLimitCause }),
    expected: {
      variant: 'Block',
      httpStatus: 429,
      errorCode: ErrorCodes.EXTERNAL_API_QUOTA,
      oopsCode: 'AI02',
      userMessage: 'AI 服务繁忙，请稍后重试',
      internalDetails: 'AI model rate limited: vertex:gemini',
      provider: 'vertex:gemini',
      cause: aiRateLimitCause,
    },
  },
  {
    path: 'Oops.Panic.Database',
    create: () => Oops.Panic.Database('query timeout', { cause: databaseCause }),
    expected: {
      variant: 'Panic',
      httpStatus: 500,
      errorCode: ErrorCodes.SYSTEM_DATABASE_ERROR,
      oopsCode: 'GN09',
      userMessage: '系统繁忙，请稍后重试',
      internalDetails: 'Database operation failed: query timeout',
      provider: undefined,
      cause: databaseCause,
    },
  },
  {
    path: 'Oops.Panic.ExternalService',
    create: () =>
      Oops.Panic.ExternalService('Azure STT', 'temporarily unavailable', {
        httpStatus: 503,
        cause: externalServiceCause,
      }),
    expected: {
      variant: 'Panic',
      httpStatus: 503,
      errorCode: ErrorCodes.EXTERNAL_SERVICE_ERROR,
      oopsCode: 'GN10',
      userMessage: '服务暂时不可用，请稍后重试',
      internalDetails: 'External service error: Azure STT, temporarily unavailable',
      provider: 'Azure STT',
      cause: externalServiceCause,
    },
  },
  {
    path: 'Oops.Panic.Config',
    create: () => Oops.Panic.Config('missing API key', { cause: configCause }),
    expected: {
      variant: 'Panic',
      httpStatus: 500,
      errorCode: ErrorCodes.SYSTEM_CONFIG_ERROR,
      oopsCode: 'GN11',
      userMessage: '服务配置异常，请联系管理员',
      internalDetails: 'Configuration error: missing API key',
      provider: undefined,
      cause: configCause,
    },
  },
  {
    path: 'Oops.Panic.Invariant',
    create: () => Oops.Panic.Invariant('ttlSeconds must be positive', { cause: invariantCause }),
    expected: {
      variant: 'Panic',
      httpStatus: 500,
      errorCode: ErrorCodes.SYSTEM_LOGIC_ERROR,
      oopsCode: 'GN08',
      userMessage: '系统内部状态异常，请稍后重试',
      internalDetails: 'Invariant violation: ttlSeconds must be positive',
      provider: undefined,
      cause: invariantCause,
    },
  },
  {
    path: 'Oops.Panic.AIModelError',
    create: () => Oops.Panic.AIModelError('openrouter:model', 'request failed', { cause: aiModelCause }),
    expected: {
      variant: 'Panic',
      httpStatus: 500,
      errorCode: ErrorCodes.EXTERNAL_SERVICE_ERROR,
      oopsCode: 'AI01',
      userMessage: '服务暂时不可用，请稍后重试',
      internalDetails: 'AI model error (openrouter:model): request failed',
      provider: 'openrouter:model',
      cause: aiModelCause,
    },
  },
  {
    path: 'Oops.Panic.AIObjectGenerationFailed',
    create: () =>
      Oops.Panic.AIObjectGenerationFailed('vertex:gemini', 'content-filter', 'partial', { cause: aiObjectCause }),
    expected: {
      variant: 'Panic',
      httpStatus: 500,
      errorCode: ErrorCodes.EXTERNAL_SERVICE_ERROR,
      oopsCode: 'AI04',
      userMessage: '内容被安全过滤器拦截，请调整表达后重试',
      internalDetails: 'AI object generation failed [vertex:gemini] reason=content-filter partial=partial',
      provider: 'vertex:gemini',
      cause: aiObjectCause,
    },
  },
];

function getVariant(error: OopsError): OopsVariant {
  if (error instanceof Oops.Panic) return 'Panic';
  if (error instanceof Oops.Block) return 'Block';
  return 'Oops';
}

function enumerableFunctionNames(owner: object): string[] {
  return Object.entries(owner)
    .filter(([, value]) => typeof value === 'function')
    .map(([name]) => name)
    .sort();
}

describe('public generic Oops factory contract', () => {
  it('hard-removes the historical side-effect module', () => {
    const removedModulePath = join(import.meta.dir, 'oops-factories.ts');
    expect(existsSync(removedModulePath)).toBe(false);

    const result = spawnSync(process.execPath, ['-e', `await import(${JSON.stringify(removedModulePath)})`], {
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
  });

  it('is runtime-complete from a direct Oops import in a fresh process', () => {
    const result = spawnSync(process.execPath, [join(import.meta.dir, 'oops-direct-import.fixture.ts')], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      validation: 'GN01',
      notFound: 'GN02',
      database: 'GN09',
      externalService: 'GN10',
      config: 'GN11',
    });
  });

  it('inventories every public factory exactly once', () => {
    const inventory = {
      Oops: enumerableFunctionNames(Oops).filter((name) => name !== 'Block' && name !== 'Panic'),
      Block: enumerableFunctionNames(Oops.Block),
      Panic: enumerableFunctionNames(Oops.Panic),
    };

    expect(inventory).toEqual({
      Oops: ['ExternalServiceExpected', 'Validation'],
      Block: ['AIModelRateLimited', 'Conflict', 'Forbidden', 'NotFound', 'RateLimited', 'Unauthorized'],
      Panic: ['AIModelError', 'AIObjectGenerationFailed', 'Config', 'Database', 'ExternalService', 'Invariant'],
    });

    const inventoriedPaths = [
      ...inventory.Oops.map((name) => `Oops.${name}`),
      ...inventory.Block.map((name) => `Oops.Block.${name}`),
      ...inventory.Panic.map((name) => `Oops.Panic.${name}`),
    ].sort();
    const coveredPaths = factoryCases.map(({ path }) => path).sort();

    expect(new Set(coveredPaths).size).toBe(factoryCases.length);
    expect(coveredPaths).toEqual(inventoriedPaths);
    expect(factoryCases).toHaveLength(14);
  });

  for (const factoryCase of factoryCases) {
    it(`${factoryCase.path} has the exact variant and observable fields`, () => {
      const error = factoryCase.create();

      expect(error).toBeInstanceOf(OopsError);
      expect(getVariant(error)).toBe(factoryCase.expected.variant);
      expect(error.httpStatus).toBe(factoryCase.expected.httpStatus);
      expect(error.errorCode).toBe(factoryCase.expected.errorCode);
      expect(error.oopsCode).toBe(factoryCase.expected.oopsCode);
      expect(error.userMessage).toBe(factoryCase.expected.userMessage);
      expect(error.internalDetails).toBe(factoryCase.expected.internalDetails);
      expect(error.provider).toBe(factoryCase.expected.provider);
      expect(error.cause).toBe(factoryCase.expected.cause);
      expect(error.isFatal()).toBe(factoryCase.expected.variant === 'Panic');
    });
  }
});
