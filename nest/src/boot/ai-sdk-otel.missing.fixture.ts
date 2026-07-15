import { registerAiSdkOtel } from './ai-sdk-otel';

const missingPackage = process.argv[2];
if (missingPackage !== 'ai' && missingPackage !== '@ai-sdk/otel') {
  throw new Error('fixture requires ai or @ai-sdk/otel');
}

const result = registerAiSdkOtel({
  globals: {},
  load: (packageName) => {
    if (packageName === missingPackage) {
      throw Object.assign(new Error(`Cannot find module '${packageName}'`), {
        code: 'MODULE_NOT_FOUND',
      });
    }
    if (packageName === 'ai') {
      return { registerTelemetry: () => undefined };
    }
    return { OpenTelemetry: class {} };
  },
});

process.stdout.write(`${JSON.stringify(result)}\n`);
