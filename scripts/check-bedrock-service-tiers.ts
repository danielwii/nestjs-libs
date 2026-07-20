/**
 * Bedrock serviceTier 可用性自查脚本
 *
 * 对当前环境(AI_BEDROCK_REGION / AWS 凭证)下的全部注册 bedrock 模型
 * 逐个 live 探测 flex/priority 档位可用性并打印矩阵。
 * 支持度随账号/区域/AWS 扩容变化,部署到使用方账号后应重跑核对。
 *
 * 用法:
 *   bun run check:bedrock-tiers              # 探测 flex + priority
 *   bun run check:bedrock-tiers flex         # 只探测 flex
 *   bun run check:bedrock-tiers flex,priority
 *
 * 凭证:AI_BEDROCK_API_KEY,或 AWS_BEARER_TOKEN_BEDROCK,
 * 或 `aws configure export-credentials --profile <name> --format env` 导出的 SigV4 变量。
 */

import 'reflect-metadata';

const { LLM } = await import('../features/llm');

const tiersArg = process.argv[2];
const rawTiers = tiersArg ? tiersArg.split(',') : ['flex', 'priority'];
const VALID_TIERS = new Set(['flex', 'priority']);
for (const t of rawTiers) {
  if (!VALID_TIERS.has(t)) {
    console.error(`unknown tier "${t}", valid: flex,priority`);
    process.exit(1);
  }
}
const tiers = rawTiers as Array<'flex' | 'priority'>;

console.log(
  `probing ${tiers.join(' + ')} on region=${process.env.AI_BEDROCK_REGION ?? process.env.AWS_REGION ?? 'us-east-1'} ...\n`,
);

const matrix = await LLM.checkBedrockServiceTierSupport({ tiers });

const keyW = Math.max(...matrix.map((r) => r.key.length));
const idW = Math.max(...matrix.map((r) => r.modelId.length));
console.log(`${'key'.padEnd(keyW)}  ${'modelId'.padEnd(idW)}  ${tiers.map((t) => t.padEnd(9)).join('')}`);
console.log('─'.repeat(keyW + idW + tiers.length * 9 + 2));
let unknowns = 0;
for (const row of matrix) {
  const cells = tiers.map((t) => {
    const v = row[t];
    if (v === true) return '✅'.padEnd(8);
    if (v === false) return '❌'.padEnd(8);
    unknowns++;
    return '⚠️ unk'.padEnd(8);
  });
  console.log(`${row.key.padEnd(keyW)}  ${row.modelId.padEnd(idW)}  ${cells.join('')}`);
  if (row.errors) {
    for (const [tier, message] of Object.entries(row.errors)) {
      console.log(`${''.padEnd(keyW)}  └ ${tier} unknown: ${message}`);
    }
  }
}

const capable = matrix.filter((r) => tiers.every((t) => r[t] === true)).length;
console.log(
  `\n${capable}/${matrix.length} models accept ${tiers.join('+')}${unknowns > 0 ? ` (${unknowns} unknown — 探测链路问题,需重跑确认)` : ''}`,
);
