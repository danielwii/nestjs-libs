import { TimeSensitivity } from './prompt';
import { PromptBuilder, wrapWithCoT, wrapWithDebug } from './prompt.xml';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import dedent from 'dedent';
import { z } from 'zod';

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

      <language priority="critical">Use "中文" as the default response language. Switch to another language if the user explicitly requests it.</language>
      ------
      When responding, always consider all context items, and always prioritize higher-priority items first: critical > high > medium > low.
      Now:2024-01-15 Monday 10:30 in the morning
    `);
  });

  it('withCoT 应添加推理结构指令', () => {
    const prompt = new PromptBuilder('analyzer', '1.0').role('分析师').objective('分析数据').build().withCoT();

    const result = prompt.render({ timezone: 'UTC', sensitivity: TimeSensitivity.Minute });

    expect(result).toBe(dedent`
      [analyzer:1.0]
      ------
      <role priority="critical">分析师</role>
      <objective priority="critical">分析数据</objective>

      <output-structure priority="high">
        Before providing your final answer, follow this structure:
        1. "reasoning": Think through the problem step by step
        2. "scratchpad": Use for calculations, notes, or intermediate steps
        3. "result": Your final answer
      </output-structure>
      ------
      When responding, always consider all context items, and always prioritize higher-priority items first: critical > high > medium > low.
      Now:2024-01-15 Monday 10:30 in the morning
    `);

    expect(prompt.hasCoT()).toBe(true);
    expect(prompt.hasDebug()).toBe(false);
  });

  it('withDebug 应添加 CoT + 自我评估指令', () => {
    const prompt = new PromptBuilder('debugger', '2.0').role('调试专家').objective('调试代码').build().withDebug();

    const result = prompt.render({ timezone: 'UTC', sensitivity: TimeSensitivity.Minute });

    expect(result).toBe(dedent`
      [debugger:2.0]
      ------
      <role priority="critical">调试专家</role>
      <objective priority="critical">调试代码</objective>

      <output-structure priority="high">
        Before providing your final answer, follow this structure:
        1. "reasoning": Think through the problem step by step
        2. "scratchpad": Use for calculations, notes, or intermediate steps
        3. "result": Your final answer
      </output-structure>

      <self-evaluation priority="medium">
        Additionally, evaluate your response quality:
        - "overall_confidence": Your confidence in this answer (0-1)
        - "module_confidence": How well you followed each prompt section
        - "gigo_analysis": Assess input quality and identify potential issues
      </self-evaluation>
      ------
      When responding, always consider all context items, and always prioritize higher-priority items first: critical > high > medium > low.
      Now:2024-01-15 Monday 10:30 in the morning
    `);

    expect(prompt.hasCoT()).toBe(true);
    expect(prompt.hasDebug()).toBe(true);
  });

  it('Prompt 应该是不可变的', () => {
    const original = new PromptBuilder('test', '1.0').role('角色').objective('目标').build();

    const withCot = original.withCoT();
    const withDebug = original.withDebug();

    // 原始实例不应被修改
    expect(original.hasCoT()).toBe(false);
    expect(original.hasDebug()).toBe(false);

    // 新实例有各自的状态
    expect(withCot.hasCoT()).toBe(true);
    expect(withCot.hasDebug()).toBe(false);

    expect(withDebug.hasCoT()).toBe(true);
    expect(withDebug.hasDebug()).toBe(true);
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

      <language priority="critical">Use "zh-Hans" as the default response language. Switch to another language if the user explicitly requests it.</language>
      ------
      When responding, always consider all context items, and always prioritize higher-priority items first: critical > high > medium > low.
      Now:2024-01-15 Monday 10:30 in the morning
    `);
  });

  it('应该正确处理旧格式时区 "+8"', () => {
    const prompt = new PromptBuilder('tz-test', '1.0').role('测试').objective('验证时区').build();

    const result = prompt.render({ timezone: '+8', sensitivity: TimeSensitivity.Minute });
    expect(result).toContain('Now:2024-01-15 Monday 18:30 in the evening');
  });

  it('应该正确处理新格式时区 "+08:00"', () => {
    const prompt = new PromptBuilder('tz-test', '1.0').role('测试').objective('验证时区').build();

    const result = prompt.render({ timezone: '+08:00', sensitivity: TimeSensitivity.Minute });
    expect(result).toContain('Now:2024-01-15 Monday 18:30 in the evening');
  });

  it('应该正确处理 IANA 格式时区 "Asia/Tokyo"', () => {
    const prompt = new PromptBuilder('tz-test', '1.0').role('测试').objective('验证时区').build();

    const result = prompt.render({ timezone: 'Asia/Tokyo', sensitivity: TimeSensitivity.Minute });
    expect(result).toContain('Now:2024-01-15 Monday 19:30 in the evening');
  });

  it('缺少 role 应抛出错误', () => {
    expect(() => {
      new PromptBuilder('test', '1.0').objective('目标').build();
    }).toThrow('PromptBuilder: role is required');
  });

  it('缺少 objective 应抛出错误', () => {
    expect(() => {
      new PromptBuilder('test', '1.0').role('角色').build();
    }).toThrow('PromptBuilder: objective is required');
  });
});

describe('Schema Wrappers', () => {
  it('wrapWithCoT 应包装用户 schema', () => {
    const userSchema = z.object({ answer: z.string() });
    const cotSchema = wrapWithCoT(userSchema);

    // 验证包装后的 schema 结构
    const shape = cotSchema.shape;
    expect(shape.reasoning).toBeDefined();
    expect(shape.scratchpad).toBeDefined();
    expect(shape.result).toBeDefined();

    // 验证可以正确解析
    const validData = {
      reasoning: '思考过程',
      scratchpad: '草稿',
      result: { answer: '答案' },
    };
    expect(() => cotSchema.parse(validData)).not.toThrow();
  });

  it('wrapWithDebug 应包装用户 schema 并添加调试字段', () => {
    const userSchema = z.object({ score: z.number() });
    const debugSchema = wrapWithDebug(userSchema);

    // 验证包装后的 schema 结构
    const shape = debugSchema.shape;
    expect(shape.reasoning).toBeDefined();
    expect(shape.scratchpad).toBeDefined();
    expect(shape.result).toBeDefined();
    expect(shape.overall_confidence).toBeDefined();
    expect(shape.module_confidence).toBeDefined();
    expect(shape.gigo_analysis).toBeDefined();

    // 验证可以正确解析
    const validData = {
      reasoning: '推理',
      scratchpad: '笔记',
      result: { score: 85 },
      overall_confidence: 0.9,
      module_confidence: {
        role: 0.95,
      },
      gigo_analysis: {
        input_quality_assessment: {
          role_clarity: 0.9,
          objective_specificity: 0.85,
          instruction_coherence: 0.88,
          context_relevance: 0.92,
        },
        garbage_indicators: {
          ambiguous_terms: [],
          conflicting_directives: [],
          missing_context: [],
        },
        garbage_score: 0.1,
        gold_potential: 0.95,
      },
    };
    expect(() => debugSchema.parse(validData)).not.toThrow();
  });
});
