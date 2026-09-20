import { baseEnvSchema, createEnvConfig, getEnvironment } from './configure';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

describe('createEnvConfig & baseEnvSchema', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('baseEnvSchema defaults', () => {
    it('should provide default values for system environments and leave ENV unset', () => {
      const parsed = baseEnvSchema.parse({});
      expect(parsed.PORT).toBe(3100);
      expect(parsed.GRPC_PORT).toBe(50051);
      expect(parsed.ENV).toBeUndefined();
      expect(parsed.NODE_ENV).toBe('development');
      expect(parsed.TZ).toBe('UTC');
      expect(parsed.LOG_LEVEL).toBe('debug');
      expect(parsed.AI_LLM_TIMEOUT_MS).toBe(120_000);
      expect(parsed.I18N_EXCEPTION_ENABLED).toBe(false);
    });

    it('should correctly coerce string numbers and booleans from environment', () => {
      const parsed = baseEnvSchema.parse({
        PORT: '8080',
        APP_PROXY_ENABLED: 'true',
        AI_LLM_MAX_RETRIES: '5',
        I18N_EXCEPTION_ENABLED: 'true',
      });
      expect(parsed.PORT).toBe(8080);
      expect(typeof parsed.PORT).toBe('number');
      expect(parsed.APP_PROXY_ENABLED).toBe(true);
      expect(parsed.AI_LLM_MAX_RETRIES).toBe(5);
      expect(parsed.I18N_EXCEPTION_ENABLED).toBe(true);
    });
  });

  describe('createEnvConfig', () => {
    it('should load environment variables and return typed vars and sourceMap', () => {
      process.env.MY_SERVICE_PORT = '9000';
      process.env.MY_API_KEY = 'secret-123';

      const appSchema = baseEnvSchema.extend({
        MY_SERVICE_PORT: z.coerce.number().default(9000),
        MY_API_KEY: z.string(),
      });

      const { vars, envSourceMap, isSensitive, environment } = createEnvConfig(appSchema, { loadDotEnv: false });

      expect(vars.MY_SERVICE_PORT).toBe(9000);
      expect(vars.MY_API_KEY).toBe('secret-123');
      expect(envSourceMap.get('MY_SERVICE_PORT')).toBe('host');
      expect(isSensitive('MY_API_KEY')).toBe(true);
      expect(isSensitive('PORT')).toBe(false);
      expect(environment.env).toBe('dev');
      expect(environment.isProd).toBe(false);
    });

    it('should fallback to DOPPLER_ENVIRONMENT when ENV is unset', () => {
      process.env.DOPPLER_ENVIRONMENT = 'prd';
      delete process.env.ENV;

      const { vars, environment } = createEnvConfig(baseEnvSchema, { loadDotEnv: false });
      expect(vars.ENV).toBeUndefined();
      expect(vars.DOPPLER_ENVIRONMENT).toBe('prd');
      expect(environment.env).toBe('prd');
      expect(environment.isProd).toBe(true);

      const helperResult = getEnvironment(vars);
      expect(helperResult.env).toBe('prd');
      expect(helperResult.isProd).toBe(true);
    });

    it('should prioritize explicit ENV over DOPPLER_ENVIRONMENT', () => {
      process.env.ENV = 'stg';
      process.env.DOPPLER_ENVIRONMENT = 'prd';

      const { vars, environment } = createEnvConfig(baseEnvSchema, { loadDotEnv: false });
      expect(vars.ENV).toBe('stg');
      expect(environment.env).toBe('stg');
      expect(environment.isProd).toBe(false);
    });

    it('should throw validation error when required field is missing', () => {
      delete process.env.REQUIRED_TOKEN;

      const appSchema = z.object({
        REQUIRED_TOKEN: z.string(),
      });

      expect(() => {
        createEnvConfig(appSchema, { loadDotEnv: false });
      }).toThrow();
    });
  });
});
