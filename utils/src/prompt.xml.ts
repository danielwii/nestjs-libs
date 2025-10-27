/**
 * ===============================
 * XML-based Prompt System V2
 * ===============================
 *
 * 基于XML结构的第二代Prompt系统，提供更清晰的层级关系和结构化输出支持。
 *
 * ## 核心特性
 * - 🔧 基于XML的清晰层级结构
 * - 🎯 遵循S.T.A框架设计原则（Style、Tone、Audience）
 * - 🔄 支持字符串和结构化输出
 * - 🧠 集成Chain-of-Thought和GIGO分析
 * - 🌐 支持多语言和时区
 * - 📊 支持debug模式和置信度评估
 *
 * ## 快速开始
 * ```typescript
 * const builder = new PromptSpec('chat-assistant', {
 *   role: 'AI助手',
 *   objective: '提供有帮助的回答',
 *   style: '友好专业',
 *   tone: '温和耐心',
 *   audience: '一般用户'
 * }, {
 *   version: '0.1',
 * });
 *
 * const prompt = builder.build();
 * ```
 *
 * @author SoulMirror Team
 * @version 2.0.0
 * @since 2024-01-01
 */
import { stripIndent } from 'common-tags';
import { format } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { DateTime } from 'luxon';
import _ from 'lodash';
import z from 'zod';

import { TimeSensitivity } from './prompt';

/**
 * 简化的XML版本的Prompt Schema
 *
 * 设计理念：
 * 1. 使用XML结构提供更清晰的层级关系
 * 2. 简化结构，专注核心功能
 * 3. 支持字符串和结构化输出
 * 4. 遵循S.T.A框架设计原则：
 *    - Style(风格)：明确期望的写作风格，可指定特定人物或专家风格
 *    - Tone(语气)：设置情感调，确保回应与预期情绪背景协调
 *    - Audience(受众)：识别目标受众，针对特定群体定制内容
 *
 * @example
 * ```typescript
 * const schema: XmlPromptSchema = {
 *   role: 'AI助手',
 *   objective: '回答用户问题',
 *   style: '专业友好',
 *   tone: '温和耐心',
 *   audience: '一般用户',
 *   instructions: ['保持简洁', '提供准确信息'],
 *   language: 'zh-CN'
 * };
 * ```
 */
const XmlPromptSchema = z.object({
  /** 角色定义 - 描述AI扮演的角色身份 */
  role: z.string(),
  /** 任务目标 - 明确要完成的具体任务 */
  objective: z.string(),
  /** S-风格：明确期望的写作风格，可指定特定著名人物或行业专家的风格（如商业分析师、CEO等），指导LLM的表达方式和词汇选择 */
  style: z.string().optional(),
  /** T-语气：设置回应的情感调，确保LLM回应与预期情感背景协调，如正式、幽默、富有同情心等 */
  tone: z.string().optional(),
  /** A-受众：识别目标受众，针对特定群体定制回应（专家、初学者、儿童等），确保内容适当且易理解 */
  audience: z.string().optional(),
  /** 上下文信息 - 提供任务相关的背景信息和数据 */
  context: z
    .array(
      z.object({
        /** 上下文标题 */
        title: z.string(),
        /** 上下文内容 */
        content: z.union([z.string(), z.number()]).optional(),
        /** 优先级 - 如'high', 'medium', 'low' */
        priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
        /** 目的 - 说明该上下文的作用 */
        purpose: z.string().optional(),
      }),
    )
    .optional(),
  /** 指令列表 - 具体的执行指令 */
  instructions: z.array(z.string()).optional(),
  /** 规则列表 - 必须遵守的约束条件 */
  rules: z.array(z.string()).optional(),
  /** 示例列表 - 提供参考示例 */
  examples: z
    .array(
      z.object({
        /** 示例标题 */
        title: z.string().optional(),
        /** 示例内容 */
        content: z.string(),
      }),
    )
    .optional(),
  /** 输出格式配置 */
  output: z
    .union([
      z.literal('string'), // 字符串输出
      z.object({
        /** 输出类型 */
        type: z.enum(['schema', 'string']),
        /** 用户期望的结果schema */
        // schema: z.any(),
        /** 是否使用思维链，默认true */
        useCoT: z.boolean().optional(),
        /** 是否使用debug模式，默认false */
        debug: z.boolean().optional(),
      }),
    ])
    .optional(),
  /** 主要回复语言 */
  language: z.string().optional(),
});

