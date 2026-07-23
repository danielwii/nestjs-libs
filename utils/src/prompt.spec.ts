import { ErrorCodes } from '@app/nest/exceptions/error-codes';
import { Oops } from '@app/nest/exceptions/oops';

import { formatLocalDateTime, TimeSensitivity } from './prompt';
import { PromptBuilder } from './prompt.xml';

import { Temporal } from '@js-temporal/polyfill';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import dedent from 'dedent';

import type { Prompt, PromptData } from './prompt.xml';

function directPromptConstructionIsUnavailable(data: PromptData): void {
  // @ts-expect-error Prompt is a render contract, not a directly constructible value.
  new Prompt('direct-construction', '1.0', data);
}

void directPromptConstructionIsUnavailable;

describe('Prompt', () => {
  const ORIGINAL_TZ = process.env.TZ;
  const ORIGINAL_DATE = globalThis.Date;
  const mockDate = new Date('2024-01-15T10:30:00Z');

  beforeEach(() => {
    process.env.TZ = 'UTC';
    // Mock Date constructor to return fixed time
    globalThis.Date = class extends ORIGINAL_DATE {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(mockDate.getTime());
        } else {
          super(...(args as [any]));
        }
      }
      static now() {
        return mockDate.getTime();
      }
    } as typeof Date;
  });

  afterEach(() => {
    process.env.TZ = ORIGINAL_TZ;
    globalThis.Date = ORIGINAL_DATE;
  });

  it('基础 prompt 渲染', () => {
    const prompt = new PromptBuilder('emotion-analysis', '1.0')
      .role('你是AI助手，负责分析用户情感')
      .objective('基于用户的对话内容进行情感分析')
      .style('参照 Dyson 等成功公司的宣传风格，它们在推广类似产品时的文案风格。')
      .tone('口语化')
      .audience('其他虚拟AI角色')
      .instruction(
        dedent`
        ## 分析用户情感
        - 仔细分析用户的语言表达
        - 识别情感状态的细微变化
        - 提供有建设性的建议
      `,
      )
      .rule(
        dedent`
        ## 规则1
        - 不要提供有害或不当的内容
      `,
      )
      .rule(
        dedent`
        ## 规则2
        - 不要提供有害或不当的内容
      `,
      )
      .example({ title: '正面情感示例', content: '用户说："今天心情很好！"，分析结果应该是积极的。' })
      .example({ content: '用户说："我很困惑"，应该识别为困惑情绪。' })
      .context({ title: 'user_message', content: '用户的原始消息', priority: 'high', purpose: '主输入消息' })
      .context({ title: 'conversation_history', content: '对话历史', purpose: '用于参考' })
      .context({ title: 'empty_context' })
      .language('中文')
      .build();

    const result = prompt.render({ timezone: 'UTC', sensitivity: TimeSensitivity.Minute });

    expect(result).toBe(dedent`
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
      <language priority="critical">Preferred response language: "中文". Use this by default. Match the user's current message language if they actively switch (code-switching), and honor explicit requests to use another language (e.g., "Please speak Spanish"). For translation queries ("how do you say X in Y"), answer in the preferred language and embed the translation.</language>
      ------
      When responding, always consider all context items, and always prioritize higher-priority items first: critical > high > medium > low.
      Now:2024-01-15 Monday 10:30 in the morning (UTC)
    `);
  });
});

