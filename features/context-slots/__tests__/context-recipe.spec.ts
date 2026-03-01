/**
 * ContextRecipe / uShapedLayout / resolveSlotRef unit tests.
 */

import { uShapedLayout } from '../context-recipe';
import { defineSlot, resolveSlotRef } from '../context-slot.types';

import { describe, expect, it } from 'bun:test';

import type { CompiledBlock } from '../context-slot.types';

// ═══════════════════════════════════════════════════════════════════════════
// resolveSlotRef
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveSlotRef', () => {
  it('resolves slot object to its ID', () => {
    const slot = defineSlot<string>({
      id: 'test.slot',
      title: 'Test',
      description: '',
      category: 'test',
      priority: 50,
      renderers: { full: (d) => d },
    });
    expect(resolveSlotRef(slot)).toBe('test.slot');
  });

  it('passes through string as-is (backward compat)', () => {
    expect(resolveSlotRef('raw.id')).toBe('raw.id');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// uShapedLayout with SlotRef
// ═══════════════════════════════════════════════════════════════════════════

const SlotA = defineSlot<string>({
  id: 'a',
  title: 'A',
  description: '',
  category: 'test',
  priority: 50,
  renderers: { full: (d) => d },
});
const SlotB = defineSlot<string>({
  id: 'b',
  title: 'B',
  description: '',
  category: 'test',
  priority: 60,
  renderers: { full: (d) => d },
});
const SlotC = defineSlot<string>({
  id: 'c',
  title: 'C',
  description: '',
  category: 'test',
  priority: 40,
  renderers: { full: (d) => d },
});

function makeBlock(id: string, priority: number): CompiledBlock {
  return { id, title: id, content: id, priority, category: 'test' };
}

describe('uShapedLayout with SlotRef', () => {
  const blocks: CompiledBlock[] = [makeBlock('a', 50), makeBlock('b', 60), makeBlock('c', 40)];

  it('accepts slot objects in head/tail', () => {
    const result = uShapedLayout(blocks, { head: [SlotA], tail: [SlotC] });
    const ids = result.map((b) => b.id);
    // head(a) → middle(b, sorted by priority) → tail(c)
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('accepts mixed slot objects and strings', () => {
    const result = uShapedLayout(blocks, { head: [SlotA, 'b'], tail: ['c'] });
    const ids = result.map((b) => b.id);
    // head(a, b in order) → no middle → tail(c)
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('accepts all strings (backward compat)', () => {
    const result = uShapedLayout(blocks, { head: ['a'], tail: ['c'] });
    const ids = result.map((b) => b.id);
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('skips non-existent slot refs', () => {
    const nonExistent = defineSlot<string>({
      id: 'z',
      title: 'Z',
      description: '',
      category: 'test',
      priority: 99,
      renderers: { full: (d) => d },
    });
    const result = uShapedLayout(blocks, { head: [nonExistent, SlotA], tail: [] });
    const ids = result.map((b) => b.id);
    // z doesn't exist in blocks → skipped; a in head, b+c in middle sorted by priority
    expect(ids).toEqual(['a', 'b', 'c']);
  });
});
