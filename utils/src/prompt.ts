import { stripIndent } from 'common-tags';
import * as Handlebars from 'handlebars';
import { format } from 'date-fns';
import { DateTime } from 'luxon';
import { z } from 'zod';
import _ from 'lodash';

export function generateJsonFormat(schema: z.ZodSchema, indent = 0): string {
  // 处理可选和可空类型
  const isOptional = schema instanceof z.ZodOptional;
  const isNullable = schema instanceof z.ZodNullable;
  const innerSchema = isOptional
    ? (schema._def as any).innerType
    : isNullable
      ? (schema._def as any).innerType
      : schema;

  // 获取基础类型的格式
  let format = '';

  // 处理基础类型
  if (innerSchema instanceof z.ZodString) format = '"string"';
  else if (innerSchema instanceof z.ZodNumber) format = 'number';
  else if (innerSchema instanceof z.ZodBoolean) format = 'boolean';
  // 处理数组
  else if (innerSchema instanceof z.ZodArray) {
    const innerFormat = generateJsonFormat(innerSchema._def.type, indent + 2);
    format = `Array<${innerFormat}>`;
  }
  // 处理枚举
  else if (innerSchema instanceof z.ZodEnum) {
    format = _.map((innerSchema._def as z.ZodEnumDef).values, (value) => `"${value}"`).join(' | ');
  } else if (innerSchema instanceof z.ZodNativeEnum) {
    format = _.map(_.keys((innerSchema._def as z.ZodNativeEnumDef).values), (value) => `"${value}"`).join(' | ');
  }
  // 处理对象
  else if (innerSchema instanceof z.ZodObject) {
    const shape = innerSchema._def.shape();
    const entries = Object.entries(shape);

    const lines = entries.map(([key, value]) => {
      const description = (value as any)._def.description;
      const type = generateJsonFormat(value as z.ZodSchema, indent + 2);
      const comment = description ? ` // ${description}` : '';
      return `${' '.repeat(indent + 2)}${key}: ${type}${comment}`;
    });

    format = `{\n${lines.join(',\n')}\n${' '.repeat(indent)}}`;
  } else {
    format = 'unknown';
  }

  // 添加可选和可空标记
  if (isNullable) format = `${format}|null`;
  if (isOptional) format = `${format}?`;

  return format;
}

export enum TimeSensitivity {
  Day = 'yyyy-MM-dd EEEE BBBB',
  Hour = 'yyyy-MM-dd EEEE hh a BBBB',
  Minute = 'yyyy-MM-dd EEEE HH:mm BBBB',
}

// 目的 (Objective/Purpose)
const ObjectiveSchema = z.string(); // 必须明确的任务目的

const SectionSchema = z.object({
  title: z.string(),
  content: z.union([z.string(), z.number()]).optional(),
});

// 上下文/背景知识 (Context/Background Information)
const ContextSchema = z.array(SectionSchema).optional(); // 可选的其他背景信息，如复杂的键值对结构

// 生成要求 (Requirements/Instructions)
const RequirementsSchema = z.union([z.string(), z.array(z.string())]);

// 注意事项 (Special Considerations)
const SpecialConsiderationsSchema = z.union([z.string(), z.array(z.string())]).optional();

// 完整的通用 prompt schema
const PromptSchema = z.object({
  purpose: ObjectiveSchema, // 任务目的
  background: z.string().optional(), // 描述背景设定
  context: ContextSchema, // 上下文/背景知识
  requirements: RequirementsSchema.optional(), // 生成要求
  specialConsiderations: SpecialConsiderationsSchema.optional(), // 注意事项
  examples: z.union([z.string(), z.array(z.string())]).optional(), // 示例
  output: z.string().optional(), // 输出
});
type PromptSchema = z.infer<typeof PromptSchema>;

Handlebars.registerHelper('isArray', (value) => Array.isArray(value));
Handlebars.registerHelper('isString', (value) => typeof value === 'string');

export function createBasePrompt(
  id: string,
  timezone: string | undefined | null,
  sensitivity: TimeSensitivity = TimeSensitivity.Minute,
  content: string,
  output?: string,
) {
  const datetime = timezone ? DateTime.now().setZone(timezone).toJSDate() : new Date();
  const now = format(datetime, sensitivity);
  return Handlebars.compile(stripIndent`
    [{{id}}]
    ------
    {{{content}}}
    ------
    Now:{{now}}
    {{#if output}}
    {{{output}}}
    {{/if}}
    Output:
  `)({ id, now, content, output });
}

