import { baseEnvSchema, createEnvConfig } from './configure';

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
    it('should provide default values for system environments', () => {
      const parsed = baseEnvSchema.parse({});
      expect(parsed.PORT).toBe(3100);
      expect(parsed.GRPC_PORT).toBe(50051);
      expect(parsed.ENV).toBe('dev');
      expect(parsed.NODE_ENV).toBe('development');
      expect(parsed.TZ).toBe('UTC');
      expect(parsed.LOG_LEVEL).toBe('debug');
      expect(parsed.AI_LLM_TIMEOUT_MS).toBe(120_000);
    });

    it('should correctly coerce string numbers and booleans from environment', () => {
      const parsed = baseEnvSchema.parse({
        PORT: '8080',
        APP_PROXY_ENABLED: 'true',
        AI_LLM_MAX_RETRIES: '5',
      });
      expect(parsed.PORT).toBe(8080);
      expect(typeof parsed.PORT).toBe('number');
      expect(parsed.APP_PROXY_ENABLED).toBe(true);
      expect(parsed.AI_LLM_MAX_RETRIES).toBe(5);
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

      const { vars, envSourceMap, isSensitive } = createEnvConfig(appSchema, { loadDotEnv: false });

      expect(vars.MY_SERVICE_PORT).toBe(9000);
      expect(vars.MY_API_KEY).toBe('secret-123');
      expect(envSourceMap.get('MY_SERVICE_PORT')).toBe('host');
      expect(isSensitive('MY_API_KEY')).toBe(true);
      expect(isSensitive('PORT')).toBe(false);
    });

    it('should throw validation error when required field is missing in production', () => {
      process.env.NODE_ENV = 'production';
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
