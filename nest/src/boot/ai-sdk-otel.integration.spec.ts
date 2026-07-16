import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

interface FixtureSpan {
  name: string;
  scope: string;
  attributes: Record<string, unknown>;
}

interface FixtureResult {
  first: { status: string };
  second: { status: string };
  spans: FixtureSpan[];
}

describe('AI SDK OTel integration', () => {
  it('registers once and emits one operation span with bounded runtime context', () => {
    const fixture = join(import.meta.dir, 'ai-sdk-otel.integration.fixture.ts');
    const result = spawnSync(process.execPath, [fixture], {
      cwd: join(import.meta.dir, '../../..'),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const output = JSON.parse(result.stdout.trim()) as FixtureResult;
    expect(output.first.status).toBe('registered');
    expect(output.second.status).toBe('already_registered');

    const operationSpans = output.spans.filter(
      (span) => span.scope === 'gen_ai' && span.attributes['gen_ai.operation.name'] === 'invoke_agent',
    );
    expect(operationSpans).toHaveLength(1);

    const serializedAttributes = JSON.stringify(operationSpans[0]?.attributes);
    expect(serializedAttributes).toContain('fixture input');
    expect(serializedAttributes).toContain('fixture output');
    expect(serializedAttributes).toContain('contract:v7');
    expect(serializedAttributes).not.toContain('must-not-export');
  });

  it.each(['ai', '@ai-sdk/otel'] as const)(
    'loads the boot helper when optional package %s is absent',
    (packageName) => {
      const fixture = join(import.meta.dir, 'ai-sdk-otel.missing.fixture.ts');
      const result = spawnSync(process.execPath, [fixture, packageName], {
        cwd: join(import.meta.dir, '../../..'),
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout.trim())).toEqual({
        status: 'dependency_missing',
        packageName,
      });
    },
  );
});
