/**
 * Demo A — requiredEnvs gate passes when the key is present.
 *
 * Usage:
 *   NODE_ENV=development AI_GOOGLE_VERTEX_API_KEY=demo bun scripts/required-envs-demo/ok.ts
 */
import { assertRequiredEnvs } from '../../nest/src/boot/bootstrap';

process.env.NODE_ENV ??= 'development';
process.env.AI_GOOGLE_VERTEX_API_KEY ??= 'demo-vertex-key';

assertRequiredEnvs(['AI_GOOGLE_VERTEX_API_KEY']);
console.log('required-envs: ok');
