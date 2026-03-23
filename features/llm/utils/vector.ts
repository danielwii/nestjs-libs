/**
 * 向量计算工具
 *
 * 用于 embedding 相似度计算等场景。
 */

/**
 * 计算两个向量的余弦相似度
 *
 * - 1.0: 完全相同方向
 * - 0.0: 正交（无相关性）
 * - -1.0: 完全相反方向
 *
 * @param a 向量 a
 * @param b 向量 b
 * @returns 余弦相似度 [-1, 1]，向量长度不同或为零向量时返回 0
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const valA = a[i] ?? 0;
    const valB = b[i] ?? 0;
    dotProduct += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}
