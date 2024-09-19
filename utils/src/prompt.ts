import { stripIndent, stripIndents } from 'common-tags';
import * as Handlebars from 'handlebars';
import { format } from 'date-fns';
import { z } from 'zod';

export enum TimeSensitivity {
  Day = 'yyyy-MM-dd EEEE BBBB',
  Hour = 'yyyy-MM-dd EEEE HH BBBB',
  Minute = 'yyyy-MM-dd EEEE HH:mm BBBB',
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
  content: z.string(),
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
  requirements: RequirementsSchema, // 生成要求
  specialConsiderations: SpecialConsiderationsSchema.optional(), // 注意事项
  output: z.string().optional(), // 输出
});
type PromptSchema = z.infer<typeof PromptSchema>;

Handlebars.registerHelper('isArray', (value) => Array.isArray(value));
Handlebars.registerHelper('isString', (value) => typeof value === 'string');

export function createPrompt<Context>(
  id: string,
  sensitivity: TimeSensitivity = TimeSensitivity.Minute,
  data: PromptSchema,
) {
  return Handlebars.compile(stripIndent`
    ID:{{id}} Now:{{now}}
    ------
    ## Objective / Purpose
    {{{data.objective.purpose}}}

    ## Context / Background Information
    {{#if data.context.background}}
    {{{data.context.background}}}
    {{/if}}
    {{#each data.context.additionals}}
    <{{title}}>
    {{{content}}}
    </{{title}}>
    {{/each}}

    ## Requirements / Instructions
    {{#if (isArray data.requirements)}}
    {{#each data.requirements}}
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
    {{{data.requirements}}}
    {{/if}}

    ## Special Considerations
    {{#each data.specialConsiderations}}
    - {{{this}}}
    {{/each}}

    {{#if data.output}}
    Output:
    {{{data.output}}}
    {{else}}
    Output:
    {{{data.output}}}
    {{/if}}
  `)({ id, now: format(new Date(), sensitivity), data });
}
