import 'reflect-metadata';

import { getRawInputExemption } from '@app/nest/contract/raw-input';
import { resolveInboundSchema } from '@app/nest/contract/schema-dto';

import type { PipeTransform, Type } from '@nestjs/common';

export type InboundParamCategory = 'body' | 'query' | 'param' | 'headers';

/**
 * NestJS 內部 RouteParamtypes 枚舉映射表
 */
const ROUTE_PARAM_TYPE_MAP: Record<
  number,
  | 'request'
  | 'response'
  | 'next'
  | 'body'
  | 'query'
  | 'param'
  | 'headers'
  | 'session'
  | 'file'
  | 'files'
  | 'host'
  | 'ip'
  | 'raw_body'
  | 'other'
> = {
  0: 'request',
  1: 'response',
  2: 'next',
  3: 'body',
  4: 'query',
  5: 'param',
  6: 'headers',
  7: 'session',
  8: 'file',
  9: 'files',
  10: 'host',
  11: 'ip',
  12: 'raw_body',
};

export interface UncoveredInput {
  controller: string;
  method: string;
  parameterIndex: number;
  paramCategory: InboundParamCategory | string;
  dataName?: string;
  metatypeName?: string;
  reason: string;
}

export interface ExemptInput {
  controller: string;
  method: string;
  parameterIndex: number;
  paramCategory: InboundParamCategory | string;
  dataName?: string;
  reason: string;
}

export interface CoverageReport {
  totalInputs: number;
  coveredInputs: number;
  exemptInputs: number;
  uncoveredInputs: number;
  coverageRate: number;
  uncovered: UncoveredInput[];
  exempted: ExemptInput[];
}

export interface ContractCoverageOptions {
  /**
   * 需要進行 Schema 契約審計的參數類別，預設包含 body, query, param, headers
   */
  includedCategories?: InboundParamCategory[];
  /**
   * 自定義 Pipe 合格判定鉤子
   */
  isValidationPipe?: (pipe: unknown) => boolean;
}

/**
 * 檢查一個 Pipe 是否屬於合法的參數校驗/轉型管道
 */
function isRecognizedValidationPipe(pipe: unknown, customMatcher?: (pipe: unknown) => boolean): boolean {
  if (!pipe) return false;
  if (customMatcher?.(pipe)) return true;

  // 1. 若 Pipe 實例自身持有 schema
  if (typeof pipe === 'object') {
    if ('schema' in pipe && resolveInboundSchema(pipe.schema)) {
      return true;
    }
  }

  // 2. 若 Pipe 是建構函數且自身帶有 schema
  if (typeof pipe === 'function') {
    if (resolveInboundSchema(pipe)) {
      return true;
    }
    const name = pipe.name;
    if (name.startsWith('Parse') || name.includes('ValidationPipe')) {
      return true;
    }
  }

  // 3. 檢查實例的構造函數名稱（如 ParseIntPipe, ZodValidationPipe, StandardValidationPipe）
  const constructorName = (pipe as { constructor?: { name?: string } }).constructor?.name ?? '';
  if (constructorName.startsWith('Parse') || constructorName.includes('ValidationPipe')) {
    return true;
  }

  return false;
}

