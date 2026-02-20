/**
 * ===============================
 * Prompt System V3
 * ===============================
 *
 * 简化的 Prompt 构建系统，将内容构建与输出要求分离。
 *
 * ## 设计理念
 * - Prompt / PromptBuilder: 纯内容构建（role, objective, context 等）
 * - Enhancement: 可选的结构性指令（CoT, Debug）
 * - Schema: 交给 AI SDK，不在 prompt 中描述
 *
 * ## 使用示例
 *
 * ```typescript
 * // 1. 构建 Prompt
 * const prompt = new PromptBuilder('analyzer', '1.0')
 *   .role('情感分析专家')
 *   .objective('分析用户情感')
 *   .instruction('识别主要情感')
 *   .context({ title: 'user_input', content: msg })
 *   .language('zh-CN')
 *   .build();
 *
 * // 2a. 纯文本输出 - 可选添加 CoT 指令
 * const text = prompt
 *   .withCoT()
 *   .render({ timezone: 'Asia/Shanghai' });
 *
 * await generateText({ model, prompt: text });
 *
 * // 2b. Schema 输出 - 用 wrapWithCoT 包装 schema
 * const userSchema = z.object({ emotion: z.string() });
 * const cotSchema = wrapWithCoT(userSchema);
 *
 * await generateObject({
 *   model,
 *   prompt: prompt.withCoT().render(),
 *   schema: cotSchema,
 * });
 * ```
 */

import { Logger } from '@nestjs/common';

import { normalizeTimezone } from './datetime';
import { f } from './logging';
import { TimeSensitivity } from './prompt';
import { estimateTokens } from './tokenizer';

import { format } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';

// ==================== Types ====================

export interface ContextSection {
  title: string;
  content?: string | number;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  purpose?: string;
}

export interface Example {
  title?: string;
  content: string;
}

export interface PromptData {
  role: string;
  objective: string;
  style?: string;
  tone?: string;
  audience?: string;
  instructions: string[];
  rules: string[];
  examples: Example[];
  sections: ContextSection[];
  output?: string;
  language?: string;
}

export interface RenderOptions {
  timezone?: string | null;
  sensitivity?: TimeSensitivity;
  /** Whether to output token metrics in the log */
  verbose?: boolean;
}

/**
 * Token Metrics for a rendered prompt
 */
export interface PromptMetrics {
  readonly id: string;
  readonly metaTokens: number;
  readonly sectionTokens: Record<string, number>;
  readonly totalContextTokens: number;
  readonly totalTokens: number;
}

// ==================== Prompt Class ====================

export class Prompt {
  readonly id: string;
  readonly version: string;
  readonly data: PromptData;
  private static readonly logger = new Logger('Prompt');

  constructor(id: string, version: string, data: PromptData) {
    this.id = id;
    this.version = version;
    this.data = structuredClone(data);
  }

  /**
   * 渲染为最终 prompt 字符串
   */
  render(options: RenderOptions = {}): string {
    const { timezone, sensitivity = TimeSensitivity.Minute, verbose = false } = options;

    const sections = this.data.sections;
    const sectionMetrics: Record<string, number> = {};

    // 1. Render Meta (everything except sections)
    const rolePart = this.data.role ? `<role priority="critical">${this.data.role}</role>` : '';
    const objectivePart = this.data.objective
      ? `<objective priority="critical">${this.data.objective}</objective>`
      : '';
    const stylePart = this.data.style ? `<style>${this.data.style}</style>` : '';
    const tonePart = this.data.tone ? `<tone>${this.data.tone}</tone>` : '';
    const audiencePart = this.data.audience ? `<audience>${this.data.audience}</audience>` : '';
    const outputPart = this.data.output ? `<output priority="high">${this.data.output}</output>` : '';
    const languagePart = this.data.language
      ? `<language priority="critical">Use "${this.data.language}" as the default response language. Switch to another language if the user explicitly requests it.</language>`
      : '';

    const instructionsPart = this.data.instructions.length
      ? `<instructions priority="high">\n${this.data.instructions
          .map((instruction) =>
            instruction
              .split('\n')
              .map((line) => `  ${line}`)
              .join('\n'),
          )
          .join('\n\n')}\n</instructions>`
      : '';

    const rulesPart = this.data.rules.length
      ? `<rules priority="critical">\n${this.data.rules.join('\n')}\n</rules>`
      : '';

    const examplesPart = this.data.examples.length
      ? `<examples strict="For inspiration only, not to be used as output or reference">\n${this.data.examples
          .map((example) => {
            const title = example.title ? ` title="${example.title}"` : '';
            return `  <example${title}>\n    <content>${example.content}</content>\n  </example>`;
          })
          .join('\n')}\n</examples>`
      : '';

    const metaXml = [
      rolePart,
      objectivePart,
      stylePart,
      tonePart,
      audiencePart,
      instructionsPart,
      rulesPart,
      examplesPart,
      outputPart,
    ]
      .filter(Boolean)
      .join('\n');

    const metaTokens = estimateTokens(metaXml);

    // 2. Render Context Sections
    const renderedSections: string[] = [];
    let totalContextTokens = 0;
    for (const section of sections) {
      const content = section.content ?? '<empty />';
      const priority = section.priority ? ` priority="${section.priority}"` : '';
      const purpose = section.purpose ? ` purpose="${section.purpose}"` : '';
      const sectionXml = `  <section name="${section.title}"${priority}${purpose}>${content}</section>`;
      renderedSections.push(sectionXml);
      const tokens = estimateTokens(sectionXml);
      sectionMetrics[section.title] = tokens;
      totalContextTokens += tokens;
    }
    const contextXml = renderedSections.length > 0 ? `<context>\n${renderedSections.join('\n')}\n</context>` : '';

    // 3. Final Composition
    const base = new Date();
    const normalizedTimezone = normalizeTimezone(timezone);
    const timestamp = normalizedTimezone
      ? formatInTimeZone(base, normalizedTimezone, sensitivity)
      : format(base, sensitivity);

    const fullPrompt = [
      `[${this.id}:${this.version}]`,
      '------',
      metaXml,
      contextXml,
      languagePart,
      '------',
      'When responding, always consider all context items, and always prioritize higher-priority items first: critical > high > medium > low.',
      `Now:${timestamp}`,
    ]
      .filter(Boolean)
      .join('\n');

    if (verbose) {
      const totalTokens = estimateTokens(fullPrompt);
      const report = f`#render [${this.id}:${this.version}] meta=${metaTokens} context=${totalContextTokens} total=${totalTokens} details=${sectionMetrics}`;
      Prompt.logger.log(report);
    }

    return fullPrompt;
  }
}