export type PromptSpecSchema = z.infer<typeof XmlPromptSchema>;
export type PromptSpecContextItem = NonNullable<z.infer<typeof XmlPromptSchema>['context']>[number];

export interface PromptBlueprint<T extends z.ZodSchema = z.ZodSchema> {
  id: string;
  version: string;
  role: string;
  objective: string;
  style?: string;
  tone?: string;
  audience?: string;
  instructions: string[];
  rules: string[];
  examples: Array<{ title?: string; content: string }>;
  sections: PromptSpecContextItem[];
  output?: PromptSpecSchema['output'];
  language?: string;
  schema?: T;
  llmOptions?: LLMOptions;
  includeOutputInPrompt: boolean;
  sensitivity: TimeSensitivity;
  timezone?: string | null;
}

export class PromptSpecBuilder<T extends z.ZodSchema = z.ZodSchema> {
  private blueprint: PromptBlueprint<T>;

  constructor(id: string, version: string) {
    this.blueprint = {
      id,
      version,
      role: '',
      objective: '',
      instructions: [],
      rules: [],
      examples: [],
      sections: [],
      includeOutputInPrompt: true,
      sensitivity: TimeSensitivity.Minute,
      timezone: null,
    };
  }

  setRole(role: string): this {
    this.blueprint.role = role;
    return this;
  }

  setObjective(objective: string): this {
    this.blueprint.objective = objective;
    return this;
  }

  setStyle(style?: string): this {
    this.blueprint.style = style;
    return this;
  }

  setTone(tone?: string): this {
    this.blueprint.tone = tone;
    return this;
  }

  setAudience(audience?: string): this {
    this.blueprint.audience = audience;
    return this;
  }

  addInstruction(instruction: string): this {
    if (instruction) {
      this.blueprint.instructions.push(instruction);
    }
    return this;
  }

  addInstructions(instructions: string[] | undefined | null): this {
    instructions?.forEach((instruction) => this.addInstruction(instruction));
    return this;
  }

  addRule(rule: string): this {
    if (rule) {
      this.blueprint.rules.push(rule);
    }
    return this;
  }

  addRules(rules: string[] | undefined | null): this {
    rules?.forEach((rule) => this.addRule(rule));
    return this;
  }

  addExample(example: { title?: string; content: string }): this {
    if (example?.content) {
      this.blueprint.examples.push({ ...example });
    }
    return this;
  }

  addExamples(examples: PromptBlueprint['examples'] | undefined | null): this {
    examples?.forEach((example) => this.addExample(example));
    return this;
  }

  addSection(section: PromptSpecContextItem): this {
    if (section) {
      this.blueprint.sections.push({ ...section });
    }
    return this;
  }

  addSections(sections: PromptSpecContextItem[] | undefined | null): this {
    sections?.forEach((section) => this.addSection(section));
    return this;
  }

  applySchema(schema: (PromptSpecSchema & { schema?: T }) | undefined | null): this {
    if (!schema) return this;

    // 允许一次性注入现有 schema，再按需补充/覆盖，方便业务层迁移旧逻辑。
    this.setRole(schema.role);
    this.setObjective(schema.objective);
    this.setStyle(schema.style);
    this.setTone(schema.tone);
    this.setAudience(schema.audience);

    this.blueprint.instructions = [];
    this.addInstructions(schema.instructions);

    this.blueprint.rules = [];
    this.addRules(schema.rules);

    this.blueprint.examples = [];
    this.addExamples(schema.examples);

    this.blueprint.sections = [];
    this.addSections(schema.context);

    this.setOutput(schema.output);
    this.setLanguage(schema.language);
    this.setSchema(schema.schema);

    return this;
  }