describe('PromptBuilder', () => {
  const ORIGINAL_TZ = process.env.TZ;
  const ORIGINAL_DATE = globalThis.Date;
  const mockDate = new Date('2024-01-15T10:30:00Z');

  beforeEach(() => {
    process.env.TZ = 'UTC';
    // Mock Date constructor to return fixed time
    globalThis.Date = class extends ORIGINAL_DATE {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(mockDate.getTime());
        } else {
          super(...(args as [any]));
        }
      }
      static now() {
        return mockDate.getTime();
      }
    } as typeof Date;
  });

  afterEach(() => {
    process.env.TZ = ORIGINAL_TZ;
    globalThis.Date = ORIGINAL_DATE;
  });

  it('构造完整 prompt 并生成', () => {
    const prompt = new PromptBuilder('builder-test', '1.2')
      .role('测试角色')
      .objective('测试目标')
      .style('KOL')
      .tone('温柔')
      .audience('儿童')
      .instruction('遵循规则')
      .rule('禁止输出附件')
      .example({ title: '示例A', content: '展示风格A' })
      .context({ title: 'section', content: '内容', priority: 'critical' })
      .language('zh-Hans')
      .build();

    const result = prompt.render({ timezone: 'UTC', sensitivity: TimeSensitivity.Minute });

    expect(result).toBe(dedent`
      [builder-test:1.2]
      ------
      <role priority="critical">测试角色</role>
      <objective priority="critical">测试目标</objective>
      <style>KOL</style>
      <tone>温柔</tone>
      <audience>儿童</audience>
      <instructions priority="high">
        遵循规则
      </instructions>
      <rules priority="critical">
      禁止输出附件
      </rules>
      <examples strict="For inspiration only, not to be used as output or reference">
        <example title="示例A">
          <content>展示风格A</content>
        </example>
      </examples>
      <context>
        <section name="section" priority="critical">内容</section>
      </context>
      <language priority="critical">Preferred response language: "zh-Hans". Use this by default. Match the user's current message language if they actively switch (code-switching), and honor explicit requests to use another language (e.g., "Please speak Spanish"). For translation queries ("how do you say X in Y"), answer in the preferred language and embed the translation.</language>
      ------
      When responding, always consider all context items, and always prioritize higher-priority items first: critical > high > medium > low.
      Now:2024-01-15 Monday 10:30 in the morning (UTC)
    `);
  });

  it('JSON config 与链式构建渲染一致', () => {
    const config = {
      id: 'config-builder-test',
      version: '1.0',
      role: '测试角色',
      objective: '验证 JSON 配置入口',
      style: '简洁',
      tone: '友好',
      audience: '测试用户',
      instructions: ['第一条指令', '第二条指令'],
      rules: ['第一条规则'],
      examples: [{ title: '示例', content: '示例内容' }],
      contexts: [{ title: 'input', content: '用户输入', priority: 'critical' as const }],
      output: '输出正文',
      language: 'zh-Hans',
      languagePolicy: 'system-output' as const,
      epilogue: '最终约束',
    };

    const renderOptions = {
      now: '2024-01-15T02:30:00Z',
      timezone: '+08:00',
      sensitivity: TimeSensitivity.Minute,
    } as const;

    const fromConfig = PromptBuilder.from(config).render(renderOptions);
    const fromChain = new PromptBuilder(config.id, config.version)
      .role(config.role)
      .objective(config.objective)
      .style(config.style)
      .tone(config.tone)
      .audience(config.audience)
      .instructions(config.instructions)
      .rules(config.rules)
      .examples(config.examples)
      .contexts(config.contexts)
      .output(config.output)
      .language(config.language, config.languagePolicy)
      .epilogue(config.epilogue)
      .build()
      .render(renderOptions);

    expect(fromConfig).toBe(fromChain);
  });

  it('JSON config 支持固定时钟以保证 replay 可复现', () => {
    const rendered = PromptBuilder.from({
      id: 'fixed-clock',
      role: '测试角色',
      objective: '验证固定时钟',
    }).render({
      now: '2024-01-15T02:30:00Z',
      timezone: 'Asia/Shanghai',
      sensitivity: TimeSensitivity.Minute,
    });

    expect(rendered).toContain('Now:2024-01-15 Monday 10:30 in the morning (Asia/Shanghai)');
  });

  it('system-output language policy 固定保存与卡片内容语言', () => {
    const rendered = PromptBuilder.from({
      id: 'system-output-language',
      role: '摘要器',
      objective: '生成需要保存的摘要',
      language: 'zh-Hans',
      languagePolicy: 'system-output',
    }).render({ now: '2024-01-15T02:30:00Z', timezone: 'UTC' });

    expect(rendered).toContain('System output language: "zh-Hans"');
    expect(rendered).toContain('content intended for storage, cards, or other UI output');
    expect(rendered).not.toContain("Match the user's current message language");
  });

  it('应该正确处理旧格式时区 "+8"', () => {
    const prompt = new PromptBuilder('tz-test', '1.0').role('测试').objective('验证时区').build();

    const result = prompt.render({ timezone: '+8', sensitivity: TimeSensitivity.Minute });
    expect(result).toContain('Now:2024-01-15 Monday 18:30 in the evening (UTC+8)');
  });

  it('应该正确处理新格式时区 "+08:00"', () => {
    const prompt = new PromptBuilder('tz-test', '1.0').role('测试').objective('验证时区').build();

    const result = prompt.render({ timezone: '+08:00', sensitivity: TimeSensitivity.Minute });
    expect(result).toContain('Now:2024-01-15 Monday 18:30 in the evening (UTC+8)');
  });

  it('应该正确处理 IANA 格式时区 "Asia/Tokyo"', () => {
    const prompt = new PromptBuilder('tz-test', '1.0').role('测试').objective('验证时区').build();

    const result = prompt.render({ timezone: 'Asia/Tokyo', sensitivity: TimeSensitivity.Minute });
    expect(result).toContain('Now:2024-01-15 Monday 19:30 in the evening (Asia/Tokyo)');
  });

  it('应该直接格式化 Temporal.Instant 输入', () => {
    const instant = Temporal.Instant.from('2024-01-15T10:30:00Z');

    expect(formatLocalDateTime(instant, TimeSensitivity.Minute, 'Asia/Tokyo')).toBe(
      '2024-01-15 Monday 19:30 in the evening (Asia/Tokyo)',
    );
  });

  it('缺少 role 应抛出错误', () => {
    const build = () => {
      new PromptBuilder('test', '1.0').objective('目标').build();
    };

    expect(build).toThrow(Oops.Panic);
    try {
      build();
    } catch (error) {
      expect(error).toMatchObject({
        httpStatus: 500,
        errorCode: ErrorCodes.SYSTEM_CONFIG_ERROR,
        oopsCode: 'GN11',
        internalDetails: 'Configuration error: PromptBuilder: role is required',
      });
    }
  });

  it('缺少 objective 应抛出错误', () => {
    const build = () => {
      new PromptBuilder('test', '1.0').role('角色').build();
    };

    expect(build).toThrow(Oops.Panic);
    try {
      build();
    } catch (error) {
      expect(error).toMatchObject({
        httpStatus: 500,
        errorCode: ErrorCodes.SYSTEM_CONFIG_ERROR,
        oopsCode: 'GN11',
        internalDetails: 'Configuration error: PromptBuilder: objective is required',
      });
    }
  });
});
