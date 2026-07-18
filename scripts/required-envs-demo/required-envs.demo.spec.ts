/**
 * Local demo smoke for bootstrap requiredEnvs (subprocess).
 * Tracked under scripts/ because example/ is gitignored in this repo.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'bun:test';

const root = path.resolve(import.meta.dir, '../..');
const okScript = path.join(import.meta.dir, 'ok.ts');
const missingScript = path.join(import.meta.dir, 'missing.ts');

function runDemo(script: string, env: NodeJS.ProcessEnv) {
  return spawnSync('bun', [script], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

describe('scripts/required-envs-demo', () => {
  const originalVertex = process.env.AI_GOOGLE_VERTEX_API_KEY;

  afterAll(() => {
    if (originalVertex === undefined) delete process.env.AI_GOOGLE_VERTEX_API_KEY;
    else process.env.AI_GOOGLE_VERTEX_API_KEY = originalVertex;
  });

  it('ok.ts exits 0 when AI_GOOGLE_VERTEX_API_KEY is set', () => {
    const result = runDemo(okScript, {
      NODE_ENV: 'development',
      AI_GOOGLE_VERTEX_API_KEY: 'demo-vertex-key',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('required-envs: ok');
    expect(result.stderr ?? '').not.toContain('required env(s) not set');
  });

  it('missing.ts exits non-zero and names the missing key', () => {
    const result = runDemo(missingScript, {
      NODE_ENV: 'development',
      AI_GOOGLE_VERTEX_API_KEY: '',
    });

    const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    expect(result.status).not.toBe(0);
    expect(combined).toContain('required env(s) not set');
    expect(combined).toContain('AI_GOOGLE_VERTEX_API_KEY');
    expect(combined).not.toContain('demo-vertex-key');
  });
});
