import 'reflect-metadata';

import { getRawInputExemption } from '@app/nest/contract/raw-input';
import { resolveInboundSchema } from '@app/nest/contract/schema-dto';

import type { PipeTransform, Type } from '@nestjs/common';

export type ContractTransport = 'http' | 'graphql' | 'grpc';
export type ContractInputKind = 'body' | 'query' | 'param' | 'args' | 'payload';

export interface UncoveredInput {
  location: string;
  transport: ContractTransport;
  controller: string;
  method: string;
  parameterIndex: number;
  kind: ContractInputKind;
  dataName?: string;
  metatypeName?: string;
  reason: string;
}

export interface ExemptInput {
  location: string;
  transport: ContractTransport;
  controller: string;
  method: string;
  parameterIndex: number;
  kind: ContractInputKind;
  dataName?: string;
  reason: string;
  exitCondition?: string;
}

export interface CoverageReport {
  total: number;
  covered: number;
  exempt: number;
  uncovered: number;
  httpInputs: number;
  graphqlInputs: number;
  grpcInputs: number;
  uncoveredInputs: UncoveredInput[];
  exemptInputs: ExemptInput[];
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
 * 沿原型鏈向上收集所有方法描述符（直至 Object.prototype），子類同名覆寫方法優先。
 */
function collectPrototypeMethods(prototype: object): Map<string, PropertyDescriptor> {
  const methods = new Map<string, PropertyDescriptor>();
  let currentProto: object | null = prototype;

  while (currentProto && currentProto !== Object.prototype) {
    for (const propertyKey of Object.getOwnPropertyNames(currentProto)) {
      if (propertyKey === 'constructor' || methods.has(propertyKey)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(currentProto, propertyKey);
      if (descriptor && typeof descriptor.value === 'function') {
        methods.set(propertyKey, descriptor);
      }
    }
    currentProto = Object.getPrototypeOf(currentProto) as object | null;
  }

  return methods;
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

  // 靜態邊界 Fail-Fast：拒絕未解析的異步 Promise<DynamicModule>，杜絕靜默漏掃
  if (typeof current === 'object' && 'then' in current && typeof (current as { then?: unknown }).then === 'function') {
    throw new Error(
      '[contract-coverage] Asynchronous Promise module detected in module tree. Pass resolved DynamicModule or synchronous module classes to collectInboundContractCoverage.',
    );
  }

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
 * 5. 多根求並集 (Multi-Root Union)：支援單一根模組或根模組陣列，依 location 去重求並集。
 * 6. 零入參防護門禁 (Fail-Fast Zero Inputs Invariant)：若未列舉到任何入境參數（total === 0），直接拋錯中斷，杜絕虛假 100% 安全感。
 *
 * @param rootModuleOrModules NestJS 根模組或根模組陣列（如 AppModule，或 [AppModule, WorkerModule]）
 */
export function collectInboundContractCoverage(rootModuleOrModules: unknown | readonly unknown[]): CoverageReport {
  const rootModules = Array.isArray(rootModuleOrModules) ? rootModuleOrModules : [rootModuleOrModules];
  const components: DiscoveredComponents = { controllers: new Set(), resolvers: new Set() };
  const visitedModules = new Set<unknown>();

  for (const root of rootModules) {
    collectAllComponents(root, visitedModules, components);
  }

  const controllers = Array.from(components.controllers);
  const resolvers = Array.from(components.resolvers);

  const coveredLocations = new Set<string>();
  const exemptMap = new Map<string, ExemptInput>();
  const uncoveredMap = new Map<string, UncoveredInput>();

  const httpLocations = new Set<string>();
  const graphqlLocations = new Set<string>();
  const grpcLocations = new Set<string>();

  // 1. 審計 Controllers (HTTP 與 gRPC 微服務)
  for (const controller of controllers) {
    const prototype = controller.prototype as object | undefined;
    if (!prototype) continue;

    const methods = collectPrototypeMethods(prototype);
    for (const [propertyKey, descriptor] of methods.entries()) {
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
        // 優先從 __routeArguments__ 解析顯式 @Payload() (RpcParamtype.PAYLOAD = 3) 的參數位置，無裝飾器時預設為第 0 個參數
        const payloadEntry = Object.entries(routeArgs).find(([key]) => Number(key.split(':')[0]) === 3)?.[1];
        const paramIndex = payloadEntry ? payloadEntry.index : 0;
        const dataName = typeof payloadEntry?.data === 'string' ? payloadEntry.data : undefined;
        const location = `${controller.name}.${propertyKey}#${paramIndex}`;
        grpcLocations.add(location);

        if (coveredLocations.has(location) || exemptMap.has(location) || uncoveredMap.has(location)) {
          continue;
        }

        const metatype = paramtypes[paramIndex] as Type<unknown> | undefined;
        const metatypeName = metatype && typeof metatype === 'function' ? metatype.name : undefined;

        // 1. 檢查 @RawInput 豁免 (支援參數級或方法級)
        const exemption = getRawInputExemption(prototype, propertyKey, paramIndex);

        if (exemption) {
          exemptMap.set(location, {
            location,
            transport: 'grpc',
            controller: controller.name,
            method: propertyKey,
            parameterIndex: paramIndex,
            kind: 'payload',
            dataName,
            reason: exemption.reason,
            exitCondition: exemption.exitCondition,
          });
          continue;
        }

        // 2. 檢查 Pipe 是否直接持有 Standard Schema
        const hasStandardSchemaPipe =
          Array.isArray(payloadEntry?.pipes) && payloadEntry.pipes.some((pipe) => isStandardSchemaPipe(pipe));

        if (hasStandardSchemaPipe) {
          coveredLocations.add(location);
          continue;
        }

        // 3. 檢查 metatype 是否持有 Standard Schema
        const schema = resolveInboundSchema(metatype);
        if (schema) {
          coveredLocations.add(location);
          continue;
        }

        uncoveredMap.set(location, {
          location,
          transport: 'grpc',
          controller: controller.name,
          method: propertyKey,
          parameterIndex: paramIndex,
          kind: 'payload',
          dataName,
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

        const paramIndex = argMeta.index;
        const location = `${controller.name}.${propertyKey}#${paramIndex}`;
        httpLocations.add(location);

        if (coveredLocations.has(location) || exemptMap.has(location) || uncoveredMap.has(location)) {
          continue;
        }

        const kind: ContractInputKind = typeNumber === 3 ? 'body' : typeNumber === 4 ? 'query' : 'param';
        const dataName = typeof argMeta.data === 'string' ? argMeta.data : undefined;
        const metatype = paramtypes[paramIndex] as Type<unknown> | undefined;
        const metatypeName = metatype && typeof metatype === 'function' ? metatype.name : undefined;

        // 1. 檢查是否被 @RawInput 顯式豁免
        const exemption = getRawInputExemption(prototype, propertyKey, paramIndex);
        if (exemption) {
          exemptMap.set(location, {
            location,
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
          coveredLocations.add(location);
          continue;
        }

        // 3. 檢查 metatype 是否持有 Standard Schema (形式 A, B)
        const schema = resolveInboundSchema(metatype);
        if (schema) {
          coveredLocations.add(location);
          continue;
        }

        // 4. 未覆蓋
        uncoveredMap.set(location, {
          location,
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

    const methods = collectPrototypeMethods(prototype);
    for (const [propertyKey, descriptor] of methods.entries()) {
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

        const paramIndex = argMeta.index;
        const location = `${resolver.name}.${propertyKey}#${paramIndex}`;
        graphqlLocations.add(location);

        if (coveredLocations.has(location) || exemptMap.has(location) || uncoveredMap.has(location)) {
          continue;
        }

        const dataName = typeof argMeta.data === 'string' ? argMeta.data : undefined;
        const metatype = paramtypes[paramIndex] as Type<unknown> | undefined;
        const metatypeName = metatype && typeof metatype === 'function' ? metatype.name : undefined;

        // 檢查 @RawInput 豁免
        const exemption = getRawInputExemption(prototype, propertyKey, paramIndex);
        if (exemption) {
          exemptMap.set(location, {
            location,
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
          coveredLocations.add(location);
          continue;
        }

        // 檢查 metatype 是否持有 Standard Schema
        const schema = resolveInboundSchema(metatype);
        if (schema) {
          coveredLocations.add(location);
          continue;
        }

        uncoveredMap.set(location, {
          location,
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

  const covered = coveredLocations.size;
  const exemptInputs = Array.from(exemptMap.values());
  const uncoveredInputs = Array.from(uncoveredMap.values());
  const total = covered + exemptInputs.length + uncoveredInputs.length;

  // 零入參防護門禁 (Fail-Fast Zero Inputs Invariant)：total === 0 必須報錯中斷
  if (total === 0) {
    throw new Error(
      '[contract-coverage] No inbound inputs discovered in module tree. Ensure rootModule and imports are properly configured.',
    );
  }

  return {
    total,
    covered,
    exempt: exemptInputs.length,
    uncovered: uncoveredInputs.length,
    httpInputs: httpLocations.size,
    graphqlInputs: graphqlLocations.size,
    grpcInputs: grpcLocations.size,
    uncoveredInputs,
    exemptInputs,
  };
}
