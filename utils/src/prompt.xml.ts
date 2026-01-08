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

import { normalizeTimezone } from './datetime';
import { TimeSensitivity } from './prompt';

import { stripIndent } from 'common-tags';
import { format } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { z } from 'zod';

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
  language?: string;
}

export interface RenderOptions {
  timezone?: string | null;
  sensitivity?: TimeSensitivity;
}

// ==================== Enhancement Instructions ====================

const COT_INSTRUCTION = stripIndent`
  <output-structure priority="high">
    Before providing your final answer, follow this structure:
    1. "reasoning": Think through the problem step by step
    2. "scratchpad": Use for calculations, notes, or intermediate steps
    3. "result": Your final answer
  </output-structure>
`;

const DEBUG_INSTRUCTION = stripIndent`
  <self-evaluation priority="medium">
    Additionally, evaluate your response quality:
    - "overall_confidence": Your confidence in this answer (0-1)
    - "module_confidence": How well you followed each prompt section
    - "gigo_analysis": Assess input quality and identify potential issues
  </self-evaluation>
`;

// ==================== Schema Wrappers ====================

/** Module confidence schema for debug mode */
export const ModuleConfidenceSchema = z.object({
  role: z.number().min(0).max(1).describe('角色定义执行置信度(0-1)'),
  objective: z.number().min(0).max(1).optional().describe('任务目标达成置信度(0-1)'),
  style: z.number().min(0).max(1).optional().describe('写作风格匹配置信度(0-1)'),
  tone: z.number().min(0).max(1).optional().describe('情感语调把握置信度(0-1)'),
  audience: z.number().min(0).max(1).optional().describe('目标受众适配置信度(0-1)'),
  instructions: z.number().min(0).max(1).optional().describe('指令遵循置信度(0-1)'),
  rules: z.number().min(0).max(1).optional().describe('规则遵守置信度(0-1)'),
  context: z.number().min(0).max(1).optional().describe('上下文理解置信度(0-1)'),
});

/** GIGO analysis schema for debug mode */
export const GigoAnalysisSchema = z.object({
  input_quality_assessment: z.object({
    role_clarity: z.number().min(0).max(1).describe('角色定义清晰度(0-1)'),
    objective_specificity: z.number().min(0).max(1).describe('目标明确性(0-1)'),
    instruction_coherence: z.number().min(0).max(1).describe('指令一致性(0-1)'),
    context_relevance: z.number().min(0).max(1).describe('上下文相关性(0-1)'),
  }),
  garbage_indicators: z.object({
    ambiguous_terms: z.array(z.string()).describe('模糊术语列表'),
    conflicting_directives: z.array(z.string()).describe('冲突指令列表'),
    missing_context: z.array(z.string()).describe('缺失上下文列表'),
  }),
  garbage_score: z.number().min(0).max(1).describe('垃圾得分(0-1)'),
  gold_potential: z.number().min(0).max(1).describe('黄金潜力(0-1)'),
});

/**
 * CoT 包装 - 添加推理结构
 *
 * @example
 * ```typescript
 * const userSchema = z.object({ emotion: z.string() });
 * const cotSchema = wrapWithCoT(userSchema);
 * // => z.object({ reasoning, scratchpad, result: userSchema })
 * ```
 */
export function wrapWithCoT<T extends z.ZodType>(userSchema: T) {
  return z.object({
    reasoning: z.string().describe('推理过程和思维链'),
    scratchpad: z.string().describe('草稿和计算过程'),
    result: userSchema,
  });
}

/**
 * Debug 包装 - 添加分析结构（包含 CoT）
 *
 * @example
 * ```typescript
 * const userSchema = z.object({ emotion: z.string() });
 * const debugSchema = wrapWithDebug(userSchema);
 * // => z.object({ reasoning, scratchpad, result, confidence, gigo_analysis })
 * ```
 */
export function wrapWithDebug<T extends z.ZodType>(userSchema: T) {
  return z.object({
    reasoning: z.string().describe('推理过程和思维链'),
    scratchpad: z.string().describe('草稿和计算过程'),
    result: userSchema,
    overall_confidence: z.number().min(0).max(1).describe('总体置信度(0-1)'),
    module_confidence: ModuleConfidenceSchema,
    gigo_analysis: GigoAnalysisSchema,
  });
}

// ==================== Prompt Class ====================

/**
 * 不可变的 Prompt 数据类
 *
 * 通过 PromptBuilder 构建，支持 withCoT() / withDebug() 增强
 */
export class Prompt {
  readonly id: string;
  readonly version: string;
  readonly data: PromptData;
  private readonly enhancements: Set<'cot' | 'debug'>;

  constructor(id: string, version: string, data: PromptData, enhancements?: ('cot' | 'debug')[]) {
    this.id = id;
    this.version = version;
    this.data = structuredClone(data);
    this.enhancements = new Set(enhancements ?? []);
  }

