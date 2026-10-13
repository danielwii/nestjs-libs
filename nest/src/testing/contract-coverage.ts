import 'reflect-metadata';

import { getRawInputExemption } from '@app/nest/contract/raw-input';
import { resolveInboundSchema } from '@app/nest/contract/schema-dto';

import type { PipeTransform, Type } from '@nestjs/common';

export type ContractTransport = 'http' | 'graphql' | 'grpc';
export type ContractInputKind = 'body' | 'query' | 'param' | 'args' | 'grpc_payload';

export interface UncoveredInput {
  transport: ContractTransport;
  controller: string;
  method: string;
  parameterIndex: number;
  kind: ContractInputKind | string;
  dataName?: string;
  metatypeName?: string;
  reason: string;
}

export interface ExemptInput {
  transport: ContractTransport;
  controller: string;
  method: string;
  parameterIndex: number;
  kind: ContractInputKind | string;
  dataName?: string;
  reason: string;
  exitCondition?: string;
}

export interface CoverageReport {
  totalInputs: number;
  coveredInputs: number;
  exemptInputs: number;
  uncoveredInputs: number;
  httpInputs: number;
  graphqlInputs: number;
  grpcInputs: number;
  uncovered: UncoveredInput[];
  exempted: ExemptInput[];
}

/**
 * 檢查一個 Pipe 是否明確綁定了 Standard Schema。
 * 嚴禁依賴類名（如 Parse*、ValidationPipe*）進行模糊匹配（杜絕逃生口）。
 */
function isStandardSchemaPipe(pipe: unknown): boolean {
  if (!pipe) return false;

  // 1. 若 Pipe 實例自身持有 schema
  if (typeof pipe === 'object') {
    if ('schema' in pipe && resolveInboundSchema(pipe.schema)) {
      return true;
    }
    if (resolveInboundSchema(pipe)) {
      return true;
    }
  }

  // 2. 若 Pipe 是建構函數且自身帶有 static schema
  if (typeof pipe === 'function') {
    if (resolveInboundSchema(pipe)) {
      return true;
    }
  }

  return false;
}

function unwrapTarget(target: unknown): unknown {
  if (!target) return target;
  if (typeof target === 'object' && 'forwardRef' in target) {
    const forwardFn = (target as { forwardRef: () => unknown }).forwardRef;
    if (typeof forwardFn === 'function') {
      return unwrapTarget(forwardFn());
    }
  }
  return target;
}

function unwrapClass(target: unknown): Type<unknown> | undefined {
  const unwrapped = unwrapTarget(target);
  if (!unwrapped) return undefined;

  if (typeof unwrapped === 'function') {
    return unwrapped as Type<unknown>;
  }

  if (typeof unwrapped === 'object') {
    // 支援 { provide: ..., useClass: TargetClass }
    const withUseClass = unwrapped as { useClass?: unknown };
    if (typeof withUseClass.useClass === 'function') {
      return withUseClass.useClass as Type<unknown>;
    }
  }

  return undefined;
}

interface DiscoveredComponents {
  controllers: Set<Type<unknown>>;
  resolvers: Set<Type<unknown>>;
}

/**
 * 判斷一個類別是否為 GraphQL Resolver
 */
function isGraphQLResolverClass(target: Type<unknown>): boolean {
  return (
    Reflect.hasMetadata('graphql:resolver_type', target) ||
    Reflect.hasMetadata('graphql:resolver_name', target) ||
    Reflect.getMetadataKeys(target).some((k) => typeof k === 'string' && k.startsWith('graphql:'))
  );
}

/**
 * 靜態遞歸收集模組樹中的所有 Controller 與 GraphQL Resolver Provider，原生相容 DynamicModule 與 forwardRef
 */