// ==================== PromptBuilder ====================

/**
 * PromptBuilder 配置（用于 from() 静态方法）
 */
export interface PromptConfig {
  id: string;
  version?: string;
  role: string;
  objective: string;
  style?: string;
  tone?: string;
  audience?: string;
  instructions?: string | string[];
  rules?: string | string[];
  examples?: Example[];
  contexts?: ContextSection[];
  output?: string;
  language?: string;
}

/**
 * Prompt 构建器 - 链式 API 或 JSON 配置
 *
 * @example
 * ```typescript
 * // 方式 1: 链式调用
 * const prompt = new PromptBuilder('analyzer', '1.0')
 *   .role('情感分析专家')
 *   .objective('分析用户情感')
 *   .instruction('识别主要情感')
 *   .build();
 *
 * // 方式 2: JSON 配置
 * const prompt = PromptBuilder.from({
 *   id: 'analyzer',
 *   version: '1.0',
 *   role: '情感分析专家',
 *   objective: '分析用户情感',
 *   instructions: '识别主要情感',
 * });
 * ```
 */
export class PromptBuilder {
  private readonly _id: string;
  private readonly _version: string;
  private _role: string = '';
  private _objective: string = '';
  private _style?: string;
  private _tone?: string;
  private _audience?: string;
  private _instructions: string[] = [];
  private _rules: string[] = [];
  private _examples: Example[] = [];
  private _sections: ContextSection[] = [];
  private _output?: string;
  private _language?: string;

  constructor(id: string, version: string = '1.0') {
    this._id = id;
    this._version = version;
  }

  /**
   * 从配置对象创建 Prompt（快捷方式）
   */
  static from(config: PromptConfig): Prompt {
    const builder = new PromptBuilder(config.id, config.version ?? '1.0');

    builder.role(config.role);
    builder.objective(config.objective);

    if (config.style) builder.style(config.style);
    if (config.tone) builder.tone(config.tone);
    if (config.audience) builder.audience(config.audience);
    if (config.language) builder.language(config.language);

    // instructions: string | string[]
    if (config.instructions) {
      if (Array.isArray(config.instructions)) {
        builder.instructions(config.instructions);
      } else {
        builder.instruction(config.instructions);
      }
    }

    // rules: string | string[]
    if (config.rules) {
      if (Array.isArray(config.rules)) {
        builder.rules(config.rules);
      } else {
        builder.rule(config.rules);
      }
    }

    if (config.examples) builder.examples(config.examples);
    if (config.contexts) builder.contexts(config.contexts);
    if (config.output) builder.output(config.output);

    return builder.build();
  }

  role(role: string): this {
    this._role = role;
    return this;
  }

  objective(objective: string): this {
    this._objective = objective;
    return this;
  }

  style(style: string): this {
    this._style = style;
    return this;
  }

  tone(tone: string): this {
    this._tone = tone;
    return this;
  }

  audience(audience: string): this {
    this._audience = audience;
    return this;
  }

  instruction(text: string): this {
    if (text) {
      this._instructions.push(text);
    }
    return this;
  }

  instructions(texts: string[]): this {
    texts.forEach((t) => this.instruction(t));
    return this;
  }

  rule(text: string): this {
    if (text) {
      this._rules.push(text);
    }
    return this;
  }

  rules(texts: string[]): this {
    texts.forEach((t) => this.rule(t));
    return this;
  }

  example(example: Example): this {
    if (example.content) {
      this._examples.push({ ...example });
    }
    return this;
  }

  examples(exampleList: Example[]): this {
    exampleList.forEach((e) => this.example(e));
    return this;
  }

  context(section: ContextSection): this {
    this._sections.push({ ...section });
    return this;
  }

  contexts(sections: ContextSection[]): this {
    sections.forEach((s) => this.context(s));
    return this;
  }

  language(lang: string): this {
    this._language = lang;
    return this;
  }

  output(text: string): this {
    this._output = text;
    return this;
  }

  /**
   * 构建 Prompt 实例
   */
  build(): Prompt {
    if (!this._role) {
      throw new Error('PromptBuilder: role is required');
    }
    if (!this._objective) {
      throw new Error('PromptBuilder: objective is required');
    }

    const data: PromptData = {
      role: this._role,
      objective: this._objective,
      style: this._style,
      tone: this._tone,
      audience: this._audience,
      instructions: [...this._instructions],
      rules: [...this._rules],
      examples: this._examples.map((e) => ({ ...e })),
      sections: this._sections.map((s) => ({ ...s })),
      output: this._output,
      language: this._language,
    };

    return new Prompt(this._id, this._version, data);
  }
}

// ==================== Re-exports ====================

export { TimeSensitivity };
