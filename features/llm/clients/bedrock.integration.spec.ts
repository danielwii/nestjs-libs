/**
 * AWS Bedrock provider integration tests.
 *
 * 复用 llm.ai-options.integration.spec.ts 的 captured-fetch 模式：
 * mock 共享 ApiFetcher，验证请求边界（URL / headers / body），不触达外部服务。
 *
 * 覆盖 spec 的 M5/M6/M11/M12/N1/S2。
 */

import 'reflect-metadata';

import { SysEnv } from '@app/env';
import { ApiFetcher } from '@app/utils/fetch';

import { registerModel } from '../types/model.types';
import { LLM } from './llm.class';
import { resetLLMClients } from './llm.clients';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { LLMModelSpec } from '../types/model.types';

const sysEnvMut = SysEnv as unknown as Record<string, string | undefined>;

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: string | undefined;
}

let capturedRequests: CapturedRequest[] = [];
const originalFetch = ApiFetcher.fetch;

const AWS_ENV_KEYS = [
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'AWS_PROFILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
] as const;
let savedAwsEnv: Record<string, string | undefined> = {};
let savedBedrockApiKey: string | undefined;
let savedBedrockRegion: string | undefined;
let savedOpenRouterApiKey: string | undefined;

beforeEach(() => {
  capturedRequests = [];
  // 隔离 AWS 凭证环境变量，避免本地开发环境污染测试
  savedAwsEnv = {};
  for (const key of AWS_ENV_KEYS) {
    savedAwsEnv[key] = process.env[key];
    delete process.env[key];
  }
  savedBedrockApiKey = sysEnvMut.AI_BEDROCK_API_KEY;
  sysEnvMut.AI_BEDROCK_API_KEY = 'test-bedrock-key';
  savedBedrockRegion = sysEnvMut.AI_BEDROCK_REGION;
  delete sysEnvMut.AI_BEDROCK_REGION;
  // prepareStep 测试的 base model 走 openrouter
  savedOpenRouterApiKey = sysEnvMut.AI_OPENROUTER_API_KEY;
  sysEnvMut.AI_OPENROUTER_API_KEY = 'test-openrouter-key';

  (ApiFetcher as unknown as { fetch: typeof fetch }).fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    capturedRequests.push({
      url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(JSON.stringify({ error: { code: 400, message: 'mock-fetch' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  resetLLMClients();
});

afterEach(() => {
  (ApiFetcher as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  for (const key of AWS_ENV_KEYS) {
    if (savedAwsEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedAwsEnv[key];
  }
  if (savedBedrockApiKey === undefined) delete sysEnvMut.AI_BEDROCK_API_KEY;
  else sysEnvMut.AI_BEDROCK_API_KEY = savedBedrockApiKey;
  if (savedBedrockRegion === undefined) delete sysEnvMut.AI_BEDROCK_REGION;
  else sysEnvMut.AI_BEDROCK_REGION = savedBedrockRegion;
  if (savedOpenRouterApiKey === undefined) delete sysEnvMut.AI_OPENROUTER_API_KEY;
  else sysEnvMut.AI_OPENROUTER_API_KEY = savedOpenRouterApiKey;
  resetLLMClients();
});

async function callIgnoringError(fn: () => Promise<unknown> | unknown): Promise<void> {
  try {
    const res = fn();
    if (res && typeof (res as Promise<unknown>).then === 'function') {
      await res;
    }
  } catch {
    // mock fetch 返回 400；测试只断言发出的请求。
  }
}

function firstJsonBody(): Record<string, unknown> {
  expect(capturedRequests.length).toBeGreaterThanOrEqual(1);
  const body = capturedRequests[0]?.body;
  expect(body).toBeDefined();
  return JSON.parse(body!) as Record<string, unknown>;
}

const SIMPLE_MESSAGE = [{ role: 'user' as const, content: 'test' }];

describe('bedrock client', () => {
  it('M5: LLM.model() routes bedrock keys to the bedrock provider', () => {
    const languageModel = LLM.model('bedrock:claude-haiku-4.5') as { provider: string; modelId: string };
    expect(languageModel.provider).toBe('amazon-bedrock');
    expect(languageModel.modelId).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
  });

  it('M6: LLM.model() fails fast with actionable error when no credentials exist', () => {
    delete sysEnvMut.AI_BEDROCK_API_KEY;
    expect(() => LLM.model('bedrock:claude-haiku-4.5')).toThrow(
      /AI_BEDROCK_API_KEY.*AWS_BEARER_TOKEN_BEDROCK.*AWS_ACCESS_KEY_ID/s,
    );
  });

  it('M6: error hints at profile export when only AWS_PROFILE is set', () => {
    delete sysEnvMut.AI_BEDROCK_API_KEY;
    process.env.AWS_PROFILE = 'mission-ai-v2';
    expect(() => LLM.model('bedrock:claude-haiku-4.5')).toThrow(/AWS_PROFILE.*export static credentials/s);
  });

  it('M6: error names deferred credential chain when IRSA env is detected', () => {
    delete sysEnvMut.AI_BEDROCK_API_KEY;
    process.env.AWS_WEB_IDENTITY_TOKEN_FILE = '/var/run/secrets/eks.amazonaws.com/serviceaccount/token';
    expect(() => LLM.model('bedrock:claude-haiku-4.5')).toThrow(/IAM role credentials detected.*not wired yet/s);
  });

  it('M6/S2: SigV4 env credentials alone are accepted and used for signing', async () => {
    delete sysEnvMut.AI_BEDROCK_API_KEY;
    process.env.AWS_ACCESS_KEY_ID = 'test-akid';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';

    await callIgnoringError(() =>
      LLM.generateText({
        id: 'bedrock-sigv4',
        model: 'bedrock:claude-haiku-4.5',
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
      }),
    );

    expect(capturedRequests.length).toBeGreaterThanOrEqual(1);
    const authorization = capturedRequests[0]!.headers.get('authorization') ?? '';
    expect(authorization).toContain('AWS4-HMAC-SHA256');
    expect(authorization).toContain('test-akid');
  });

  it('region: AWS_REGION is honored when AI_BEDROCK_REGION is unset', async () => {
    process.env.AWS_REGION = 'us-west-2';

    await callIgnoringError(() =>
      LLM.generateText({
        id: 'bedrock-aws-region',
        model: 'bedrock:claude-haiku-4.5',
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
      }),
    );

    expect(capturedRequests.length).toBeGreaterThanOrEqual(1);
    expect(capturedRequests[0]!.url).toContain('bedrock-runtime.us-west-2');
  });

  it('region: AI_BEDROCK_REGION takes precedence over AWS_REGION', async () => {
    sysEnvMut.AI_BEDROCK_REGION = 'us-east-2';
    process.env.AWS_REGION = 'us-west-2';

    await callIgnoringError(() =>
      LLM.generateText({
        id: 'bedrock-region-precedence',
        model: 'bedrock:claude-haiku-4.5',
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
      }),
    );

    expect(capturedRequests.length).toBeGreaterThanOrEqual(1);
    expect(capturedRequests[0]!.url).toContain('bedrock-runtime.us-east-2');
  });

  it('region: defaults to us-east-1 when nothing is configured', async () => {
    await callIgnoringError(() =>
      LLM.generateText({
        id: 'bedrock-region-default',
        model: 'bedrock:claude-haiku-4.5',
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
      }),
    );

    expect(capturedRequests.length).toBeGreaterThanOrEqual(1);
    expect(capturedRequests[0]!.url).toContain('bedrock-runtime.us-east-1');
  });
});

describe('bedrock request payload', () => {
  it('M11a/S2: serviceTier lands in the Converse payload for tier-capable models', async () => {
    await callIgnoringError(() =>
      LLM.generateText({
        id: 'bedrock-service-tier-capable',
        model: 'bedrock:kimi-k2.5?bedrock.serviceTier=flex',
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
      }),
    );

    expect(capturedRequests.length).toBeGreaterThanOrEqual(1);
    const first = capturedRequests[0]!;
    // 请求经 ApiFetcher.fetch 发出（被本测试捕获即证明 S2）
    expect(first.url).toContain('bedrock-runtime.');
    expect(first.url).toContain('moonshotai.kimi-k2.5');
    expect(first.headers.get('authorization')).toBe('Bearer test-bedrock-key');

    const body = firstJsonBody();
    expect(body.serviceTier).toEqual({ type: 'flex' });
  });

  it('M11b: reasoning budget lands for anthropic models without serviceTier', async () => {
    await callIgnoringError(() =>
      LLM.generateText({
        id: 'bedrock-reason-budget',
        model: 'bedrock:claude-sonnet-4.5?reason=low',
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
      }),
    );

    const first = capturedRequests[0]!;
    expect(first.url).toContain('us.anthropic.claude-sonnet-4-5');
    const body = firstJsonBody();
    expect(body.serviceTier).toBeUndefined();
    const additional = body.additionalModelRequestFields as Record<string, unknown>;
    expect(additional.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
  });

  it('M11c: tier 参数全透传——Claude 请求 flex 也照样下发(用户自由,AWS 侧自行裁决)', async () => {
    await callIgnoringError(() =>
      LLM.generateText({
        id: 'bedrock-tier-passthrough',
        model: 'bedrock:claude-sonnet-4.5?bedrock.serviceTier=flex',
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
      }),
    );

    // 库不做家族拦截:支持与否由目标账号/区域决定(LLM.checkBedrockServiceTierSupport 自查)
    const body = firstJsonBody();
    expect(body.serviceTier).toEqual({ type: 'flex' });
  });

  it('M11: thinking=none emits reasoningConfig disabled for anthropic keys', async () => {
    await callIgnoringError(() =>
      LLM.generateText({
        id: 'bedrock-no-thinking',
        model: 'bedrock:claude-haiku-4.5',
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
      }),
    );

    const body = firstJsonBody();
    // type=disabled 时 provider 不下发 thinking 字段，也不应有 serviceTier
    expect(JSON.stringify(body)).not.toContain('reasoningConfig');
    expect(JSON.stringify(body)).not.toContain('thinking');
    expect(body.serviceTier).toBeUndefined();
  });

  it('adaptive-only model emits thinking.type=adaptive + output_config.effort', async () => {
    // 注册的 12 个 key 均非 adaptive-only（opus-4.7 因账户未开通已移除），
    // 用 registerModel 扩展点注册测试专用 key 覆盖 adaptive 家族 wire shape。
    registerModel('bedrock:test-adaptive-only', { provider: 'bedrock', modelId: 'us.anthropic.claude-opus-4-8' });

    await callIgnoringError(() =>
      LLM.generateText({
        id: 'bedrock-adaptive-thinking',
        model: 'bedrock:test-adaptive-only?reason=low' as LLMModelSpec,
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
      }),
    );

    const body = firstJsonBody();
    const additional = body.additionalModelRequestFields as Record<string, unknown>;
    // Opus 4.7+ 对 enabled+budget_tokens 返回 400，必须是 adaptive + output_config.effort
    expect(additional.thinking).toEqual({ type: 'adaptive' });
    expect(additional.output_config).toEqual({ effort: 'low' });
    expect(JSON.stringify(additional)).not.toContain('budget_tokens');
  });

  it('M12: reasoningRequired model with reason=none never receives disable options', async () => {
    await callIgnoringError(() =>
      LLM.generateText({
        id: 'bedrock-reasoning-required',
        model: 'bedrock:kimi-k2-thinking?reason=none',
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
      }),
    );

    expect(capturedRequests.length).toBeGreaterThanOrEqual(1);
    expect(capturedRequests[0]!.url).toContain('moonshot.kimi-k2-thinking');
    const body = firstJsonBody();
    expect(JSON.stringify(body)).not.toContain('reasoningConfig');
    expect(JSON.stringify(body)).not.toContain('thinking');
  });

  it('N1: prepareStep.llm.model routes step request to bedrock with step thinking', async () => {
    await callIgnoringError(() =>
      LLM.generateText({
        id: 'bedrock-prepare-step',
        model: 'openrouter:grok-4.3',
        messages: SIMPLE_MESSAGE,
        maxRetries: 0,
        ai: {
          prepareStep: () => ({
            llm: { model: 'bedrock:claude-haiku-4.5?reason=low' },
          }),
        },
      }),
    );

    expect(capturedRequests.length).toBeGreaterThanOrEqual(1);
    const first = capturedRequests[0]!;
    expect(first.url).toContain('bedrock-runtime.');
    expect(first.url).toContain('us.anthropic.claude-haiku-4-5');
    const body = firstJsonBody();
    const additional = body.additionalModelRequestFields as Record<string, unknown>;
    expect(additional.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
  });
});
