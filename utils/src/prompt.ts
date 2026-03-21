import { normalizeTimezone } from './datetime';

import dedent from 'dedent';
import { DateTime } from 'luxon';
import { z } from 'zod';

export function generateJsonFormat(schema: z.ZodType, indent = 0): string {
  const definition = Reflect.get(schema, '_def');
  const serialized = JSON.stringify(definition, (_key, value) => (typeof value === 'function' ? undefined : value), 2);
  const indentPrefix = ' '.repeat(indent);
  return serialized
    .split('\n')
    .map((line) => `${indentPrefix}${line}`)
    .join('\n');
}

/**
 * Luxon toFormat patterns（不含 dayPeriod 和时区，由 formatLocalDateTime 拼接）。
 *
 * dayPeriod 通过 Intl toLocaleString({ dayPeriod: 'long' }) 获取（"in the morning" 等）。
 * 时区通过 Luxon z token 获取（"Asia/Tokyo" 等）。
 */
export enum TimeSensitivity {
  Day = 'yyyy-MM-dd EEEE',
  Hour = 'yyyy-MM-dd EEEE hh a',
  Minute = 'yyyy-MM-dd EEEE HH:mm',
}

/**
 * 将 ISO datetime 字符串或 Date 格式化为带时区和 dayPeriod 的可读时间。
 *
 * 输出示例：`2026-03-21 Saturday 04:20 in the morning (Asia/Tokyo)`
 *
 * 默认使用 process.env.TZ 作为时区。
 * 用于 prompt 中展示时间给 LLM，避免 UTC 导致的时间误判。
 */
/**
 * 将 ISO/Date 转为指定时区的 Luxon DateTime。
 * 所有 prompt 时间格式化函数的共享基础。
 */
function toLuxonDt(dateOrIso?: string | Date | null, timezone?: string | null): DateTime {
  const raw = timezone ?? process.env.TZ;
  const tz = normalizeTimezone(raw) ?? 'local';
  // Luxon 需要 "UTC+8" 格式，normalizeTimezone 输出 "+08:00"，加 UTC 前缀
  const luxonZone = /^[+-]\d/.test(tz) ? `UTC${tz}` : tz;
  return (
    dateOrIso
      ? DateTime.fromJSDate(new Date(typeof dateOrIso === 'string' ? dateOrIso : dateOrIso.getTime()))
      : DateTime.now()
  ).setZone(luxonZone);
}

/**
 * 完整时间：`2026-03-21 Saturday 04:20 in the morning (Asia/Tokyo)`
 *
 * 用于 prompt 的 `Now:` 行、时间提取基准等需要完整时间+时区的场景。
 */
export function formatLocalDateTime(
  dateOrIso?: string | Date | null,
  sensitivity: TimeSensitivity = TimeSensitivity.Minute,
  timezone?: string | null,
): string {
  const dt = toLuxonDt(dateOrIso, timezone);
  const main = dt.toFormat(sensitivity);
  const dayPeriod = dt.toLocaleString({ dayPeriod: 'long' }, { locale: 'en' });
  const zone = dt.toFormat('z');
  return `${main} ${dayPeriod} (${zone})`;
}

/**
 * 本地日期：`2026-03-21`
 *
 * 替代 `toISOString().slice(0, 10)` — 避免 UTC 日期边界错位。
 * 用于只需日期精度的场景（任务截止、存储条目、curriculum 执行时间等）。
 */
export function formatLocalDate(dateOrIso: string | Date, timezone?: string | null): string {
  return toLuxonDt(dateOrIso, timezone).toFormat('yyyy-MM-dd');
}

/**
 * 本地短时间：`03-21 07:30`
 *
 * 替代 `isoString.slice(5, 16)` — 避免 UTC 时间错位。
 * 用于行为时间线等需要月日时分但不需年份的场景。
 */
export function formatLocalShortTime(dateOrIso: string | Date, timezone?: string | null): string {
  return toLuxonDt(dateOrIso, timezone).toFormat('MM-dd HH:mm');
}

// 生成要求 (Requirements/Instructions)
const RequirementsSchema = z.union([z.string(), z.array(z.string())]);

// 注意事项 (Special Considerations)
const SpecialConsiderationsSchema = z.union([z.string(), z.array(z.string())]).optional();

// 完整的通用 prompt schema
const PromptSchema = z.object({
  purpose: z.string(),
  background: z.string().optional(),
  context: z
    .array(
      z.object({
        title: z.string(),
        content: z.union([z.string(), z.number()]).optional(),
      }),
    )
    .optional(),
  requirements: RequirementsSchema.optional(),
  instructions: z.string().optional(),
  specialConsiderations: SpecialConsiderationsSchema.optional(),
  examples: z.union([z.string(), z.array(z.string())]).optional(),
  output: z.string().optional(),
});
type PromptSchema = z.infer<typeof PromptSchema>;

/** 将 string | string[] 渲染为列表或纯文本 */
function renderList(items: string | string[]): string {
  return Array.isArray(items) ? items.map((item) => `- ${item}`).join('\n') : items;
}

export function createBasePrompt(
  id: string,
  timezone: string | undefined | null,
  sensitivity: TimeSensitivity = TimeSensitivity.Minute,
  content: string,
  output?: string,
) {
  const now = formatLocalDateTime(undefined, sensitivity, timezone);
  return [`[${id}]`, '------', content, '------', `Now:${now}`, 'Output:', output].filter(Boolean).join('\n');
}

export function createPrompt(
  id: string,
  timezone: string | undefined | null,
  sensitivity: TimeSensitivity = TimeSensitivity.Minute,
  data: PromptSchema,
) {
  const content = [
    dedent`
      ## Objective / Purpose
      ${data.purpose}
    `,

    data.background &&
      dedent`
        ## Background Information
        ${data.background}
      `,

    (data.instructions || data.requirements) &&
      ['## Requirements / Instructions', data.instructions, data.requirements && renderList(data.requirements)]
        .filter(Boolean)
        .join('\n'),

    data.specialConsiderations &&
      dedent`
        ## Special Considerations
        ${renderList(data.specialConsiderations)}
      `,

    data.examples &&
      dedent`
        ## Examples
        ${renderList(data.examples)}
      `,

    data.context?.length &&
      [
        '## Context',
        ...data.context.map(
          (ctx) => dedent`
            <${ctx.title}>
            ${ctx.content ?? '<empty />'}
            </${ctx.title}>
          `,
        ),
      ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');

  return createBasePrompt(id, timezone, sensitivity, content, data.output);
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

        return createPrompt(`LogicFixer-${id}`, timezone, sensitivity, {
          purpose: '你是逻辑问题修复专家。请基于提供的背景信息，修复输入内容中的逻辑错误。',
          background: logicErrorContext.background,
          context: [...(logicErrorContext.additionals ?? []), { title: 'Input', content: JSON.stringify(response) }],
          requirements: [
            dedent`
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
  schema: z.ZodType,
  {
    injectJsonFormat,
    output,
  }: {
    injectJsonFormat?: boolean;
    output?: string;
  },
) =>
  [
    '严格输出符合 Schema 定义的 JSON 格式。枚举原样使用定义中的类型，不要翻译，不要输出任何其他内容，包括注释、解释、提示等。直接从 { 开始，到 } 结束, 不要输出任何其他内容。',
    injectJsonFormat
      ? `--- RESPONSE TypeScript Schema JSON FORMAT---\n${generateJsonFormat(schema)}\n--- END OF RESPONSE TYPE-SCRIPT SCHEMA JSON FORMAT ---`
      : '',
    output,
  ]
    .filter(Boolean)
    .join('\n');
