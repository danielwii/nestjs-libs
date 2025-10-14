import { stripIndent } from 'common-tags';
import { zhCN } from 'date-fns/locale';
import Handlebars from 'handlebars';
import { format } from 'date-fns';
import { DateTime } from 'luxon';
import { z } from 'zod';
import _ from 'lodash';

export function generateJsonFormat(schema: z.ZodSchema, indent = 0): string {
  const definition = Reflect.get(schema, '_def');
  const serialized = JSON.stringify(
    definition,
    (key, value) => (typeof value === 'function' ? undefined : value),
    2,
  );
  const indentPrefix = ' '.repeat(indent);
  return serialized
    .split('\n')
    .map((line) => `${indentPrefix}${line}`)
    .join('\n');
}



export enum TimeSensitivity {
  Day = 'yyyy-MM-dd EEEE BBBB',
  Hour = 'yyyy-MM-dd EEEE hh a BBBB',
  Minute = 'yyyy-MM-dd EEEE HH:mm BBBB',
}

// 目的 (Objective/Purpose)
const ObjectiveSchema = z.string(); // 必须明确的任务目的

// 上下文/背景知识 (Context/Background Information)
// 已移动到XmlPromptSchema内部定义

// 生成要求 (Requirements/Instructions)
const RequirementsSchema = z.union([z.string(), z.array(z.string())]);

// 注意事项 (Special Considerations)
const SpecialConsiderationsSchema = z.union([z.string(), z.array(z.string())]).optional();

// 完整的通用 prompt schema
const PromptSchema = z.object({
  purpose: ObjectiveSchema, // 任务目的
  background: z.string().optional(), // 描述背景设定
  context: z
    .array(
      z.object({
        title: z.string(),
        content: z.union([z.string(), z.number()]).optional(),
      }),
    )
    .optional(), // 上下文/背景知识
  requirements: RequirementsSchema.optional(), // 生成要求
  instructions: z.string().optional(), // 生成要求
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
  const now = format(datetime, sensitivity, { locale: zhCN });
  return Handlebars.compile(stripIndent`
    [{{id}}]
    ------
    {{{content}}}
    ------
    Now:{{now}}
    Output:
    {{#if output}}
    {{{output}}}
    {{/if}}
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

      ## Requirements / Instructions
      {{#if instructions}}
      {{{instructions}}}
      {{/if}}
      {{#if requirements}}
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
