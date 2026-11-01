import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

interface ExportedSpan {
  name: string;
  attributes: Record<string, unknown>;
  status: { code: number; message?: string };
  events: Array<{ name: string; attributes: Record<string, unknown> }>;
}

const SPAN_STATUS_ERROR = 2;

function exportSpans(probe: string): ExportedSpan[] {
  const result = spawnSync(process.execPath, [join(import.meta.dir, 'span-exception.fixture.ts'), probe], {
    cwd: join(import.meta.dir, '../../..'),
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return (JSON.parse(result.stdout.trim()) as { spans: ExportedSpan[] }).spans;
}

describe('span exceptions', () => {
  const probe = `probe-${randomUUID()}`;
  const spans = exportSpans(probe);
  const byName = (name: string) => {
    const span = spans.find((candidate) => candidate.name === name);
    expect(span).toBeDefined();
    return span!;
  };

  it('exports every failing span with an error status', () => {
    expect(spans.map((span) => span.name)).toEqual([
      'stage.fail',
      'telemetry.oops',
      'telemetry.coded',
      'telemetry.string',
      'stage.manual',
      'decorated.fail',
    ]);
    for (const span of spans) expect(span.status.code).toBe(SPAN_STATUS_ERROR);
  });

  it('keeps the thrown text out of span status, exception events, attributes and Langfuse statusMessage', () => {
    expect(probe.length).toBeGreaterThan(20);
    expect(JSON.stringify(spans)).not.toContain(probe);
  });

  it('writes the class name and cause class names for a stage span', () => {
    const span = byName('stage.fail');

    expect(span.status.message).toBe('TypeError cause=RangeError');
    expect(span.events[0]?.attributes).toMatchObject({
      'exception.type': 'TypeError',
      'exception.message': 'TypeError cause=RangeError',
    });
    expect(span.events[0]?.attributes).not.toHaveProperty('exception.stacktrace');
  });

  it('writes the combined code of an Oops thrown inside a telemetry span, in status and statusMessage', () => {
    const span = byName('telemetry.oops');

    expect(span.status.message).toBe('Panic code=0x0405SYS01');
    expect(span.attributes['langfuse.observation.status_message']).toBe('Panic code=0x0405SYS01');
    expect(span.attributes['langfuse.observation.level']).toBe('ERROR');
  });

  it('writes a well-formed code and cause class names, and only the typeof of a thrown string', () => {
    expect(byName('telemetry.coded').status.message).toBe('Error code=ECONNRESET cause=TypeError');
    expect(byName('telemetry.string').status.message).toBe('string');
  });

  it('replaces a malformed code with a fixed value on a manually closed stage span', () => {
    expect(byName('stage.manual').status.message).toBe('Error code=other');
  });

  it('keeps the message out of the status of a span created by the Trace decorator', () => {
    expect(byName('decorated.fail').status.message).toBe('RangeError');
  });
});
