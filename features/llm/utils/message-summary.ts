import type { DataContent, FilePart, ImagePart, ProviderReference, ReasoningFilePart } from '@ai-sdk/provider-utils';
import type { ModelMessage } from 'ai';

type ModelMessagePart = Extract<ModelMessage['content'], readonly unknown[]>[number];
export type BinaryPartPayload = ImagePart['image'] | FilePart['data'] | ReasoningFilePart['data'];

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
 * Measure a leaf `DataContent | URL | ProviderReference` value in O(1) without
 * copying buffers, serializing bytes, or recursing (`[DEF-10]` C1 Eliminate).
 */
export function measureDataContent(data: DataContent | URL | ProviderReference): number {
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (data instanceof URL) return 0;
  if (typeof data === 'string') {
    return isUrlString(data) ? 0 : data.length;
  }
  return 0;
}

/**
 * Compute the byte/char size of an AI SDK v7 image/file part payload without
 * calling `JSON.stringify` or recursing (`[CFT-01b]`, `【ARC-03】`, `[DEF-10]` C1):
 * - Bare `DataContent` (`Uint8Array` / `Buffer` / `ArrayBuffer` / base64 string) -> `measureDataContent`
 * - `URL` or `http(s)://` string or `ProviderReference` -> `0`
 * - Tagged `FileData` discriminated union (`{ type: 'data' | 'url' | 'reference' | 'text' }`) ->
 *   unwrapped at most one level into `measureDataContent` (acyclic by construction).
 */
export function measureBinaryPayloadLength(payload: BinaryPartPayload): number {
  if (payload == null) return 0;
  if (
    typeof payload === 'object' &&
    !ArrayBuffer.isView(payload) &&
    !(payload instanceof ArrayBuffer) &&
    !(payload instanceof URL) &&
    'type' in payload
  ) {
    switch (payload.type) {
      case 'data':
        return measureDataContent(payload.data);
      case 'text':
        return typeof payload.text === 'string' ? payload.text.length : 0;
      case 'url':
      case 'reference':
        return 0;
      default:
        return 0;
    }
  }
  return measureDataContent(payload);
}

type PartAccumulator =
  | { kind: 'chars'; type: string; chars: number }
  | { kind: 'binary'; type: string; count: number; bytes: number }
  | { kind: 'count'; type: string; count: number };

function accumulateChars(groups: Map<string, PartAccumulator>, type: 'text' | 'reasoning', chars: number): void {
  const existing = groups.get(type);
  if (existing?.kind === 'chars') {
    existing.chars += chars;
  } else {
    groups.set(type, { kind: 'chars', type, chars });
  }
}

function accumulateBinary(
  groups: Map<string, PartAccumulator>,
  type: 'image' | 'file' | 'reasoning-file',
  bytes: number,
): void {
  const existing = groups.get(type);
  if (existing?.kind === 'binary') {
    existing.count += 1;
    existing.bytes += bytes;
  } else {
    groups.set(type, { kind: 'binary', type, count: 1, bytes });
  }
}

function accumulateCount(groups: Map<string, PartAccumulator>, type: string): void {
  const existing = groups.get(type);
  if (existing?.kind === 'count') {
    existing.count += 1;
  } else {
    groups.set(type, { kind: 'count', type, count: 1 });
  }
}

/**
 * Summarize a single `ModelMessage` for diagnostic logging by dispatching
 * directly on the AI SDK v7 `ModelMessage` discriminated union (`[CFT-01b]`,
 * `【ARC-03】`), never calling `JSON.stringify` on binary buffers.
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
  const parts: readonly ModelMessagePart[] = content;

  for (const part of parts) {
    if (part == null || typeof part !== 'object' || !('type' in part)) continue;

    switch (part.type) {
      case 'text':
      case 'reasoning':
        accumulateChars(groups, part.type, typeof part.text === 'string' ? part.text.length : 0);
        break;
      case 'image':
        accumulateBinary(groups, 'image', measureBinaryPayloadLength(part.image));
        break;
      case 'file':
      case 'reasoning-file':
        accumulateBinary(groups, part.type, measureBinaryPayloadLength(part.data));
        break;
      case 'tool-call':
      case 'tool-result':
      case 'tool-approval-request':
      case 'tool-approval-response':
      case 'custom':
        accumulateCount(groups, part.type);
        break;
      default: {
        // Fallback if a consumer widens or casts a custom runtime part type
        const rawType = (part as { readonly type?: unknown }).type;
        const safeType = typeof rawType === 'string' ? rawType.slice(0, 64) : 'unknown';
        accumulateCount(groups, safeType);
        break;
      }
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