export function createPrompt(
  id: string,
  timezone: string | undefined | null,
  sensitivity: TimeSensitivity = TimeSensitivity.Minute,
  data: PromptSchema,
) {
  return createBasePrompt(
    id,
    timezone,
    sensitivity,
    Handlebars.compile(stripIndent`
      ## Objective / Purpose
      {{{purpose}}}

      {{#if background}}
      ## Background Information
      {{{background}}}
      {{/if}}

      {{#if requirements}}
      ## Requirements / Instructions
      {{#if (isArray requirements)}}
      {{#each requirements}}
      {{#if (isString this)}}
      - {{{this}}}
      {{else}}
      - {{{this.[0]}}}
        {{#each this.[1]}}
        - {{{this}}}
        {{/each}}
      {{/if}}
      {{/each}}
      {{else}}
      {{{requirements}}}
      {{/if}}
      {{/if}}

      {{#if specialConsiderations}}
      ## Special Considerations
      {{#if (isArray specialConsiderations)}}
      {{#each specialConsiderations}}
      - {{{this}}}
      {{/each}}
      {{else}}
      {{{specialConsiderations}}}
      {{/if}}
      {{/if}}

      {{#if examples}}
      ## Examples
      {{#if (isArray examples)}}
      {{#each examples}}
      - {{{this}}}
      {{/each}}
      {{else}}
      {{{examples}}}
      {{/if}}
      {{/if}}

      {{#if context}}
      ## Context
      {{#each context}}
      <{{title}}>
      {{#if content}}
      {{{content}}}
      {{else}}
      <empty />
      {{/if}}
      </{{title}}>
      {{/each}}
      {{/if}}
    `)(data),
    data.output,
  );
}

export function createEnhancedPrompt<Response>({
  id,
  version,
  timezone,
  sensitivity,
  data,
  logicErrorContext,
}: {
  id: string;
  version: string;
  timezone?: string;
  sensitivity: TimeSensitivity;
  data: PromptSchema;
  logicErrorContext?: {
    condition?: (response: Response) => boolean;
    background?: string;
    output?: string;
    additionals?: { title: string; content: string }[];
  };
}) {
  const prompt = createPrompt(`${id}-${version}`, timezone ?? process.env.TZ, sensitivity, data);
  const logicErrorPromptCreator = logicErrorContext
    ? (response: Response) => {
        if (logicErrorContext.condition && !logicErrorContext.condition(response)) return null;

        return createPrompt(`LogicFixer-${id}`, timezone, sensitivity || TimeSensitivity.Minute, {
          purpose: '你是逻辑问题修复专家。请基于提供的背景信息，修复输入内容中的逻辑错误。',
          background: logicErrorContext.background,
          context: [...(logicErrorContext.additionals || []), { title: 'Input', content: JSON.stringify(response) }],
          requirements: [
            stripIndent`
              - 识别并修复输入内容中的逻辑错误
              - 确保修复后的输入内容逻辑正确且高效
              - 提供详细的修复说明，解释修复的原因和方法
            `,
          ],
          specialConsiderations: ['请确保修复后的输入内容逻辑清晰易懂。', '尽量少修改，只修改有问题的部分。'],
          output: logicErrorContext.output,
        });
      }
    : undefined;

  return { prompt, logicErrorPromptCreator, id, version };
}

export const customJsonFormatSupportOutput = (
  schema: z.ZodSchema,
  {
    injectJsonFormat,
    output,
  }: {
    injectJsonFormat?: boolean;
    output?: string;
  },
) =>
  _.compact([
    '严格输出符合 Schema 定义的 JSON 格式。枚举原样使用定义中的类型，不要翻译，不要输出任何其他内容，包括注释、解释、提示等。直接从 { 开始，到 } 结束, 不要输出任何其他内容。',
    injectJsonFormat
      ? `--- RESPONSE TypeScript Schema JSON FORMAT---\n${generateJsonFormat(schema)}\n--- END OF RESPONSE TYPE-SCRIPT SCHEMA JSON FORMAT ---`
      : '',
    output,
  ]).join('\n');
