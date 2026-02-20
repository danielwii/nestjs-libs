/**
 * Token Estimation Utility
 *
 * Provides heuristics for estimating token counts without external heavy dependencies.
 * Accuracy is not the primary goal; consistent and conservative estimation for budget
 * and reporting purposes is what matters.
 */

/**
 * Estimates the number of tokens in a given text.
 *
 * Current policy: "Brave" heuristic.
 * - ASCII (English/Code): ~4 chars/token (0.25x)
 * - Multi-byte (CJK): 1 char/token (1x)
 *
 * This provides a more accurate but still conservative budget estimation
 * compared to simple length, especially for mixed language prompts.
 *
 * @param text The text to estimate tokens for.
 * @returns The estimated token count.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let asciiCount = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) <= 0x7f) asciiCount++;
  }
  const multiByteCount = text.length - asciiCount;

  // (ASCII * 0.25) + (CJK * 1) -> ceil
  return Math.ceil(asciiCount * 0.25 + multiByteCount * 1);
}

/**
 * Estimates total tokens for a batch of strings.
 */
export function estimateTokensBatch(texts: string[]): number {
  return texts.reduce((sum, text) => sum + estimateTokens(text), 0);
}