function collectAllComponents(
  rootTarget: unknown,
  visitedModules = new Set<unknown>(),
  components: DiscoveredComponents = { controllers: new Set(), resolvers: new Set() },
): DiscoveredComponents {
  if (!rootTarget) return components;

  const current = unwrapTarget(rootTarget);
  if (!current) return components;

  let moduleClass: Type<unknown> | undefined;
  let dynamicControllers: unknown[] = [];
  let dynamicProviders: unknown[] = [];
  let dynamicImports: unknown[] = [];

  // 判斷是否為 DynamicModule
  if (typeof current === 'object' && 'module' in current) {
    const dyn = current as {
      module: Type<unknown>;
      controllers?: unknown[];
      providers?: unknown[];
      imports?: unknown[];
    };
    moduleClass = dyn.module;
    if (Array.isArray(dyn.controllers)) {
      dynamicControllers = dyn.controllers;
    }
    if (Array.isArray(dyn.providers)) {
      dynamicProviders = dyn.providers;
    }
    if (Array.isArray(dyn.imports)) {
      dynamicImports = dyn.imports;
    }
  } else if (typeof current === 'function') {
    moduleClass = current as Type<unknown>;
  }

  if (!moduleClass) return components;

  const isFirstVisit = !visitedModules.has(moduleClass);
  if (isFirstVisit) {
    visitedModules.add(moduleClass);
  }

  // 1. 收集 Controllers
  const classControllersRaw = isFirstVisit ? Reflect.getMetadata('controllers', moduleClass) : undefined;
  const classControllers: unknown[] = Array.isArray(classControllersRaw) ? classControllersRaw : [];
  const allControllers = [...dynamicControllers, ...classControllers];
  for (const ctrl of allControllers) {
    const unwrappedCtrl = unwrapClass(ctrl);
    if (unwrappedCtrl) {
      components.controllers.add(unwrappedCtrl);
    }
  }

  // 2. 收集 Providers (過濾出 GraphQL Resolver)
  const classProvidersRaw = isFirstVisit ? Reflect.getMetadata('providers', moduleClass) : undefined;
  const classProviders: unknown[] = Array.isArray(classProvidersRaw) ? classProvidersRaw : [];
  const allProviders = [...dynamicProviders, ...classProviders];
  for (const prov of allProviders) {
    const unwrappedProv = unwrapClass(prov);
    if (unwrappedProv && isGraphQLResolverClass(unwrappedProv)) {
      components.resolvers.add(unwrappedProv);
    }
  }

  // 3. 收集並遞歸遍歷 imports
  const classImportsRaw = isFirstVisit ? Reflect.getMetadata('imports', moduleClass) : undefined;
  const classImports: unknown[] = Array.isArray(classImportsRaw) ? classImportsRaw : [];
  const allImports = [...dynamicImports, ...classImports];
  for (const imp of allImports) {
    collectAllComponents(imp, visitedModules, components);
  }

  return components;
}

/**
 * 收集入站契約 Standard Schema 覆蓋率報告（零啟動成本靜態反射分析）。
 *
 * 核心特性：
 * 1. 零啟動成本：不依賴 NestFactory.create，不初始化 DI 容器，不建立資料庫/網路連線。
 * 2. 全協議支持：涵蓋 HTTP 路由 (@Body, @Query, @Param)、GraphQL 解析器 (@Args)、gRPC 微服務 (@GrpcMethod)。
 * 3. 邊界防禦與單一真理源：覆蓋判定唯一依賴 resolveInboundSchema，絕無類名猜測逃生口。
 * 4. 框架上下文自動豁免：@Headers 等傳輸上下文自動豁免，不佔用業務邊界審計分母。
 * 5. M4 門禁保障：若未列舉到任何入境參數（totalInputs === 0），直接拋錯中斷，杜絕虛假 100% 安全感。
 *
 * @param rootModule NestJS 根模組（如 AppModule）
 */
