import JSON5 from 'json5';

// Strip common markdown code fences and whitespace
function stripFences(input: string): string {
  return input.replace(/```(?:json|typescript)?\s*/gi, '').replace(/```/g, '').trim();
}

// Gemini 有时会在字符串内部输出未转义的原始换行，这在 JSON 标准中是不允许的。
// 为了兼容这类响应，我们在尝试解析前，将字符串内部的裸换行转换为 \n 转义符。
function escapeBareNewlinesInStrings(text: string): string {
  let result = '';
  let inString = false;
  let quoteChar: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      result += ch;
      escaped = true;
      continue;
    }

    if (inString) {
      if ((quoteChar === '"' && ch === '"') || (quoteChar === "'" && ch === "'")) {
        inString = false;
        quoteChar = null;
        result += ch;
        continue;
      }

      // 处理 CR、LF 以及 Unicode 段落/行分隔符
      if (ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029') {
        result += '\\n';
        if (ch === '\r' && text[i + 1] === '\n') {
          // 吞掉 CRLF 中的 LF，避免重复写入
          i += 1;
        }
        continue;
      }

      result += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quoteChar = ch;
      result += ch;
      continue;
    }

    result += ch;
  }

  return result;
}

export function extractFirstJsonObject(input: string): string | null {
  if (!input) return null;
  const text = stripFences(input);
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function normalizeTypeScriptLikeJson(text: string): string {
  let normalized = text.trim();
  normalized = normalized.replace(/([{,\s])(\w+)\s*:/g, '$1"$2": ');
  normalized = normalized.replace(/: '([^']*)'/g, ': "$1"');
  return normalized;
}

export function parseJsonLoose<T = unknown>(raw: string): T {
  const candidate = escapeBareNewlinesInStrings(extractFirstJsonObject(raw) ?? stripFences(raw));
  try {
    return JSON.parse(candidate) as T;
  } catch {}
  try {
    return JSON5.parse(candidate) as T;
  } catch {}
  const tsFixed = normalizeTypeScriptLikeJson(candidate);
  try {
    return JSON.parse(tsFixed) as T;
  } catch {}
  try {
    return JSON5.parse(tsFixed) as T;
  } catch {}
  throw new Error('Failed to parse valid JSON from model output');
}