  setOutput(output?: PromptSpecSchema['output']): this {
    this.blueprint.output = output;
    return this;
  }

  setLanguage(language?: string): this {
    this.blueprint.language = language;
    return this;
  }

  setSchema(schema?: T): this {
    this.blueprint.schema = schema;
    return this;
  }

  setLLMOptions(options?: LLMOptions): this {
    this.blueprint.llmOptions = options;
    return this;
  }

  setIncludeOutputInPrompt(include: boolean): this {
    this.blueprint.includeOutputInPrompt = include;
    return this;
  }

  setSensitivity(sensitivity: TimeSensitivity): this {
    this.blueprint.sensitivity = sensitivity;
    return this;
  }

  setTimezone(timezone: string | null | undefined): this {
    this.blueprint.timezone = timezone ?? null;
    return this;
  }

  build(): PromptBlueprint<T> {
    if (!this.blueprint.role) {
      throw new Error('PromptSpecBuilder: role is required');
    }
    if (!this.blueprint.objective) {
      throw new Error('PromptSpecBuilder: objective is required');
    }

    return {
      ...this.blueprint,
      instructions: [...this.blueprint.instructions],
      rules: [...this.blueprint.rules],
      examples: this.blueprint.examples.map((example) => ({ ...example })),
      sections: this.blueprint.sections.map((section) => _.cloneDeep(section)),
    };
  }

  buildPromptSpec(additionalOptions?: Partial<PromptSpecOptions>): PromptSpec<T> {
    const blueprint = this.build();
    const data: PromptSpecSchema & { schema?: T } = {
      role: blueprint.role,
      objective: blueprint.objective,
      ...(blueprint.style ? { style: blueprint.style } : {}),
      ...(blueprint.tone ? { tone: blueprint.tone } : {}),
      ...(blueprint.audience ? { audience: blueprint.audience } : {}),
      instructions: blueprint.instructions.length ? [...blueprint.instructions] : undefined,
      rules: blueprint.rules.length ? [...blueprint.rules] : undefined,
      examples: blueprint.examples.length ? blueprint.examples.map((example) => ({ ...example })) : undefined,
      context: blueprint.sections.length ? blueprint.sections.map((section) => _.cloneDeep(section)) : undefined,
      output: blueprint.output,
      language: blueprint.language,
      schema: blueprint.schema,
    };

    const options: PromptSpecOptions = {
      version: blueprint.version,
      tz: blueprint.timezone ?? undefined,
      sensitivity: blueprint.sensitivity,
      llmOptions: blueprint.llmOptions,
      ...additionalOptions,
    } as PromptSpecOptions;

    return new PromptSpec<T>(blueprint.id, data, options);
  }
}

export class PromptSerializer {
  static toXml<T extends z.ZodSchema = z.ZodSchema>(
    blueprint: PromptBlueprint<T>,
    options: { timezone?: string | null; sensitivity: TimeSensitivity; includeOutputInPrompt: boolean },
  ): string {
    const promptData: PromptSpecSchema & { schema?: T } = {
      role: blueprint.role,
      objective: blueprint.objective,
      ...(blueprint.style ? { style: blueprint.style } : {}),
      ...(blueprint.tone ? { tone: blueprint.tone } : {}),
      ...(blueprint.audience ? { audience: blueprint.audience } : {}),
      instructions: blueprint.instructions.length ? blueprint.instructions : undefined,
      rules: blueprint.rules.length ? blueprint.rules : undefined,
      examples: blueprint.examples.length ? blueprint.examples : undefined,
      context: blueprint.sections.length ? blueprint.sections : undefined,
      output: blueprint.output,
      language: blueprint.language,
      schema: blueprint.schema,
    };

    if (!options.includeOutputInPrompt) {
      delete promptData.output;
    }

    // Use Jest/Vitest fake timers if present by relying on new Date().
    const base = new Date();
    // Respect requested timezone using date-fns-tz to avoid host TZ leakage.
    const timestamp = options.timezone
      ? formatInTimeZone(base, options.timezone, options.sensitivity)
      : format(base, options.sensitivity);

    const xmlContent = generateXmlPromptContent(promptData);

    return `[${blueprint.id}:${blueprint.version}]
------
${xmlContent}
------
When responding, always consider all context items, and always prioritize higher-priority items first: critical > high > medium > low.
Now:${timestamp}`;
  }
}

