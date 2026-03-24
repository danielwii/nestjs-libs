import { extractFirstJsonObject, parseJsonLoose } from './json-loose';

import { describe, expect, it } from 'bun:test';

describe('extractFirstJsonObject', () => {
  it('提取简单 JSON 对象', () => {
    expect(extractFirstJsonObject('{"a": 1}')).toBe('{"a": 1}');
  });

  it('字符串内的 } 不截断对象', () => {
    const input = '{"key": "value with } brace", "other": "data"}';
    expect(extractFirstJsonObject(input)).toBe(input);
  });

  it('字符串内的 { 不干扰深度计算', () => {
    const input = '{"key": "{ nested { braces }", "ok": true}';
    expect(extractFirstJsonObject(input)).toBe(input);
  });

  it('转义引号不结束字符串', () => {
    const input = '{"key": "value \\"with\\" quotes", "b": 2}';
    expect(extractFirstJsonObject(input)).toBe(input);
  });

  it('嵌套对象正确匹配', () => {
    const input = '{"a": {"b": {"c": 1}}}';
    expect(extractFirstJsonObject(input)).toBe(input);
  });

  it('前导文本被跳过', () => {
    const input = 'Here is the result: {"a": 1} done';
    expect(extractFirstJsonObject(input)).toBe('{"a": 1}');
  });

  it('markdown 代码块被剥离', () => {
    const input = '```json\n{"a": 1}\n```';
    expect(extractFirstJsonObject(input)).toBe('{"a": 1}');
  });

  it('无 JSON 返回 null', () => {
    expect(extractFirstJsonObject('no json here')).toBeNull();
  });

  it('空输入返回 null', () => {
    expect(extractFirstJsonObject('')).toBeNull();
  });

  it('未闭合对象返回 null', () => {
    expect(extractFirstJsonObject('{"a": 1')).toBeNull();
  });
});

describe('parseJsonLoose', () => {
  it('parses JSON wrapped in markdown fences with bare newlines inside strings', () => {
    const input = `\`\`\`json
{"workingMemoryReason": "line1
line2"}
\`\`\``;
    const result = parseJsonLoose<{ workingMemoryReason: string }>(input);
    expect(result.workingMemoryReason).toBe(`line1
line2`);
  });

  it('converts CRLF bare newlines inside strings to escaped newlines', () => {
    const input = '{"summary": "first line\r\nsecond line"}';
    const result = parseJsonLoose<{ summary: string }>(input);
    expect(result.summary).toBe('first line\nsecond line');
  });
});
