import JSON5 from 'json5';

// Strip common markdown code fences and whitespace
function stripFences(input: string): string {
  return input.replace(/```(?:json|typescript)?\s*/gi, '').replace(/```/g, '').trim();
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
  const candidate = extractFirstJsonObject(raw) ?? stripFences(raw);
  try { return JSON.parse(candidate) as T; } catch {}
  try { return JSON5.parse(candidate) as T; } catch {}
  const tsFixed = normalizeTypeScriptLikeJson(candidate);
  try { return JSON.parse(tsFixed) as T; } catch {}
  try { return JSON5.parse(tsFixed) as T; } catch {}
  throw new Error('Failed to parse valid JSON from model output');
}

