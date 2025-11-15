import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { stripIndent } from 'common-tags';
import z from 'zod';

import { TimeSensitivity } from './prompt';
import { PromptSpec, PromptSpecBuilder, PromptSpecSchema } from './prompt.xml';

describe('PromptSpec', () => {
  const ORIGINAL_TZ = process.env.TZ;
  const mockDate = new Date('2024-01-15T10:30:00Z');

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(mockDate);
    process.env.TZ = 'UTC'; // ensure stable timezone for date-fns formatting
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env.TZ = ORIGINAL_TZ;
  });

  it('应该完整支持所有功能', () => {
    // 测试基本构造
    const data: PromptSpecSchema = {
      role: '你是AI助手，负责分析用户情感',
      objective: '基于用户的对话内容进行情感分析',
      style: '参照 Dyson 等成功公司的宣传风格，它们在推广类似产品时的文案风格。',
      tone: '口语化',
      audience: '其他虚拟AI角色',
      instructions: [
        stripIndent`
          ## 分析用户情感
          - 仔细分析用户的语言表达
          - 识别情感状态的细微变化
          - 提供有建设性的建议
        `,
      ],
      rules: [
        stripIndent`
          ## 规则1
          - 不要提供有害或不当的内容
        `,
        stripIndent`
          ## 规则2
          - 不要提供有害或不当的内容
        `,
      ],
      examples: [
        {
          title: '正面情感示例',
          content: '用户说："今天心情很好！"，分析结果应该是积极的。',
        },
        {
          content: '用户说："我很困惑"，应该识别为困惑情绪。',
        },
      ],
      context: [
        { title: 'user_message', content: '用户的原始消息', priority: 'high', purpose: '主输入消息' },
        { title: 'conversation_history', content: '对话历史', purpose: '用于参考' },
        { title: 'empty_context' },
      ],
      // output: {
      //   type: 'string', // 默认 string
      //   // schema: z.string(),
      //   useCoT: true, // 嵌套 schema 为 result，没有 schema 时再在 xml 的 output 中输出 output
      //   debug: true,
      // },
      language: '中文',
    };

    const builder = new PromptSpec('emotion-analysis', data, {
      version: '1.0',
      tz: 'UTC',
      sensitivity: TimeSensitivity.Minute,
      llmOptions: {
        model: 'gpt-4.1-mini',
        temperature: 0.5,
        maxOutputTokens: 1000,
      },
      // 自由传，用于扩展 PromptSpec 的功能
      extra: {
        includeSystemPrompt: true,
        systemPrompt: stripIndent`
          You are a helpful assistant.
        `,
      },
    });

    // 测试默认行为（包含输出）
    const promptWithOutput = builder.build();
    console.log(promptWithOutput);
    expect(builder.llmOptions).toEqual({
      model: 'gpt-4.1-mini',
      temperature: 0.5,
      maxOutputTokens: 1000,
    });
    expect(promptWithOutput).toBe(stripIndent`
      [emotion-analysis:1.0]
      ------
      <role priority="critical">你是AI助手，负责分析用户情感</role>
      <objective priority="critical">基于用户的对话内容进行情感分析</objective>
      <style>参照 Dyson 等成功公司的宣传风格，它们在推广类似产品时的文案风格。</style>
      <tone>口语化</tone>
      <audience>其他虚拟AI角色</audience>

      <instructions priority="high">
        ## 分析用户情感
        - 仔细分析用户的语言表达
        - 识别情感状态的细微变化
        - 提供有建设性的建议
      </instructions>

      <rules priority="critical">
      ## 规则1
      - 不要提供有害或不当的内容
      ## 规则2
      - 不要提供有害或不当的内容
      </rules>

      <examples strict="For inspiration only, not to be used as output or reference">
        <example title="正面情感示例">
          <content>用户说："今天心情很好！"，分析结果应该是积极的。</content>
        </example>
        <example>
          <content>用户说："我很困惑"，应该识别为困惑情绪。</content>
        </example>
      </examples>

      <context>
        <section name="user_message" priority="high" purpose="主输入消息">用户的原始消息</section>
        <section name="conversation_history" purpose="用于参考">对话历史</section>
        <section name="empty_context"><empty /></section>
      </context>
      
      <language priority="critical">Use "中文" as the main response language.</language>
      ------
      When responding, always consider all context items, and always prioritize higher-priority items first: critical > high > medium > low.
      Now:2024-01-15 Monday 10:30 in the morning
    `);
  });

  it('Schema 输出模式应生成完整 JSON 指引', () => {
    const schemaData: PromptSpecSchema & { schema: z.ZodTypeAny } = {
      role: '智能助手',
      objective: '生成结构化输出',
      instructions: ['保持温柔'],
      rules: ['只输出 JSON'],
      context: [{ title: 'section', content: '内容', priority: 'critical' }],
      output: { type: 'schema', useCoT: false },
      schema: z.object({ cnt: z.string(), nmr: z.boolean() }),
      language: 'zh-Hans',
    };

    const prompt = new PromptSpec('structured-response', schemaData, {
      version: '2',
      tz: 'UTC',
      sensitivity: TimeSensitivity.Minute,
    }).build();

    expect(prompt).toBe(
      `[structured-response:2]
------
<role priority="critical">智能助手</role>
<objective priority="critical">生成结构化输出</objective>

<instructions priority="high">
  保持温柔
</instructions>

<rules priority="critical">
只输出 JSON
</rules>

<context>
  <section name="section" priority="critical">内容</section>
</context>

<output>
  <format>Strictly output a single JSON object that conforms to the schema below. Do not include any additional commentary.</format>
  <schema>
{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"cnt":{"type":"string"},"nmr":{"type":"boolean"}},"required":["cnt","nmr"],"additionalProperties":false}
  </schema>
</output>

<language priority="critical">Use "zh-Hans" as the main response language.</language>
------
When responding, always consider all context items, and always prioritize higher-priority items first: critical > high > medium > low.
Now:2024-01-15 Monday 10:30 in the morning`,
    );
  });
});

