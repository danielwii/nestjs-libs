import { stripIndent } from 'common-tags';
import z from 'zod';

import { PromptSpec, PromptSpecSchema } from './prompt.xml';
import { TimeSensitivity } from './prompt';

describe('PromptSpec', () => {
  const mockDate = new Date('2024-01-15T10:30:00Z');

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(mockDate);
  });

  afterEach(() => {
    jest.useRealTimers();
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
      <role>你是AI助手，负责分析用户情感</role>
      <objective>基于用户的对话内容进行情感分析</objective>
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
      ------
      Now:2024-01-15 Monday 10:30 in the morning
    `);
  });
});
