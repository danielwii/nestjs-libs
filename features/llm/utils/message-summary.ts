import type { ModelMessage } from 'ai';

/**
 * Format a byte count into a compact human-readable unit (`B`, `KB`, `MB`).
 *
 * - `< 1024`: `${bytes}B` (e.g. `0B`, `512B`)
 * - `< 1024 * 1024`: `${(bytes / 1024).toFixed(1)}KB` (e.g. `4.0KB`)
 * - `>= 1024 * 1024`: `${(bytes / (1024 * 1024)).toFixed(2)}MB` (e.g. `1.52MB`)
 */
export function formatByteLength(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B';
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

function isUrlString(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

/**
 * Compute the byte/char size of an AI SDK binary/data payload without ever
 * calling `JSON.stringify` or copying underlying buffers:
 * - `Uint8Array` / `Buffer` / `ArrayBufferView` -> `byteLength`
 * - `ArrayBuffer` -> `byteLength`
 * - `URL` or `http(s)://` string -> `0`
 * - base64 / data-URL / inline string -> `string.length`
 * - tagged AI SDK v7 `FileData` (`{ type: 'data' | 'url' | 'reference' | 'text', ... }`) -> unwrapped
 */
export function measureBinaryPayloadLength(payload: unknown): number {
  if (payload == null) return 0;
  if (ArrayBuffer.isView(payload)) return payload.byteLength;
  if (payload instanceof ArrayBuffer) return payload.byteLength;
  if (payload instanceof URL) return 0;
  if (typeof payload === 'string') {
    return isUrlString(payload) ? 0 : payload.length;
  }
  if (typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (record.type === 'url' || record.type === 'reference') {
      return 0;
    }
    if (record.type === 'data' && 'data' in record) {
      return measureBinaryPayloadLength(record.data);
    }
    if (record.type === 'text' && typeof record.text === 'string') {
      return record.text.length;
    }
  }
  return 0;
}

type PartAccumulator =
  | { kind: 'chars'; type: string; chars: number }
  | { kind: 'binary'; type: string; count: number; bytes: number }
  | { kind: 'count'; type: string; count: number };

/**
 * Summarize a single `ModelMessage` for diagnostic logging without ever
 * calling `JSON.stringify` on message content or binary buffers.
 *
 * Examples:
 * - `{ role: 'user', content: 'hello' }` -> `'user:5ch'`
 * - `{ role: 'user', content: [{ type: 'text', text: '...' }, { type: 'image', image: uint8 }] }`
 *   -> `'user:[text 120ch, image 1×1.52MB]'`
 */
export function summarizeMessage(message: ModelMessage): string {
  const { role, content } = message;
  if (typeof content === 'string') {
    return `${role}:${content.length}ch`;
  }
  if (!Array.isArray(content)) {
    return `${role}:0ch`;
  }

  const groups = new Map<string, PartAccumulator>();

  for (const part of content as readonly unknown[]) {
    if (part == null || typeof part !== 'object') continue;
    const rawPart = part as Record<string, unknown>;
    const partType = typeof rawPart.type === 'string' ? rawPart.type : 'unknown';

    if (partType === 'text' || partType === 'reasoning') {
      const textLen = typeof rawPart.text === 'string' ? rawPart.text.length : 0;
      const existing = groups.get(partType);
      if (existing?.kind === 'chars') {
        existing.chars += textLen;
      } else {
        groups.set(partType, { kind: 'chars', type: partType, chars: textLen });
      }
      continue;
    }

    if (partType === 'image' || partType === 'file' || partType === 'reasoning-file') {
      const payload = partType === 'image' ? rawPart.image : rawPart.data;
      const byteLen = measureBinaryPayloadLength(payload);
      const existing = groups.get(partType);
      if (existing?.kind === 'binary') {
        existing.count += 1;
        existing.bytes += byteLen;
      } else {
        groups.set(partType, { kind: 'binary', type: partType, count: 1, bytes: byteLen });
      }
      continue;
    }

    const existing = groups.get(partType);
    if (existing?.kind === 'count') {
      existing.count += 1;
    } else {
      groups.set(partType, { kind: 'count', type: partType, count: 1 });
    }
  }

  const renderedParts: string[] = [];
  for (const acc of groups.values()) {
    if (acc.kind === 'chars') {
      renderedParts.push(`${acc.type} ${acc.chars}ch`);
    } else if (acc.kind === 'binary') {
      renderedParts.push(`${acc.type} ${acc.count}×${formatByteLength(acc.bytes)}`);
    } else {
      renderedParts.push(`${acc.type} ${acc.count}`);
    }
  }

  return `${role}:[${renderedParts.join(', ')}]`;
}

/**
 * Summarize a list of `ModelMessage` items for `[LLM:input]` diagnostic logs.
 * Never serializes binary parts (`Uint8Array` / `ArrayBuffer` / `Buffer`).
 */
export function summarizeMessages(messages: readonly ModelMessage[]): string {
  return messages.map(summarizeMessage).join(', ');
}
