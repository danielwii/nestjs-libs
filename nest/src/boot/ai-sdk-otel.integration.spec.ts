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

interface CaptureSpan {
  traceId: string;
  name: string;
  attributes: Record<string, unknown>;
}

function runFixture(file: string, args: string[] = []) {
  const result = spawnSync(process.execPath, [join(import.meta.dir, file), ...args], {
    cwd: join(import.meta.dir, '../../..'),
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return result.stdout.trim();
}

function runOperationFixture(policy: 'default' | 'opt-in'): { output: FixtureResult; operation: string } {
  const output = JSON.parse(runFixture('ai-sdk-otel.integration.fixture.ts', [policy])) as FixtureResult;
  const operationSpans = output.spans.filter(
    (span) => span.scope === 'gen_ai' && span.attributes['gen_ai.operation.name'] === 'invoke_agent',
  );
  expect(operationSpans).toHaveLength(1);
  return { output, operation: JSON.stringify(operationSpans[0]?.attributes) };
}

describe('AI SDK OTel integration', () => {
  it('registers once and emits one operation span with bounded runtime context and no content by default', () => {
    const { output, operation } = runOperationFixture('default');
    expect(output.first.status).toBe('registered');
    expect(output.second.status).toBe('already_registered');

    expect(operation).not.toContain('fixture input');
    expect(operation).not.toContain('fixture output');
    expect(operation).toContain('contract:v7');
    expect(operation).not.toContain('must-not-export');
  });

  it('exports input and output content only when the policy explicitly opts in', () => {
    const { operation } = runOperationFixture('opt-in');

    expect(operation).toContain('fixture input');
    expect(operation).toContain('fixture output');
    expect(operation).toContain('contract:v7');
    expect(operation).not.toContain('must-not-export');
  });

  it('keeps content out of every span of a model call unless the call opts in, for none / partial / half-set telemetry', () => {
    const { spans } = JSON.parse(runFixture('llm-telemetry-capture.integration.fixture.ts')) as {
      spans: CaptureSpan[];
    };
    const exported = (name: string) => {
      const operation = spans.find(
        (span) => span.name.startsWith('invoke_agent') && JSON.stringify(span.attributes).includes(`"${name}"`),
      );
      expect(operation).toBeDefined();
      return JSON.stringify(spans.filter((span) => span.traceId === operation!.traceId));
    };

    for (const name of ['case-none', 'case-partial']) {
      const trace = exported(name);
      expect(trace).not.toContain(`input-probe-${name}`);
      expect(trace).not.toContain(`instructions-probe-${name}`);
      expect(trace).not.toContain(`output-probe-${name}`);
      expect(trace).toContain('gen_ai.usage.input_tokens');
    }

    const inputsOnly = exported('case-inputs-only');
    expect(inputsOnly).toContain('input-probe-case-inputs-only');
    expect(inputsOnly).not.toContain('output-probe-case-inputs-only');

    const optIn = exported('case-opt-in');
    expect(optIn).toContain('input-probe-case-opt-in');
    expect(optIn).toContain('output-probe-case-opt-in');
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