export function collectInboundContractCoverage(rootModule: unknown): CoverageReport {
  const components = collectAllComponents(rootModule);
  const controllers = Array.from(components.controllers);
  const resolvers = Array.from(components.resolvers);

  const uncovered: UncoveredInput[] = [];
  const exempted: ExemptInput[] = [];
  let coveredCount = 0;
  let httpCount = 0;
  let graphqlCount = 0;
  let grpcCount = 0;

  // 1. 審計 Controllers (HTTP 與 gRPC 微服務)
  for (const controller of controllers) {
    const prototype = controller.prototype as object | undefined;
    if (!prototype) continue;

    const propertyNames = Object.getOwnPropertyNames(prototype);
    for (const propertyKey of propertyNames) {
      if (propertyKey === 'constructor') continue;

      const descriptor = Object.getOwnPropertyDescriptor(prototype, propertyKey);
      if (!descriptor || typeof descriptor.value !== 'function') continue;

      const handlerFn = descriptor.value as object;

      // 檢查是否為 gRPC 微服務方法
      const hasGrpcPattern = Reflect.getMetadata('microservices:pattern', handlerFn) !== undefined;
      const hasGrpcTransport = Reflect.getMetadata('microservices:transport', handlerFn) !== undefined;
      const isGrpcHandler = hasGrpcPattern || hasGrpcTransport;

      // 檢查是否為 HTTP 路由方法
      const hasHttpPath = Reflect.getMetadata('path', handlerFn) !== undefined;
      const hasHttpMethod = Reflect.getMetadata('method', handlerFn) !== undefined;
      const isHttpHandler = !isGrpcHandler && (hasHttpPath || hasHttpMethod);

      if (!isGrpcHandler && !isHttpHandler) continue;

      const routeArgs =
        (Reflect.getMetadata('__routeArguments__', controller, propertyKey) as
          | Record<string, { index: number; data?: unknown; pipes?: (PipeTransform | Type<PipeTransform>)[] }>
          | undefined) ?? {};
      const rawParamtypes = Reflect.getMetadata('design:paramtypes', prototype, propertyKey);
      const paramtypes: unknown[] = Array.isArray(rawParamtypes) ? rawParamtypes : [];

      if (isGrpcHandler) {
        grpcCount++;
        // gRPC 預設入參為第 0 個參數 (data payload)
        const paramIndex = 0;
        const metatype = paramtypes[paramIndex] as Type<unknown> | undefined;
        const metatypeName = metatype && typeof metatype === 'function' ? metatype.name : undefined;

        // 檢查 @RawInput 豁免 (支援參數級或方法級)
        const exemption =
          getRawInputExemption(prototype, propertyKey, paramIndex) ?? getRawInputExemption(prototype, propertyKey, 0);

        if (exemption) {
          exempted.push({
            transport: 'grpc',
            controller: controller.name,
            method: propertyKey,
            parameterIndex: paramIndex,
            kind: 'grpc_payload',
            reason: exemption.reason,
            exitCondition: exemption.exitCondition,
          });
          continue;
        }

        const schema = resolveInboundSchema(metatype);
        if (schema) {
          coveredCount++;
          continue;
        }

        uncovered.push({
          transport: 'grpc',
          controller: controller.name,
          method: propertyKey,
          parameterIndex: paramIndex,
          kind: 'grpc_payload',
          metatypeName,
          reason: `gRPC handler '${propertyKey}' payload lacks Standard Schema and is not exempted via @RawInput`,
        });
        continue;
      }

      // HTTP 處理分支
      for (const [key, argMeta] of Object.entries(routeArgs)) {
        const [rawTypeNumber] = key.split(':');
        const typeNumber = Number(rawTypeNumber);

        // 3: BODY, 4: QUERY, 5: PARAM
        if (typeNumber !== 3 && typeNumber !== 4 && typeNumber !== 5) {
          // 其餘 (0:req, 1:res, 2:next, 6:headers 等) 均為框架傳輸層上下文，自動豁免
          continue;
        }

        httpCount++;
        const kind: ContractInputKind = typeNumber === 3 ? 'body' : typeNumber === 4 ? 'query' : 'param';
        const paramIndex = argMeta.index;
        const dataName = typeof argMeta.data === 'string' ? argMeta.data : undefined;
        const metatype = paramtypes[paramIndex] as Type<unknown> | undefined;
        const metatypeName = metatype && typeof metatype === 'function' ? metatype.name : undefined;

        // 1. 檢查是否被 @RawInput 顯式豁免
        const exemption = getRawInputExemption(prototype, propertyKey, paramIndex);
        if (exemption) {
          exempted.push({
            transport: 'http',
            controller: controller.name,
            method: propertyKey,
            parameterIndex: paramIndex,
            kind,
            dataName,
            reason: exemption.reason,
            exitCondition: exemption.exitCondition,
          });
          continue;
        }

        // 2. 檢查 Pipe 是否直接持有 Standard Schema
        const hasStandardSchemaPipe =
          Array.isArray(argMeta.pipes) && argMeta.pipes.some((pipe) => isStandardSchemaPipe(pipe));

        if (hasStandardSchemaPipe) {
          coveredCount++;
          continue;
        }

        // 3. 檢查 metatype 是否持有 Standard Schema (形式 A, B)
        const schema = resolveInboundSchema(metatype);
        if (schema) {
          coveredCount++;
          continue;
        }

        // 4. 未覆蓋
        uncovered.push({
          transport: 'http',
          controller: controller.name,
          method: propertyKey,
          parameterIndex: paramIndex,
          kind,
          dataName,
          metatypeName,
          reason: dataName
            ? `Parameter extracts single field '${dataName}' without bound Standard Schema`
            : `Metatype '${metatypeName ?? 'unknown'}' has no Standard Schema attached`,
        });
      }
    }
  }

  // 2. 審計 GraphQL Resolvers (@Args)
  for (const resolver of resolvers) {
    const prototype = resolver.prototype as object | undefined;
    if (!prototype) continue;

    const propertyNames = Object.getOwnPropertyNames(prototype);
    for (const propertyKey of propertyNames) {
      if (propertyKey === 'constructor') continue;

      const descriptor = Object.getOwnPropertyDescriptor(prototype, propertyKey);
      if (!descriptor || typeof descriptor.value !== 'function') continue;

      const handlerFn = descriptor.value as object;
      const isGqlHandler =
        Reflect.hasMetadata('graphql:resolver_type', handlerFn) ||
        Reflect.hasMetadata('graphql:resolver_name', handlerFn) ||
        Reflect.getMetadataKeys(handlerFn).some((k) => typeof k === 'string' && k.startsWith('graphql:'));

      if (!isGqlHandler) continue;

      const routeArgs =
        (Reflect.getMetadata('__routeArguments__', resolver, propertyKey) as
          | Record<string, { index: number; data?: unknown; pipes?: (PipeTransform | Type<PipeTransform>)[] }>
          | undefined) ?? {};
      const rawParamtypes = Reflect.getMetadata('design:paramtypes', prototype, propertyKey);
      const paramtypes: unknown[] = Array.isArray(rawParamtypes) ? rawParamtypes : [];

      for (const [key, argMeta] of Object.entries(routeArgs)) {
        const [rawTypeNumber] = key.split(':');
        const typeNumber = Number(rawTypeNumber);

        // 在 NestJS GraphQL 中，GqlParamtype.ARGS = 3
        if (typeNumber !== 3) {
          continue;
        }

        graphqlCount++;
        const paramIndex = argMeta.index;
        const dataName = typeof argMeta.data === 'string' ? argMeta.data : undefined;
        const metatype = paramtypes[paramIndex] as Type<unknown> | undefined;
        const metatypeName = metatype && typeof metatype === 'function' ? metatype.name : undefined;

        // 檢查 @RawInput 豁免
        const exemption = getRawInputExemption(prototype, propertyKey, paramIndex);
        if (exemption) {
          exempted.push({
            transport: 'graphql',
            controller: resolver.name,
            method: propertyKey,
            parameterIndex: paramIndex,
            kind: 'args',
            dataName,
            reason: exemption.reason,
            exitCondition: exemption.exitCondition,
          });
          continue;
        }

        // 檢查 Pipe 是否直接持有 Standard Schema
        const hasStandardSchemaPipe =
          Array.isArray(argMeta.pipes) && argMeta.pipes.some((pipe) => isStandardSchemaPipe(pipe));

        if (hasStandardSchemaPipe) {
          coveredCount++;
          continue;
        }

        // 檢查 metatype 是否持有 Standard Schema
        const schema = resolveInboundSchema(metatype);
        if (schema) {
          coveredCount++;
          continue;
        }

        uncovered.push({
          transport: 'graphql',
          controller: resolver.name,
          method: propertyKey,
          parameterIndex: paramIndex,
          kind: 'args',
          dataName,
          metatypeName,
          reason: dataName
            ? `GraphQL @Args('${dataName}') lacks bound Standard Schema`
            : `GraphQL @Args parameter '${metatypeName ?? 'unknown'}' lacks bound Standard Schema`,
        });
      }
    }
  }

  const totalInputs = coveredCount + exempted.length + uncovered.length;

  // M4 門禁：totalInputs === 0 必須報錯中斷 (Fail-Fast)
  if (totalInputs === 0) {
    throw new Error(
      '[contract-coverage] No inbound inputs discovered in module tree. Ensure rootModule and imports are properly configured.',
    );
  }

  return {
    totalInputs,
    coveredInputs: coveredCount,
    exemptInputs: exempted.length,
    uncoveredInputs: uncovered.length,
    httpInputs: httpCount,
    graphqlInputs: graphqlCount,
    grpcInputs: grpcCount,
    uncovered,
    exempted,
  };
}
