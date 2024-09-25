import { stripIndent, stripIndents } from 'common-tags';
import * as Handlebars from 'handlebars';
import { format } from 'date-fns';
import { z } from 'zod';

export enum TimeSensitivity {
  Day = 'yyyy-MM-dd EEEE BBBB',
  Hour = 'yyyy-MM-dd EEEE hh a BBBB',
  Minute = 'yyyy-MM-dd EEEE hh:QQQQ a BBBB',
}

export function createPromptContext<Context>(
  id: string,
  context: Context,
  sensitivity: TimeSensitivity = TimeSensitivity.Minute,
) {
  return (prompt: string) =>
    Handlebars.compile(stripIndents`
      ID:{{id}} Now:{{now}}
      ------
      ${prompt}
    `)({ ...context, id, now: format(new Date(), sensitivity) });
}

// 目的 (Objective/Purpose)
const ObjectiveSchema = z.object({
  purpose: z.string(), // 必须明确的任务目的
});

const SectionSchema = z.object({
  title: z.string(),
  content: z.string().optional(),
});

// 上下文/背景知识 (Context/Background Information)
const ContextSchema = z.object({
  background: z.string().optional(), // 描述背景设定或上下文
  additionals: z.array(SectionSchema).optional(), // 可选的其他背景信息，如复杂的键值对结构
});

// 生成要求 (Requirements/Instructions)
const RequirementsSchema = z.union([z.string(), z.array(z.string())]);

// 注意事项 (Special Considerations)
const SpecialConsiderationsSchema = z.array(z.string()).optional();

// 完整的通用 prompt schema
const PromptSchema = z.object({
  objective: ObjectiveSchema, // 任务目的
  context: ContextSchema, // 上下文/背景知识
  requirements: RequirementsSchema.optional(), // 生成要求
  specialConsiderations: SpecialConsiderationsSchema.optional(), // 注意事项
  examples: z.string().optional(), // 示例
  output: z.string().optional(), // 输出
});
type PromptSchema = z.infer<typeof PromptSchema>;

Handlebars.registerHelper('isArray', (value) => Array.isArray(value));
Handlebars.registerHelper('isString', (value) => typeof value === 'string');

export function createBasePrompt(id: string, sensitivity: TimeSensitivity = TimeSensitivity.Minute, content: string) {
  const now = format(new Date(), sensitivity);
  return Handlebars.compile(stripIndent`
    ID:{{id}} Now:{{now}}
    ------
    {{{content}}}
  `)({ id, now, content });
}

export function createPrompt(id: string, sensitivity: TimeSensitivity = TimeSensitivity.Minute, data: PromptSchema) {
  return createBasePrompt(
    id,
    sensitivity,
    Handlebars.compile(stripIndent`
      ## Objective / Purpose
      {{{objective.purpose}}}

      ## Context / Background Information
      {{#if context.background}}
      {{{context.background}}}
      {{/if}}
      {{#each context.additionals}}
      <{{title}}>
      {{#if content}}
      {{{content}}}
      {{else}}
      <empty />
      {{/if}}
      </{{title}}>
      {{/each}}

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
      {{#each specialConsiderations}}
      - {{{this}}}
      {{/each}}
      {{/if}}

      {{#if examples}}
      ## Examples
      {{{examples}}}
      {{/if}}

      {{#if output}}
      Output:
      {{{output}}}
      {{else}}
      Output:
      {{{output}}}
      {{/if}}
    `)(data),
  );
}

export function createEnhancedPrompt({
  id,
  version,
  sensitivity,
  data,
  logicErrorContext,
}: {
  id: string;
  version: string;
  sensitivity: TimeSensitivity;
  data: PromptSchema;
  logicErrorContext: {
    background?: string;
    additionals: { title: string; content: string }[];
  };
}) {
  const prompt = createPrompt(`${id}-${version}`, sensitivity, data);
  const logicErrorPromptCreator = (input: any) =>
    createPrompt(`LogicFixer-${id}`, sensitivity || TimeSensitivity.Minute, {
      objective: {
        purpose: '你是逻辑问题修复专家。请基于提供的背景信息，修复输入内容中的逻辑错误。',
      },
      context: {
        background: logicErrorContext.background,
        additionals: [...logicErrorContext.additionals, { title: 'Input', content: JSON.stringify(input) }],
      },
      requirements: stripIndent`
      - 识别并修复输入内容中的逻辑错误
      - 确保修复后的输入内容逻辑正确且高效
      - 提供详细的修复说明，解释修复的原因和方法
    `,
      specialConsiderations: ['请确保修复后的输入内容逻辑清晰易懂。', '严格基于输入的结构，不要扩展。'],
    });

  return { prompt, logicErrorPromptCreator };
}