function unwrapController(ctrlTarget: unknown): Type<unknown> | undefined {
  if (!ctrlTarget) return undefined;
  if (typeof ctrlTarget === 'object' && 'forwardRef' in ctrlTarget) {
    const fn = (ctrlTarget as { forwardRef: () => unknown }).forwardRef;
    if (typeof fn === 'function') {
      return unwrapController(fn());
    }
  }
  if (typeof ctrlTarget === 'function') {
    return ctrlTarget as Type<unknown>;
  }
  return undefined;
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

/**
 * 靜態遞歸收集模組樹中的所有 Controller，原生相容 DynamicModule 與 forwardRef
 */
function collectControllersAndImports(
  rootTarget: unknown,
  visitedModules = new Set<unknown>(),
  controllersSet = new Set<Type<unknown>>(),
): Set<Type<unknown>> {
  if (!rootTarget) return controllersSet;

  const current = unwrapTarget(rootTarget);
  if (!current) return controllersSet;

  let moduleClass: Type<unknown> | undefined;
  let dynamicControllers: unknown[] = [];
  let dynamicImports: unknown[] = [];

  // 判斷是否為 DynamicModule
  if (typeof current === 'object' && 'module' in current) {
    const dyn = current as { module: Type<unknown>; controllers?: unknown[]; imports?: unknown[] };
    moduleClass = dyn.module;
    if (Array.isArray(dyn.controllers)) {
      dynamicControllers = dyn.controllers;
    }
    if (Array.isArray(dyn.imports)) {
      dynamicImports = dyn.imports;
    }
  } else if (typeof current === 'function') {
    moduleClass = current as Type<unknown>;
  }

  if (!moduleClass) return controllersSet;

  const isFirstVisit = !visitedModules.has(moduleClass);
  if (isFirstVisit) {
    visitedModules.add(moduleClass);
  }

  // 收集 DynamicModule 顯式宣告的 controllers
  for (const ctrl of dynamicControllers) {
    const unwrappedCtrl = unwrapController(ctrl);
    if (unwrappedCtrl) {
      controllersSet.add(unwrappedCtrl);
    }
  }

  // 收集模組類裝飾器上的 controllers
  if (isFirstVisit) {
    const rawClassControllers = Reflect.getMetadata('controllers', moduleClass);
    const classControllers: unknown[] = Array.isArray(rawClassControllers) ? rawClassControllers : [];
    for (const ctrl of classControllers) {
      const unwrappedCtrl = unwrapController(ctrl);
      if (unwrappedCtrl) {
        controllersSet.add(unwrappedCtrl);
      }
    }
  }

  // 收集並遞歸遍歷 imports
  const rawImports = isFirstVisit ? Reflect.getMetadata('imports', moduleClass) : undefined;
  const classImports: unknown[] = Array.isArray(rawImports) ? rawImports : [];
  const allImports = [...dynamicImports, ...classImports];
  for (const imp of allImports) {
    collectControllersAndImports(imp, visitedModules, controllersSet);
  }

  return controllersSet;
}

/**
 * 收集入站契約 Standard Schema 覆蓋率報告（零啟動成本靜態反射分析）。
 *
 * 核心特性：
 * 1. 零啟動成本：不依賴 NestFactory.create，不初始化 DI 容器，不建立資料庫/網路連線。
 * 2. 靜態反射：透過 NestJS 裝飾器樹（imports, controllers, __routeArguments__, design:paramtypes）精確審計每個入站端點。
 * 3. 邊界防禦：嚴格防護 @Body('field') 與 @Query('field') 單欄位提取繞過 Schema 的安全盲區。
 * 4. 顯式豁免：認可 @RawInput(reason) 審計標記並納入審計清單。
 *
 * @param rootModule NestJS 根模組（如 AppModule）
 * @param options 審計過濾選項
 */
export function collectInboundContractCoverage(
  rootModule: unknown,
  options: ContractCoverageOptions = {},
): CoverageReport {
  const includedCategories = new Set<InboundParamCategory>(
    options.includedCategories ?? ['body', 'query', 'param', 'headers'],
  );

  const controllers = Array.from(collectControllersAndImports(rootModule));

  const uncovered: UncoveredInput[] = [];
  const exempted: ExemptInput[] = [];
  let coveredCount = 0;

  for (const controller of controllers) {
    const prototype = controller.prototype as object | undefined;
    if (!prototype) continue;

    const propertyNames = Object.getOwnPropertyNames(prototype);
    for (const propertyKey of propertyNames) {
      if (propertyKey === 'constructor') continue;

      const descriptor = Object.getOwnPropertyDescriptor(prototype, propertyKey);
      if (!descriptor || typeof descriptor.value !== 'function') continue;

      const handlerFn = descriptor.value as object;

      // 檢查是否為路由處理器（帶有 path 或 method 元數據）
      const hasPath = Reflect.getMetadata('path', handlerFn) !== undefined;
      const hasMethod = Reflect.getMetadata('method', handlerFn) !== undefined;
      if (!hasPath && !hasMethod) continue;

      // 提取參數元數據
      const routeArgs =
        (Reflect.getMetadata('__routeArguments__', controller, propertyKey) as
          | Record<string, { index: number; data?: unknown; pipes?: (PipeTransform | Type<PipeTransform>)[] }>
          | undefined) ?? {};
      const rawParamtypes = Reflect.getMetadata('design:paramtypes', prototype, propertyKey);
      const paramtypes: unknown[] = Array.isArray(rawParamtypes) ? rawParamtypes : [];

      for (const [key, argMeta] of Object.entries(routeArgs)) {
        const [rawTypeNumber] = key.split(':');
        const typeNumber = Number(rawTypeNumber);
        const category = ROUTE_PARAM_TYPE_MAP[typeNumber] ?? 'other';

        // 只審計納入範圍的邊界輸入（如 body, query, param, headers）
        if (!includedCategories.has(category as InboundParamCategory)) {
          continue;
        }

        const paramIndex = argMeta.index;
        const dataName = typeof argMeta.data === 'string' ? argMeta.data : undefined;
        const metatype = paramtypes[paramIndex] as Type<unknown> | undefined;
        const metatypeName = metatype && typeof metatype === 'function' ? metatype.name : undefined;

        // 1. 檢查是否被 @RawInput 顯式豁免
        const exemptionReason = getRawInputExemption(prototype, propertyKey, paramIndex);
        if (exemptionReason) {
          exempted.push({
            controller: controller.name,
            method: propertyKey,
            parameterIndex: paramIndex,
            paramCategory: category,
            dataName,
            reason: exemptionReason,
          });
          continue;
        }

        // 2. 檢查是否具備合格的 Validation Pipe
        const hasValidationPipe =
          Array.isArray(argMeta.pipes) &&
          argMeta.pipes.some((pipe) => isRecognizedValidationPipe(pipe, options.isValidationPipe));

        if (hasValidationPipe) {
          coveredCount++;
          continue;
        }

        // 3. 檢查 metatype 是否持有 Standard Schema (形式 A, B, C)
        const schema = resolveInboundSchema(metatype);
        if (schema) {
          coveredCount++;
          continue;
        }

        // 4. 未覆蓋：記入 uncovered 清單
        uncovered.push({
          controller: controller.name,
          method: propertyKey,
          parameterIndex: paramIndex,
          paramCategory: category,
          dataName,
          metatypeName,
          reason: dataName
            ? `Parameter extracts single field '${dataName}' without validation pipe`
            : `Metatype '${metatypeName ?? 'unknown'}' has no Standard Schema attached and no validation pipe is configured`,
        });
      }
    }
  }

  const totalInputs = coveredCount + exempted.length + uncovered.length;
  const effectiveInputs = totalInputs - exempted.length;
  const coverageRate = effectiveInputs <= 0 ? 1 : Number((coveredCount / effectiveInputs).toFixed(4));

  return {
    totalInputs,
    coveredInputs: coveredCount,
    exemptInputs: exempted.length,
    uncoveredInputs: uncovered.length,
    coverageRate,
    uncovered,
    exempted,
  };
}