/**
 * 默认的Chain-of-Thought & Scratchpad Schema
 *
 * 用于结构化输出时的思维链草稿，提供推理过程的透明度。
 *
 * Debug模式下会额外包含GIGO分析：
 * - 基于"Garbage In, Garbage Out"原则分析prompt输入质量
 * - 预测输出质量并识别潜在问题
 * - 提供具体的改进建议和质量评估
 * - 帮助优化prompt设计，减少低质量输出
 *
 * @param userSchema - 用户期望的输出schema
 * @param debug - 是否启用debug模式，包含GIGO分析
 * @returns 包含思维链和用户schema的完整schema字符串
 *
 * @example
 * ```typescript
 * const schema = defaultCoTSchema(z.object({ answer: z.string() }), true);
 * console.log(schema); // 输出包含reasoning, scratchpad, result等字段的JSON schema
 * ```
 */
const defaultCoTSchema = (userSchema: z.ZodSchema, debug: boolean = false) =>
  _.compact([
    stripIndent`
  {
    "reasoning": "string", // 推理过程和思维链
    "scratchpad": "string", // 草稿和计算过程
    "result": ${JSON.stringify(z.toJSONSchema(userSchema))}, // 用户期望的实际结果
    `,
    debug &&
      stripIndent`
    "module_confidence": {
      "role": "number", // 角色定义执行置信度(0-1)，评估是否准确理解并执行了角色设定
      "objective"?: "number", // 任务目标达成置信度(0-1)，评估是否有效完成了设定的任务目标
      "style"?: "number", // 写作风格匹配置信度(0-1)，评估是否符合指定的写作风格要求
      "tone"?: "number", // 情感语调把握置信度(0-1)，评估是否准确把握了情感语调
      "audience"?: "number", // 目标受众适配置信度(0-1)，评估是否针对目标受众进行了合适的内容定制
      "instructions"?: "number", // 指令遵循置信度(0-1)，评估是否准确遵循了给定的指令
      "rules"?: "number", // 规则遵守置信度(0-1)，评估是否严格遵守了设定的规则
      "context"?: "number", // 上下文理解置信度(0-1)，评估是否准确理解并利用了上下文信息
      "examples_style_matching"?: "number", // 示例风格匹配置信度(0-1)，评估是否准确匹配了示例的风格、语调和策略
      "examples_content_independence"?: "number" // 示例内容独立性置信度(0-1)，评估是否在遵循示例风格的基础上展现了适当的原创性和情境适配性，避免过度复制示例内容
    },`,
    `"overall_confidence": "number", // 总体置信度(0-1)，综合各模块表现的整体评估。系统级动态评估：高置信度(0.85-0.95)适用于简单明确场景；中等置信度(0.65-0.84)适用于复杂情感处理或敏感话题；低置信度(0.45-0.64)适用于重大决策建议或专业领域问题。根据场景复杂度、情感敏感度、回复适配度动态调整，严禁使用固定值`,
    debug &&
      stripIndent`
      "gigo_analysis": {
      "input_quality_assessment": {
        "role_clarity": "number", // 角色定义清晰度(0-1)，评估角色描述是否明确、具体、可操作
        "objective_specificity": "number", // 目标明确性(0-1)，评估任务目标是否具体、可测量、可达成
        "instruction_coherence": "number", // 指令一致性(0-1)，评估指令间是否逻辑一致、无冲突
        "context_relevance": "number", // 上下文相关性(0-1)，评估提供的上下文是否与任务目标相关且充分
        "example_quality": "number", // 示例质量(0-1)，评估示例是否恰当、多样、有代表性
        "constraints_completeness": "number", // 约束完整性(0-1)，评估规则和约束是否完整、明确
        "language_precision": "number", // 语言精确性(0-1)，评估用词是否准确、避免歧义
        "complexity_appropriateness": "number" // 复杂度适宜性(0-1)，评估prompt复杂度是否与任务匹配
      },
      "garbage_indicators": {
        "ambiguous_terms": ["string"], // 模糊术语列表，识别可能导致误解的词汇或短语
        "conflicting_directives": ["string"], // 冲突指令列表，识别相互矛盾的要求或指导
        "missing_context": ["string"], // 缺失上下文列表，识别完成任务所需但未提供的关键信息
        "vague_expectations": ["string"], // 模糊期望列表，识别不够具体或难以量化的期望
        "scope_creep_risks": ["string"], // 范围蔓延风险列表，识别可能导致任务范围扩大的模糊描述
        "assumption_gaps": ["string"], // 假设缺口列表，识别prompt中隐含但未明确的假设
        "inconsistent_tone": ["string"], // 语调不一致列表，识别风格和语调要求间的冲突
        "overloaded_instructions": ["string"] // 指令过载列表，识别过于复杂或冗长的指令
      },
      "quality_prediction": {
        "expected_accuracy": "number", // 预期准确性(0-1)，基于输入质量预测输出准确性
        "expected_relevance": "number", // 预期相关性(0-1)，基于输入质量预测输出相关性  
        "expected_consistency": "number", // 预期一致性(0-1)，基于输入质量预测输出一致性
        "expected_completeness": "number", // 预期完整性(0-1)，基于输入质量预测输出完整性
        "risk_of_hallucination": "number", // 幻觉风险(0-1)，基于输入不足预测产生幻觉的可能性
        "risk_of_misinterpretation": "number", // 误解风险(0-1)，基于输入歧义预测误解的可能性
        "output_stability": "number" // 输出稳定性(0-1)，预测相同输入下输出的一致性
      },
      "improvement_recommendations": {
        "critical_fixes": ["string"], // 关键修复建议，必须解决的问题以避免低质量输出
        "enhancement_suggestions": ["string"], // 增强建议，可以提升输出质量的改进点
        "clarity_improvements": ["string"], // 清晰度改进，让prompt更明确的建议
        "context_enrichment": ["string"], // 上下文丰富化，补充有用上下文的建议
        "constraint_optimization": ["string"], // 约束优化，改进规则和约束的建议
        "structure_refinement": ["string"], // 结构优化，改进prompt组织结构的建议
        "validation_checkpoints": ["string"] // 验证检查点，建议加入的质量验证步骤
      },
      "garbage_score": "number", // 垃圾得分(0-1)，综合评估输入质量，0表示高质量，1表示低质量
      "gold_potential": "number" // 黄金潜力(0-1)，评估经过改进后可达到的最高质量潜力
    },`,
    debug &&
      stripIndent`
      "prompt_analysis": {
      "conflicts": ["string"], // prompt模块间冲突识别，列出发现的冲突点，如"style要求正式，但tone要求口语化"
      "improvements": ["string"], // 基于 objective 列出 prompt 的改进建议，列出具体的优化建议，如"建议在instructions中增加更明确的边界说明"
      "clarity_issues": ["string"], // prompt 中清晰度问题，指出模糊或不够明确的部分，如"audience定义过于宽泛"
      "missing_elements": ["string"] // 为了完成 objective 指出缺失要素，指出可能需要补充的内容，如"缺少错误处理指导"
    }`,
  ])
    .filter(Boolean)
    .join('\n');