describe('PromptSpecBuilder', () => {
  const ORIGINAL_TZ = process.env.TZ;
  const mockDate = new Date('2024-01-15T10:30:00Z');

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(mockDate);
    process.env.TZ = 'UTC';
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env.TZ = ORIGINAL_TZ;
  });

  it('构造完整 blueprint 并生成 prompt', () => {
    const builder = new PromptSpecBuilder('builder-test', '1.2')
      .setRole('测试角色')
      .setObjective('测试目标')
      .setStyle('KOL')
      .setTone('温柔')
      .setAudience('儿童')
      .addInstruction('遵循规则')
      .addRule('禁止输出附件')
      .addExample({ title: '示例A', content: '展示风格A' })
      .addSection({ title: 'section', content: '内容', priority: 'critical' })
      .setOutput({ type: 'schema', useCoT: false })
      .setLanguage('zh-Hans')
      .setSchema(z.object({ answer: z.string() }));

    const prompt = builder
      .buildPromptSpec({
        tz: 'UTC',
        sensitivity: TimeSensitivity.Minute,
      })
      .build();

    const expected = [
      '[builder-test:1.2]',
      '------',
      '<role priority="critical">测试角色</role>',
      '<objective priority="critical">测试目标</objective>',
      '<style>KOL</style>',
      '<tone>温柔</tone>',
      '<audience>儿童</audience>',
      '',
      '<instructions priority="high">',
      '  遵循规则',
      '</instructions>',
      '',
      '<rules priority="critical">',
      '禁止输出附件',
      '</rules>',
      '',
      '<examples strict="For inspiration only, not to be used as output or reference">',
      '  <example title="示例A">',
      '    <content>展示风格A</content>',
      '  </example>',
      '</examples>',
      '',
      '<context>',
      '  <section name="section" priority="critical">内容</section>',
      '</context>',
      '',
      '<output>',
      '  <format>Strictly output a single JSON object that conforms to the schema below. Do not include any additional commentary.</format>',
      '  <schema>',
      '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}',
      '  </schema>',
      '</output>',
      '',
      '<language priority="critical">Use "zh-Hans" as the main response language.</language>',
      '------',
      'When responding, always consider all context items, and always prioritize higher-priority items first: critical > high > medium > low.',
      'Now:2024-01-15 Monday 10:30 in the morning',
    ].join('\n');

    expect(prompt).toBe(expected);
  });

  it('应该正确处理旧格式时区 "+8"', () => {
    const builder = new PromptSpecBuilder('tz-test', '1.0').setRole('测试').setObjective('验证时区');

    const prompt = builder
      .buildPromptSpec({
        tz: '+8', // 旧格式，应该自动转换为 Asia/Shanghai
        sensitivity: TimeSensitivity.Minute,
      })
      .build();

    // 应该包含正确的时间戳（18:30 对应 UTC+8）
    expect(prompt).toContain('Now:2024-01-15 Monday 18:30 in the evening');
  });

  it('应该正确处理新格式时区 "+08:00"', () => {
    const builder = new PromptSpecBuilder('tz-test', '1.0').setRole('测试').setObjective('验证时区');

    const prompt = builder
      .buildPromptSpec({
        tz: '+08:00', // 新格式，应该自动转换为 Asia/Shanghai
        sensitivity: TimeSensitivity.Minute,
      })
      .build();

    expect(prompt).toContain('Now:2024-01-15 Monday 18:30 in the evening');
  });

  it('应该正确处理 IANA 格式时区 "Asia/Tokyo"', () => {
    const builder = new PromptSpecBuilder('tz-test', '1.0').setRole('测试').setObjective('验证时区');

    const prompt = builder
      .buildPromptSpec({
        tz: 'Asia/Tokyo', // IANA 格式，直接使用
        sensitivity: TimeSensitivity.Minute,
      })
      .build();

    // UTC+9，所以是 19:30
    expect(prompt).toContain('Now:2024-01-15 Monday 19:30 in the evening');
  });
});
