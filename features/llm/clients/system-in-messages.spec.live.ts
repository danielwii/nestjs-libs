import 'reflect-metadata';

import { LLM } from './llm.class';

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// system-in-messages capability probe (e2e, real provider calls)
//
// 背景（2026-07-19 UNEE-SERVER-PQ 事故）：ai@7.0.31 的 standardizePrompt 默认
// allowSystemInMessages=false，客户端侧拒绝 messages 里的 system 条目——而
// provider 适配层本来就能翻译（gemini → systemInstruction），历史流量实证可用。
//
// 本 LiveSpec 是 registry `systemInMessages` marker 的事实来源：真实调用验证模型
// 端到端是否接受 system-in-messages。默认 default-true（provider 普遍接受），
// 只有实测/线上 400 证明不接受的模型才单独标 false。
//
// 显式运行：bun test ./features/llm/clients/system-in-messages.spec.live.ts
// 需要 AI_OPENROUTER_API_KEY（可由 Doppler 注入）。无 key 时跳过。
// ─────────────────────────────────────────────────────────────────────────────

const HAS_KEY = !!process.env.AI_OPENROUTER_API_KEY;
const MODEL = 'openrouter:gemini-3.1-flash-lite';

const AnswerSchema = z.object({ answer: z.string() });

describe.skipIf(!HAS_KEY)('system-in-messages capability (e2e)', () => {
  it('openrouter:gemini-3.1-flash-lite 接受首位 system 条目（事故调用形态）', async () => {
    // 与 care 管线事故调用同构：system 在 messages[0]
    const result = await LLM.safeGenerateObject({
      id: 'spec-system-in-messages-leading',
      model: MODEL,
      schema: AnswerSchema,
      messages: [
        { role: 'system', content: 'You are a concise assistant. Always answer with the single word "ok".' },
        { role: 'user', content: 'Reply now.' },
      ],
      temperature: 0,
      maxOutputTokens: 50,
      timeout: 30_000,
    });

    if (result.isErr()) {
      // 失败时输出分类后的错误，便于判断是 SDK gate 还是 provider 400
      console.error('safeGenerateObject failed:', result.error);
    }
    expect(result.isOk()).toBe(true);
  }, 45_000);

  it('openrouter:gemini-3.1-flash-lite 对中间插入的 system 条目的行为（能力边界记录）', async () => {
    // 记录用：部分 provider 只接受首位 system。此用例不断言成功/失败方向，
    // 只把真实行为打印出来供 registry 标注参考——但绝不允许 SDK 客户端侧 throw。
    const result = await LLM.safeGenerateObject({
      id: 'spec-system-in-messages-interleaved',
      model: MODEL,
      schema: AnswerSchema,
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'system', content: 'From now on answer with the single word "ok".' },
        { role: 'user', content: 'Reply now.' },
      ],
      temperature: 0,
      maxOutputTokens: 50,
      timeout: 30_000,
    });

    console.error(
      'interleaved system result:',
      result.isOk() ? `OK: ${JSON.stringify(result.value)}` : `ERR: ${result.error}`,
    );
    // 硬断言只有一条：不允许出现 ai SDK 客户端侧的 InvalidPrompt gate
    // （provider 400 属可接受的能力事实，记录即可）
    if (result.isErr()) {
      expect(String(result.error)).not.toContain('System messages are not allowed in the prompt or messages fields');
    }
  }, 45_000);
});