/**
 * 生成XML格式的Prompt内容
 *
 * 将结构化的prompt数据转换为XML格式的字符串，
 * 支持角色、目标、风格、语气、受众等多种元素。
 *
 * @param data - XML Prompt数据对象
 * @returns XML格式的prompt字符串
 *
 * @example
 * ```typescript
 * const xmlContent = generateXmlPromptContent({
 *   role: 'AI助手',
 *   objective: '回答问题',
 *   style: '专业',
 *   instructions: ['保持简洁']
 * });
 * // 输出: <role>AI助手</role>\n<objective>回答问题</objective>...
 * ```
 */
function generateXmlPromptContent(data: PromptSpecSchema & { schema?: z.ZodSchema }): string {
  // Role, Objective, Writing Style, Emotional Tone, Target Audience (可选)
  const rolePart = data.role ? `<role priority="critical">${data.role}</role>` : undefined;
  const objectivePart = data.objective ? `<objective priority="critical">${data.objective}</objective>` : undefined;
  const stylePart = data.style ? `<style>${data.style}</style>` : undefined;
  const tonePart = data.tone ? `<tone>${data.tone}</tone>` : undefined;
  const audiencePart = data.audience ? `<audience>${data.audience}</audience>` : undefined;

  // Instructions (可选)
  const instructionsPart = data.instructions?.length
    ? `<instructions priority="high">\n${data.instructions
        .map((instruction) =>
          instruction
            .split('\n')
            .map((line) => `  ${line}`)
            .join('\n'),
        )
        .join('\n\n')}\n</instructions>`
    : undefined;

  // Rules (可选)
  const rulesPart = data.rules?.length ? `<rules priority="critical">\n${data.rules.join('\n')}\n</rules>` : undefined;

  // Examples (可选)
  const examplesPart = data.examples?.length
    ? `<examples strict="For inspiration only, not to be used as output or reference">\n${data.examples
        .map((example) => {
          const title = example.title ? ` title="${example.title}"` : '';
          return `  <example${title}>\n    <content>${example.content}</content>\n  </example>`;
        })
        .join('\n')}\n</examples>`
    : undefined;

  // Context (可选)
  const contextPart = data.context?.length
    ? `<context>\n${data.context
        .map((section) => {
          const content = section.content || '<empty />';
          const priority = section.priority ? ` priority="${section.priority}"` : '';
          const purpose = section.purpose ? ` purpose="${section.purpose}"` : '';
          return `  <section name="${section.title}"${priority}${purpose}>${content}</section>`;
        })
        .join('\n')}\n</context>`
    : undefined;

  // Output (可选)
  const outputPart = (() => {
    if (!data.output) {
      return undefined;
    }

    // 简单字符串输出
    if (data.output === 'string') {
      return `<output>Please reply in natural language, no specific format required.</output>`;
    }

    // 结构化配置 —— type:string
    if (data.output.type === 'string') {
      const schema = JSON.stringify(z.toJSONSchema(data.schema ?? z.string()));

      if (data.output.useCoT === true) {
        const cotSchema = defaultCoTSchema(data.schema ?? z.string(), data.output.debug ?? false);
        return `<output>\n  <format>Strictly output a single JSON object that includes reasoning fields and a final string result as described by the schema below. Do not include any additional commentary.</format>\n  <schema>\n${cotSchema}\n  </schema>\n</output>`;
      }

      return `<output>\n  <format>Strictly output a JSON string that conforms to the schema below (no additional characters or commentary).</format>\n  <schema>\n${schema}\n  </schema>\n</output>`;
    }

    // 结构化配置 —— type:schema
    if (data.output.type === 'schema') {
      const schemaBody =
        data.output.useCoT === true
          ? defaultCoTSchema(data.schema ?? z.string(), data.output.debug ?? false)
          : JSON.stringify(z.toJSONSchema(data.schema ?? z.string()));

      const formatHint =
        data.output.useCoT === true
          ? 'Strictly output a single JSON object with reasoning fields that conforms to the schema below. Do not include any additional commentary.'
          : 'Strictly output a single JSON object that conforms to the schema below. Do not include any additional commentary.';

      return `<output>\n  <format>${formatHint}</format>\n  <schema>\n${schemaBody}\n  </schema>\n</output>`;
    }

    return undefined;
  })();

  // 组合所有元数据标签
  const metadataParts = _.compact([rolePart, objectivePart, stylePart, tonePart, audiencePart]);
  const metadataSection = metadataParts.length > 0 ? metadataParts.join('\n') : undefined;

  const languagePart = data.language
    ? `<language priority="critical">Use "${data.language}" as the main response language.</language>`
    : undefined;

  return _.compact([
    metadataSection,
    instructionsPart,
    rulesPart,
    examplesPart,
    contextPart,
    outputPart,
    languagePart,
  ]).join('\n\n');
}

