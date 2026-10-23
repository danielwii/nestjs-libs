import { LLM } from '../clients/llm.class';
import {
  formatByteLength,
  measureBinaryPayloadLength,
  measureDataContent,
  summarizeMessage,
  summarizeMessages,
} from './message-summary';

import { configure, reset } from '@logtape/logtape';
import { describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import type { BinaryPartPayload } from './message-summary';
import type { LogRecord } from '@logtape/logtape';
import type { ModelMessage } from 'ai';

describe('message-summary (binary-safe LLM input summary)', () => {
  it('formats byte lengths across B, KB, and MB boundaries', () => {
    expect(formatByteLength(0)).toBe('0B');
    expect(formatByteLength(-5)).toBe('0B');
    expect(formatByteLength(512)).toBe('512B');
    expect(formatByteLength(2048)).toBe('2.0KB');
    expect(formatByteLength(Math.round(1.52 * 1024 * 1024))).toBe('1.52MB');
  });

  it('measures Uint8Array, ArrayBuffer, base64 strings, URLs, and tagged FileData without serializing bytes or recursing', () => {
    const bytes = new Uint8Array(1024);
    expect(measureDataContent(bytes)).toBe(1024);
    expect(measureBinaryPayloadLength(bytes)).toBe(1024);
    expect(measureBinaryPayloadLength(bytes.buffer)).toBe(1024);
    expect(measureBinaryPayloadLength('aGVsbG8=')).toBe(8);
    expect(measureBinaryPayloadLength(new URL('https://example.com/photo.jpg'))).toBe(0);
    expect(measureBinaryPayloadLength('https://example.com/photo.jpg')).toBe(0);
    expect(measureBinaryPayloadLength({ type: 'data', data: new Uint8Array(4096) })).toBe(4096);
    expect(measureBinaryPayloadLength({ type: 'url', url: new URL('https://example.com/file.pdf') })).toBe(0);
    expect(measureBinaryPayloadLength({ type: 'reference', reference: { openai: 'file-123' } })).toBe(0);
    expect(measureBinaryPayloadLength({ type: 'text', text: 'inline doc' })).toBe(10);

    // Structural non-recursion guarantee ([DEF-10 C1]): even a malformed self-referential
    // object passed via type cast unwraps at most one level and terminates immediately in O(1).
    const cyclic: Record<string, unknown> = { type: 'data' };
    cyclic.data = cyclic;
    expect(measureBinaryPayloadLength(cyclic as unknown as BinaryPartPayload)).toBe(0);
  });

  it('summarizes plain string messages with character counts', () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello world' },
    ];
    expect(summarizeMessages(messages)).toBe('system:16ch, user:11ch');
  });

  it('summarizes multimodal image/file parts with counts and byte sizes, never serializing Uint8Array bytes', () => {
    const imageBytes = new Uint8Array(Math.round(1.52 * 1024 * 1024));
    imageBytes.fill(255);

    const stringifySpy = spyOn(JSON, 'stringify');
    try {
      const msg: ModelMessage = {
        role: 'user',
        content: [
          { type: 'text', text: 'x'.repeat(120) },
          { type: 'image', image: imageBytes },
        ],
      };

      const summary = summarizeMessage(msg);

      expect(summary).toBe('user:[text 120ch, image 1×1.52MB]');
      expect(summary).not.toContain('255');
      expect(summary.length).toBeLessThan(64);
      expect(stringifySpy).not.toHaveBeenCalled();
    } finally {
      stringifySpy.mockRestore();
    }
  });

  it('aggregates multiple images, files, URLs, and tool parts in a single message', () => {
    const img1 = new Uint8Array(512 * 1024);
    const img2 = new Uint8Array(512 * 1024);
    const fileBuf = new ArrayBuffer(2048);

    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Part A ' },
          { type: 'text', text: 'Part B' },
          { type: 'image', image: img1 },
          { type: 'image', image: img2 },
          { type: 'file', mediaType: 'application/pdf', data: fileBuf },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'image', image: new URL('https://example.com/a.png') }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'thinking...' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: { q: 'test' } },
        ],
      },
    ];

    expect(summarizeMessages(messages)).toBe(
      'user:[text 13ch, image 2×1.00MB, file 1×2.0KB], user:[image 1×0B], assistant:[reasoning 11ch, tool-call 1]',
    );
  });

  it('LLM.logInputSummary evaluates lazily (zero work when debug is disabled) and never calls JSON.stringify when debug is enabled', async () => {
    const parts: Extract<ModelMessage['content'], readonly unknown[]> = [
      { type: 'text', text: 'Describe these four photos' },
      { type: 'image', image: new Uint8Array(1_500_000).fill(200) },
      { type: 'image', image: new Uint8Array(1_500_000).fill(201) },
      { type: 'image', image: new Uint8Array(1_500_000).fill(202) },
      { type: 'image', image: new Uint8Array(1_500_000).fill(203) },
    ];
    let contentReads = 0;
    const fourImages: ModelMessage = {
      role: 'user',
      get content() {
        contentReads += 1;
        return parts;
      },
    };

    const schema = z.object({ caption: z.string(), tags: z.array(z.string()) });
    const logInputSummary = (
      LLM as unknown as {
        logInputSummary: (id: string, s: z.ZodType, m: ModelMessage[], instructions?: string) => void;
      }
    ).logInputSummary;

    const batch: ModelMessage[] = [fourImages];
    const records: LogRecord[] = [];
    const stringifySpy = spyOn(JSON, 'stringify');

    try {
      // 1. When lowestLevel is 'info' (debug disabled), the lazy callback is not invoked (C1 Eliminate)
      await reset();
      await configure({
        sinks: { mem: (r) => void (r.category[0] !== 'logtape' && records.push(r)) },
        loggers: [
          { category: ['logtape', 'meta'], sinks: [] },
          { category: [], lowestLevel: 'info', sinks: ['mem'] },
        ],
      });

      logInputSummary('vision-disabled', schema, batch, 'Be concise');
      expect(records).toHaveLength(0);
      expect(contentReads).toBe(0);

      // 2. When lowestLevel is 'debug', summarizeMessages runs once and JSON.stringify is never called
      await reset();
      await configure({
        sinks: { mem: (r) => void (r.category[0] !== 'logtape' && records.push(r)) },
        loggers: [
          { category: ['logtape', 'meta'], sinks: [] },
          { category: [], lowestLevel: 'debug', sinks: ['mem'] },
        ],
      });
      stringifySpy.mockClear();

      logInputSummary('vision-enabled', schema, batch, 'Be concise');
      expect(records).toHaveLength(1);
      // LogTape's `logLazily` evaluates the template callback when a sink/formatter reads `record.message`
      expect(records[0]?.message.join('')).toBe(
        '[LLM:input] id=vision-enabled, schema=[caption,tags], messages=[user:[text 26ch, image 4×5.72MB]], instructions=10ch',
      );
      expect(contentReads).toBe(1);
      expect(stringifySpy).not.toHaveBeenCalled();
    } finally {
      stringifySpy.mockRestore();
      await reset();
    }
  });
});
