import converter from 'number-to-words';

/**
 * TTS 文本预处理结果
 */
export interface TTSNormalizeResult {
  /** 转换后的文本 */
  normalized: string;
  /** 是否有变化 */
  changed: boolean;
  /** 转换详情（用于日志） */
  replacements: Array<{ original: string; replacement: string }>;
}

/**
 * TTS 文本预处理：数字 → 英文单词
 *
 * 设计意图：
 * - ElevenLabs 小模型（Flash/Turbo）处理数字发音不稳定
 * - 官方建议：避免使用数字，改用英文单词
 * - 入库保持原始数据，仅在 TTS 输出时转换
 *
 * 参考：https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices
 *
 * @example
 * normalizeForTTS("That's 11,835.")
 * // → { normalized: "That's eleven thousand eight hundred thirty-five.", changed: true, ... }
 *
 * @example
 * normalizeForTTS("Hello world")
 * // → { normalized: "Hello world", changed: false, replacements: [] }
 */
export function normalizeForTTS(text: string): TTSNormalizeResult {
  const replacements: Array<{ original: string; replacement: string }> = [];

  // 匹配数字：
  // - 支持逗号分隔（如 11,835）
  // - 支持普通整数（如 50）
  // - \b 确保是独立的数字，不匹配单词中的数字
  const normalized = text.replace(/\b(\d{1,3}(?:,\d{3})+|\d+)\b/g, (match) => {
    // 移除逗号，转换为整数
    const num = parseInt(match.replace(/,/g, ''), 10);

    // 安全边界检查
    if (isNaN(num)) {
      return match;
    }

    // number-to-words 支持到 Number.MAX_SAFE_INTEGER
    // 但超大数字转换后太长，保持原样
    if (num > 999_999_999_999) {
      return match;
    }

    try {
      const words = converter.toWords(num);
      replacements.push({ original: match, replacement: words });
      return words;
    } catch {
      // 转换失败时保持原样
      return match;
    }
  });

  return {
    normalized,
    changed: replacements.length > 0,
    replacements,
  };
}

/**
 * 格式化转换日志
 *
 * @example
 * formatTTSNormalizeLog(result)
 * // → "[TTS_NORMALIZE] 2 replacements: 11,835→eleven thousand..., 50→fifty"
 */
export function formatTTSNormalizeLog(result: TTSNormalizeResult, maxLength = 100): string {
  if (!result.changed) {
    return '';
  }

  const summary = result.replacements
    .map(({ original, replacement }) => {
      const shortened = replacement.length > 30 ? `${replacement.slice(0, 27)}...` : replacement;
      return `${original}→${shortened}`;
    })
    .join(', ');

  const truncated = summary.length > maxLength ? `${summary.slice(0, maxLength - 3)}...` : summary;

  return `[TTS_NORMALIZE] ${result.replacements.length} replacements: ${truncated}`;
}