/**
 * LLM选项类型
 *
 * 定义与Language Model相关的配置选项
 */
export interface LLMOptions {
  /** 模型名称，如'gpt-4', 'claude-3-sonnet' */
  model: string;
  /** 温度参数，控制输出的随机性 (0-2) */
  temperature: number;
  /** 最大输出token数 */
  maxOutputTokens: number;
  /** 推理选项配置（用于启用 reasoning 功能） */
  reasoning?: {
    effort?: 'low' | 'medium' | 'high';
    maxTokens?: number;
    exclude?: boolean;
    enabled?: boolean;
  };
}

/**
 * Prompt构建器选项类型
 *
 * 定义创建PromptSpec实例时的配置选项
 */
export interface PromptSpecOptions {
  /** 版本号，用于标识prompt模板版本 */
  version: string;
  /** 时区设置，用于生成时间戳 */
  tz?: string | null;
  /** 时间敏感度级别 */
  sensitivity?: TimeSensitivity;
  /** LLM相关配置选项 */
  llmOptions?: LLMOptions;
  /** 扩展配置选项 */
  extra?: {
    /** 是否包含系统prompt */
    includeSystemPrompt?: boolean;
    /** 自定义系统prompt */
    systemPrompt?: string;
  } & Record<string, any>;
}

