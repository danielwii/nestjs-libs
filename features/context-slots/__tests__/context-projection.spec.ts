/**
 * Context Projection unit tests.
 *
 * 覆盖：forSource / project / applyProjections
 */

import { ContextBag } from '../context-bag';
import { applyProjections, forSource } from '../context-projection';
import { defineSlot } from '../context-slot.types';

import { describe, expect, it } from 'bun:test';

// ═══════════════════════════════════════════════════════════════════════════
// 测试用类型和 Slot
// ═══════════════════════════════════════════════════════════════════════════

type Source = { name: string; age?: number };

const nameSlot = defineSlot<string>({
  id: 'test.name',
  title: 'Name',
  description: '',
  category: 'test',
  priority: 50,
  renderers: { full: (d) => d },
});

const ageSlot = defineSlot<number>({
  id: 'test.age',
  title: 'Age',
  description: '',
  category: 'test',
  priority: 40,
  renderers: { full: (d) => `age=${d}` },
});

// ═══════════════════════════════════════════════════════════════════════════
// forSource / project
// ═══════════════════════════════════════════════════════════════════════════

describe('forSource / project', () => {
  it('project extracts data from source', () => {
    const p = forSource<Source>().project(nameSlot, (s) => s.name);
    expect(p.slot).toBe(nameSlot);
    expect(p.extract({ name: 'Alice' })).toBe('Alice');
  });

  it('project returns null when data absent', () => {
    const p = forSource<Source>().project(ageSlot, (s) => s.age ?? null);
    expect(p.extract({ name: 'Bob' })).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// applyProjections
// ═══════════════════════════════════════════════════════════════════════════

describe('applyProjections', () => {
  it('fills bag with non-null values', () => {
    const projections = [
      forSource<Source>().project(nameSlot, (s) => s.name),
      forSource<Source>().project(ageSlot, (s) => s.age ?? null),
    ];
    const bag = new ContextBag();
    const count = applyProjections(bag, { name: 'Alice' }, projections);
    expect(count).toBe(1); // age is null → skipped
    expect(bag.has(nameSlot)).toBe(true);
    expect(bag.has(ageSlot)).toBe(false);
  });

  it('skips undefined values', () => {
    const projections = [forSource<Source>().project(ageSlot, (s) => s.age)];
    const bag = new ContextBag();
    applyProjections(bag, { name: 'Alice' }, projections);
    expect(bag.has(ageSlot)).toBe(false);
  });

  it('returns filled count', () => {
    const projections = [
      forSource<Source>().project(nameSlot, (s) => s.name),
      forSource<Source>().project(ageSlot, (s) => s.age ?? null),
    ];
    const count = applyProjections(new ContextBag(), { name: 'A', age: 25 }, projections);
    expect(count).toBe(2);
  });

  it('handles empty projections array', () => {
    const count = applyProjections(new ContextBag(), { name: 'A' }, []);
    expect(count).toBe(0);
  });

  it('data from projection is retrievable from bag', () => {
    const projections = [
      forSource<Source>().project(nameSlot, (s) => s.name),
      forSource<Source>().project(ageSlot, (s) => s.age ?? null),
    ];
    const bag = new ContextBag();
    applyProjections(bag, { name: 'Alice', age: 30 }, projections);

    const blocks = bag.compile({ fidelity: 'full' });
    expect(blocks).toHaveLength(2);
    expect(blocks.some((b) => b.content === 'Alice')).toBe(true);
    expect(blocks.some((b) => b.content === 'age=30')).toBe(true);
  });
});
