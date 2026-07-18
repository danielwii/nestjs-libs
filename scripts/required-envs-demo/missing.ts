/**
 * Demo B — requiredEnvs gate fails when the key is missing/blank.
 *
 * Usage:
 *   NODE_ENV=development bun scripts/required-envs-demo/missing.ts
 */
import { assertRequiredEnvs } from '../../nest/src/boot/bootstrap';

process.env.NODE_ENV ??= 'development';
delete process.env.AI_GOOGLE_VERTEX_API_KEY;

assertRequiredEnvs(['AI_GOOGLE_VERTEX_API_KEY']);
console.log('required-envs: unexpected-pass');
process.exit(0);