/**
 * Prompt构建器类
 *
 * 提供链式调用的方式构建结构化的XML格式prompt，
 * 支持角色定义、任务目标、风格设置、上下文注入等功能。
 *
 * 设计理念：
 * 1. 保持原有ID格式，不使用XML外层包装
 * 2. 支持选择性输出schema，兼容OpenAI API直接传schema
 */
export class PromptSpec<T extends z.ZodSchema = z.ZodSchema> {
  readonly id: string;
  readonly version: string;
  readonly timezone: string | undefined | null;
  readonly sensitivity: TimeSensitivity;
  readonly data: PromptSpecSchema & { schema?: T };
  readonly includeOutputInPrompt: boolean = true;
  readonly llmOptions?: LLMOptions;
  private readonly blueprint: PromptBlueprint<T>;

  /**
   * 创建PromptSpec实例
   *
   * @param id - Prompt的唯一标识符
   * @param data - 初始的prompt数据
   * @param options - 构建器配置选项
   *
   * @example
   * ```typescript
   * const builder = new PromptSpec('my-prompt', {
   *   role: 'AI助手',
   *   objective: '回答问题'
   * }, {
   *   version: '1',
   * });
   * ```
   */
  constructor(id: string, data: PromptSpecSchema & { schema?: T }, options: PromptSpecOptions = { version: '1' }) {
    this.id = id;
    this.version = options.version;
    this.timezone = options.tz;
    this.sensitivity = options.sensitivity ?? TimeSensitivity.Minute;
    this.data = data;
    this.llmOptions = options.llmOptions;

    const builder = new PromptSpecBuilder<T>(id, this.version)
      .setRole(data.role)
      .setObjective(data.objective)
      .setStyle(data.style)
      .setTone(data.tone)
      .setAudience(data.audience)
      .addInstructions(data.instructions)
      .addRules(data.rules)
      .addExamples(data.examples)
      .addSections(data.context)
      .setOutput(data.output)
      .setLanguage(data.language)
      .setSchema(data.schema)
      .setLLMOptions(options.llmOptions)
      .setIncludeOutputInPrompt(this.includeOutputInPrompt)
      .setSensitivity(this.sensitivity)
      .setTimezone(this.timezone ?? null);

    this.blueprint = builder.build();
  }

