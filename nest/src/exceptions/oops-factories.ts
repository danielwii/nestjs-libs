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

/* eslint-disable @typescript-eslint/no-namespace -- module augmentation requires namespace syntax */
declare module './oops' {
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
