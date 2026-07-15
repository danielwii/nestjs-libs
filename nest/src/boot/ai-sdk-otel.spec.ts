import {
  AI_SDK_OTEL_OPTIONS,
  AI_SDK_OTEL_REGISTERED,
  isMissingOptionalPackage,
  registerAiSdkOtel,
} from './ai-sdk-otel';

import { describe, expect, it } from 'bun:test';

function missingModule(packageName: string): Error & { code: string } {
  return Object.assign(new Error(`Cannot find module '${packageName}'`), {
    code: 'MODULE_NOT_FOUND',
  });
}

function createSuccessfulModules(onRegister: (integration: unknown) => void = () => undefined) {
  let constructorOptions: unknown;
  class FakeOpenTelemetry {
    constructor(options: unknown) {
      constructorOptions = options;
    }
  }

  return {
    load(packageName: 'ai' | '@ai-sdk/otel'): unknown {
      return packageName === 'ai'
        ? { registerTelemetry: (integration: unknown) => onRegister(integration) }
        : { OpenTelemetry: FakeOpenTelemetry };
    },
    getConstructorOptions: () => constructorOptions,
  };
}

describe('registerAiSdkOtel', () => {
  it('registers once per process-global marker with explicit supplemental options', () => {
    const globals: Record<PropertyKey, unknown> = {};
    const integrations: unknown[] = [];
    const modules = createSuccessfulModules((integration) => integrations.push(integration));

    expect(registerAiSdkOtel({ globals, load: modules.load })).toEqual({ status: 'registered' });
    expect(registerAiSdkOtel({ globals, load: modules.load })).toEqual({ status: 'already_registered' });

    expect(integrations).toHaveLength(1);
    expect(modules.getConstructorOptions()).toEqual(AI_SDK_OTEL_OPTIONS);
    expect(globals[AI_SDK_OTEL_REGISTERED]).toBe(true);
  });

  it.each(['ai', '@ai-sdk/otel'] as const)('reports an exact missing optional dependency: %s', (missingPackage) => {
    const modules = createSuccessfulModules();
    const result = registerAiSdkOtel({
      globals: {},
      load: (packageName) => {
        if (packageName === missingPackage) throw missingModule(packageName);
        return modules.load(packageName);
      },
    });

    expect(result).toEqual({ status: 'dependency_missing', packageName: missingPackage });
  });

  it('does not misreport a broken transitive dependency as the requested package being absent', () => {
    const expected = missingModule('broken-transitive-package');

    const result = registerAiSdkOtel({
      globals: {},
      load: (packageName) => {
        if (packageName === 'ai') throw expected;
        return {};
      },
    });

    expect(result).toEqual({ status: 'failed', error: expected });
  });

  it('reports constructor failure and leaves registration retryable', () => {
    const globals: Record<PropertyKey, unknown> = {};
    const expected = new Error('constructor failed');

    const failed = registerAiSdkOtel({
      globals,
      load: (packageName) =>
        packageName === 'ai'
          ? { registerTelemetry: () => undefined }
          : {
              OpenTelemetry: class {
                constructor() {
                  throw expected;
                }
              },
            },
    });

    expect(failed).toEqual({ status: 'failed', error: expected });
    expect(globals[AI_SDK_OTEL_REGISTERED]).toBeUndefined();

    const modules = createSuccessfulModules();
    expect(registerAiSdkOtel({ globals, load: modules.load })).toEqual({ status: 'registered' });
  });

  it('reports registration failure with its original error', () => {
    const expected = new Error('registration failed');
    const modules = createSuccessfulModules(() => {
      throw expected;
    });

    expect(registerAiSdkOtel({ globals: {}, load: modules.load })).toEqual({
      status: 'failed',
      error: expected,
    });
  });
});

describe('isMissingOptionalPackage', () => {
  it('requires both a module-not-found code and the exact requested package', () => {
    expect(isMissingOptionalPackage(missingModule('ai'), 'ai')).toBe(true);
    expect(isMissingOptionalPackage(missingModule('@ai-sdk/otel'), '@ai-sdk/otel')).toBe(true);
    expect(isMissingOptionalPackage(missingModule('@ai-sdk/provider'), '@ai-sdk/otel')).toBe(false);
    expect(isMissingOptionalPackage(new Error("Cannot find module 'ai'"), 'ai')).toBe(false);
  });
});