  /**
   * 生成完整的prompt内容
   *
   * 将所有设置的数据组合成最终的XML格式prompt字符串，
   * 包含ID、版本、时间戳等信息。
   *
   * @returns 完整的prompt字符串
   *
   * @example
   * ```typescript
   * const prompt = builder.build();
   * // 输出：[my-prompt:1.0.0]
   * // ------
   * // <role>AI助手</role>
   * // <objective>回答问题</objective>
   * // ...
   * // ------
   * // Now:2024-01-01 10:00:00
   * ```
   */
  build(): string {
    return PromptSerializer.toXml(this.blueprint, {
      timezone: this.timezone ?? null,
      sensitivity: this.sensitivity,
      includeOutputInPrompt: this.includeOutputInPrompt,
    });
  }

  /**
   * 获取输出schema（如果有的话）
   *
   * 用于OpenAI API直接传schema的场景，返回可以直接传递给API的schema字符串
   *
   * @returns schema字符串，如果没有配置schema则返回null
   *
   * @example
   * ```typescript
   * const schema = builder.getOutputSchema();
   * if (schema) {
   *   // 传递给OpenAI API
   *   const response = await openai.chat.completions.create({
   *     model: 'gpt-4',
   *     messages: [{ role: 'user', content: prompt }],
   *     response_format: { type: 'json_object', schema: JSON.parse(schema) }
   *   });
   * }
   * ```
   */
  getOutputSchema(): string | null {
    const output = this.blueprint.output;
    if (!output || output === 'string') {
      return null;
    }

    if (output.type === 'schema') {
      try {
        const schema =
          output.useCoT === true
            ? defaultCoTSchema(this.blueprint.schema ?? z.string(), output.debug ?? false)
            : JSON.stringify(z.toJSONSchema(this.blueprint.schema ?? z.string()));

        // // 移除JSON字符串中的注释
        // const cleanSchema = schema
        //   .replace(/\/\/.*$/gm, '')
        //   .replace(/,\s*}/g, '}')
        //   .replace(/,\s*]/g, ']');

        return schema;
      } catch (error) {
        console.warn('Failed to parse output schema:', error);
        return null;
      }
    }

    return null;
  }

  /**
   * 获取输出格式类型
   *
   * @returns 输出格式类型，'string'表示字符串输出，'schema'表示结构化输出，null表示未配置
   *
   * @example
   * ```typescript
   * const type = builder.getOutputType();
   * if (type === 'schema') {
   *   // 处理结构化输出
   * }
   * ```
   */
  getOutputType(): 'string' | 'schema' | null {
    const output = this.blueprint.output;
    if (!output) return null;
    if (output === 'string') return 'string';
    if (output.type === 'schema') return 'schema';
    return null;
  }

  /**
   * 是否使用Chain-of-Thought
   *
   * @returns 如果配置了使用CoT则返回true，否则返回false
   *
   * @example
   * ```typescript
   * if (builder.isUsingCoT()) {
   *   console.log('将包含推理过程');
   * }
   * ```
   */
  isUsingCoT(): boolean {
    const output = this.blueprint.output;
    if (!output || output === 'string') return false;
    if (output.type === 'schema') {
      return output.useCoT ?? true;
    }
    return false;
  }

  /**
   * 获取原始prompt数据
   *
   * @returns 原始prompt数据的副本
   *
   * @example
   * ```typescript
   * const data = builder.getData();
   * console.log(data.role, data.objective);
   * ```
   */
  getData(): PromptSpecSchema {
    return { ...this.data };
  }

  toBlueprint(): PromptBlueprint<T> {
    return _.cloneDeep(this.blueprint);
  }

  /**
   * 从现有数据创建PromptSpec
   *
   * 静态工厂方法，用于从已有的数据创建新的PromptSpec实例
   *
   * @param id - Prompt的唯一标识符
   * @param data - 现有的prompt数据
   * @param options - 构建器配置选项
   * @returns 新的PromptSpec实例
   *
   * @example
   * ```typescript
   * const existingData = { role: 'AI助手', objective: '回答问题' };
   * const builder = PromptSpec.fromData('new-prompt', existingData, options);
   * ```
   */
  static fromData<T extends z.ZodSchema>(
    id: string,
    data: PromptSpecSchema,
    options: PromptSpecOptions,
  ): PromptSpec<T> {
    return new PromptSpec(id, data, options);
  }
}
