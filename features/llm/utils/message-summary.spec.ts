import { LLM } from '../clients/llm.class';
import { formatByteLength, measureBinaryPayloadLength, summarizeMessage, summarizeMessages } from './message-summary';

import { describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import type { ModelMessage } from 'ai';

describe('message-summary (binary-safe LLM input summary)', () => {
  it('formats byte lengths across B, KB, and MB boundaries', () => {
    expect(formatByteLength(0)).toBe('0B');
    expect(formatByteLength(-5)).toBe('0B');
    expect(formatByteLength(512)).toBe('512B');
    expect(formatByteLength(2048)).toBe('2.0KB');
    expect(formatByteLength(Math.round(1.52 * 1024 * 1024))).toBe('1.52MB');
  });

  it('measures Uint8Array, ArrayBuffer, base64 strings, URLs, and tagged FileData without serializing bytes', () => {
    const bytes = new Uint8Array(1024);
    expect(measureBinaryPayloadLength(bytes)).toBe(1024);
    expect(measureBinaryPayloadLength(bytes.buffer)).toBe(1024);
    expect(measureBinaryPayloadLength('aGVsbG8=')).toBe(8);
    expect(measureBinaryPayloadLength(new URL('https://example.com/photo.jpg'))).toBe(0);
    expect(measureBinaryPayloadLength('https://example.com/photo.jpg')).toBe(0);
    expect(measureBinaryPayloadLength({ type: 'data', data: new Uint8Array(4096) })).toBe(4096);
    expect(measureBinaryPayloadLength({ type: 'url', url: 'https://example.com/file.pdf' })).toBe(0);
    expect(measureBinaryPayloadLength({ type: 'reference', reference: { openai: 'file-123' } })).toBe(0);
    expect(measureBinaryPayloadLength({ type: 'text', text: 'inline doc' })).toBe(10);
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

      const start = performance.now();
      const summary = summarizeMessage(msg);
      const elapsedMs = performance.now() - start;

      expect(summary).toBe('user:[text 120ch, image 1×1.52MB]');
      expect(summary).not.toContain('255');
      expect(summary.length).toBeLessThan(64);
      expect(elapsedMs).toBeLessThan(10);
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

  it('LLM.logInputSummary logs bounded summary without calling JSON.stringify on 4×1.5MB Uint8Array images', () => {
    const fourImages: ModelMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe these four photos' },
        { type: 'image', image: new Uint8Array(1_500_000).fill(200) },
        { type: 'image', image: new Uint8Array(1_500_000).fill(201) },
        { type: 'image', image: new Uint8Array(1_500_000).fill(202) },
        { type: 'image', image: new Uint8Array(1_500_000).fill(203) },
      ],
    };

    const schema = z.object({ caption: z.string(), tags: z.array(z.string()) });
    const logInputSummary = (
      LLM as unknown as {
        logInputSummary: (id: string, s: z.ZodType, m: ModelMessage[], instructions?: string) => void;
      }
    ).logInputSummary;

    const stringifySpy = spyOn(JSON, 'stringify');
    try {
      const start = performance.now();
      logInputSummary('vision-test', schema, [fourImages], 'Be concise');
      const elapsedMs = performance.now() - start;

      expect(elapsedMs).toBeLessThan(20);
      expect(stringifySpy).not.toHaveBeenCalled();
    } finally {
      stringifySpy.mockRestore();
    }
  });
});