  /**
   * 添加 CoT 增强，返回新实例
   *
   * 在 prompt 中添加推理结构指令，引导 LLM 输出思维链
   */
  withCoT(): Prompt {
    const newEnhancements = new Set(this.enhancements);
    newEnhancements.add('cot');
    return new Prompt(this.id, this.version, this.data, [...newEnhancements]);
  }

  /**
   * 添加 Debug 增强（包含 CoT），返回新实例
   *
   * 在 prompt 中添加自我评估指令，引导 LLM 输出置信度和 GIGO 分析
   */
  withDebug(): Prompt {
    const newEnhancements = new Set(this.enhancements);
    newEnhancements.add('cot');
    newEnhancements.add('debug');
    return new Prompt(this.id, this.version, this.data, [...newEnhancements]);
  }

  /**
   * 渲染为最终 prompt 字符串
   */
  render(options: RenderOptions = {}): string {
    const { timezone, sensitivity = TimeSensitivity.Minute } = options;

    // Generate XML content
    const xmlContent = generateXmlPromptContent(this.data);

    // Add enhancement instructions
    const enhancementParts: string[] = [];
    if (this.enhancements.has('cot')) {
      enhancementParts.push(COT_INSTRUCTION);
    }
    if (this.enhancements.has('debug')) {
      enhancementParts.push(DEBUG_INSTRUCTION);
    }

    const enhancementsSection = enhancementParts.length > 0 ? '\n\n' + enhancementParts.join('\n\n') : '';

    // Format timestamp
    const base = new Date();
    const normalizedTimezone = normalizeTimezone(timezone);
    const timestamp = normalizedTimezone
      ? formatInTimeZone(base, normalizedTimezone, sensitivity)
      : format(base, sensitivity);

    return `[${this.id}:${this.version}]
------
${xmlContent}${enhancementsSection}
------
When responding, always consider all context items, and always prioritize higher-priority items first: critical > high > medium > low.
Now:${timestamp}`;
  }

  hasCoT(): boolean {
    return this.enhancements.has('cot');
  }

  hasDebug(): boolean {
    return this.enhancements.has('debug');
  }
}

// ==================== PromptBuilder ====================

/**
 * Prompt 构建器 - 链式 API
 *
 * @example
 * ```typescript
 * const prompt = new PromptBuilder('analyzer', '1.0')
 *   .role('情感分析专家')
 *   .objective('分析用户情感')
 *   .instruction('识别主要情感')
 *   .build();
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
  private _language?: string;

  constructor(id: string, version: string = '1.0') {
    this._id = id;
    this._version = version;
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
      language: this._language,
    };

    return new Prompt(this._id, this._version, data);
  }
}

// ==================== XML Generation ====================

function generateXmlPromptContent(data: PromptData): string {
  // Role, Objective, Writing Style, Emotional Tone, Target Audience
  const rolePart = data.role ? `<role priority="critical">${data.role}</role>` : undefined;
  const objectivePart = data.objective ? `<objective priority="critical">${data.objective}</objective>` : undefined;
  const stylePart = data.style ? `<style>${data.style}</style>` : undefined;
  const tonePart = data.tone ? `<tone>${data.tone}</tone>` : undefined;
  const audiencePart = data.audience ? `<audience>${data.audience}</audience>` : undefined;

  // Instructions
  const instructionsPart = data.instructions.length
    ? `<instructions priority="high">\n${data.instructions
        .map((instruction) =>
          instruction
            .split('\n')
            .map((line) => `  ${line}`)
            .join('\n'),
        )
        .join('\n\n')}\n</instructions>`
    : undefined;

  // Rules
  const rulesPart = data.rules.length ? `<rules priority="critical">\n${data.rules.join('\n')}\n</rules>` : undefined;

  // Examples
  const examplesPart = data.examples.length
    ? `<examples strict="For inspiration only, not to be used as output or reference">\n${data.examples
        .map((example) => {
          const title = example.title ? ` title="${example.title}"` : '';
          return `  <example${title}>\n    <content>${example.content}</content>\n  </example>`;
        })
        .join('\n')}\n</examples>`
    : undefined;

  // Context
  const contextPart = data.sections.length
    ? `<context>\n${data.sections
        .map((section) => {
          const content = section.content ?? '<empty />';
          const priority = section.priority ? ` priority="${section.priority}"` : '';
          const purpose = section.purpose ? ` purpose="${section.purpose}"` : '';
          return `  <section name="${section.title}"${priority}${purpose}>${content}</section>`;
        })
        .join('\n')}\n</context>`
    : undefined;

  // Metadata section
  const metadataParts = [rolePart, objectivePart, stylePart, tonePart, audiencePart].filter(Boolean);
  const metadataSection = metadataParts.length > 0 ? metadataParts.join('\n') : undefined;

  // Language
  const languagePart = data.language
    ? `<language priority="critical">Use "${data.language}" as the default response language. Switch to another language if the user explicitly requests it.</language>`
    : undefined;

  return [metadataSection, instructionsPart, rulesPart, examplesPart, contextPart, languagePart]
    .filter(Boolean)
    .join('\n\n');
}

// ==================== Re-exports ====================

export { TimeSensitivity };
