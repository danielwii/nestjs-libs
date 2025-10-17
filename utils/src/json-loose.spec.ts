import { parseJsonLoose } from './json-loose';

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
