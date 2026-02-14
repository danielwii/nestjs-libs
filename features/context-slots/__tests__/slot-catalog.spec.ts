/**
 * SlotCatalog unit tests.
 *
 * 覆盖：register/get/list/listByCategory/describe/createBag。
 */

import { defineSlot } from '../context-slot.types';
import { SlotCatalog } from '../slot-catalog';

import { describe, expect, it } from 'bun:test';

// ═══════════════════════════════════════════════════════════════════════════
// 测试用 Slot 定义
// ═══════════════════════════════════════════════════════════════════════════

const PersonalitySlot = defineSlot<{ text: string }>({
  id: 'personality',
  title: '性格',
  description: '角色性格描述',
  category: 'identity',
  priority: 95,
  renderers: {
    full: (d) => d.text,
    compact: (d) => d.text,
  },
});

const EmotionSlot = defineSlot<{ joy: number }>({
  id: 'emotion',
  title: '情绪',
  description: '当前情绪',
  category: 'state',
  priority: 80,
  volatility: 'turn',
  renderers: {
    full: (d) => `joy=${d.joy}`,
  },
});

const RelationshipSlot = defineSlot<{ tier: string }>({
  id: 'relationship',
  title: '关系',
  description: '关系状态',
  category: 'state',
  priority: 90,
  volatility: 'session',
  renderers: {
    full: (d) => d.tier,
    compact: (d) => d.tier,
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// register / get / list
// ═══════════════════════════════════════════════════════════════════════════

describe('SlotCatalog — 基础操作', () => {
  it('register 后 get 返回 slot', () => {
    const catalog = new SlotCatalog();
    catalog.register(PersonalitySlot);

    expect(catalog.get('personality')).toBeDefined();
    expect(catalog.get('personality')?.title).toBe('性格');
  });

  it('get 不存在的 id 返回 undefined', () => {
    const catalog = new SlotCatalog();
    expect(catalog.get('nonexistent')).toBeUndefined();
  });

  it('重复 register 同一 id 抛出错误', () => {
    const catalog = new SlotCatalog();
    catalog.register(PersonalitySlot);

    expect(() => catalog.register(PersonalitySlot)).toThrow('SlotCatalog: duplicate slot id "personality"');
  });

  it('list 返回所有已注册 slot', () => {
    const catalog = new SlotCatalog();
    catalog.register(PersonalitySlot);
    catalog.register(EmotionSlot);

    const all = catalog.list();
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.id)).toEqual(['personality', 'emotion']);
  });

  it('listByCategory 过滤指定分类', () => {
    const catalog = new SlotCatalog();
    catalog.register(PersonalitySlot); // identity
    catalog.register(EmotionSlot); // state
    catalog.register(RelationshipSlot); // state

    const stateSlots = catalog.listByCategory('state');
    expect(stateSlots).toHaveLength(2);
    expect(stateSlots.map((s) => s.id)).toEqual(['emotion', 'relationship']);

    const identitySlots = catalog.listByCategory('identity');
    expect(identitySlots).toHaveLength(1);

    const emptyCategory = catalog.listByCategory('nonexistent');
    expect(emptyCategory).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// describe
// ═══════════════════════════════════════════════════════════════════════════

describe('SlotCatalog — describe', () => {
  it('输出完整元信息', () => {
    const catalog = new SlotCatalog();
    catalog.register(PersonalitySlot);
    catalog.register(EmotionSlot);

    const desc = catalog.describe();

    expect(desc.totalSlots).toBe(2);
    expect(desc.categories).toEqual({
      identity: ['personality'],
      state: ['emotion'],
    });
    expect(desc.slots).toHaveLength(2);

    const personalityDesc = desc.slots.find((s) => s.id === 'personality');
    expect(personalityDesc).toBeDefined();
    expect(personalityDesc?.fidelities).toEqual(['full', 'compact']);
    expect(personalityDesc?.volatility).toBeUndefined();

    const emotionDesc = desc.slots.find((s) => s.id === 'emotion');
    expect(emotionDesc?.fidelities).toEqual(['full']);
    expect(emotionDesc?.volatility).toBe('turn');
  });

  it('空 catalog 返回空描述', () => {
    const catalog = new SlotCatalog();
    const desc = catalog.describe();

    expect(desc.totalSlots).toBe(0);
    expect(desc.categories).toEqual({});
    expect(desc.slots).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createBag
// ═══════════════════════════════════════════════════════════════════════════

describe('SlotCatalog — createBag', () => {
  it('创建的 bag 可以正常 fill 和 compile', () => {
    const catalog = new SlotCatalog();
    catalog.register(PersonalitySlot);
    catalog.register(EmotionSlot);

    const bag = catalog.createBag();
    bag.fill(PersonalitySlot, { text: '活泼' });

    const result = bag.compile({ fidelity: 'full' });
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe('活泼');
  });

  it('创建的 bag inspect 能报告未 fill 的 slot', () => {
    const catalog = new SlotCatalog();
    catalog.register(PersonalitySlot);
    catalog.register(EmotionSlot);
    catalog.register(RelationshipSlot);

    const bag = catalog.createBag();
    bag.fill(PersonalitySlot, { text: '活泼' });

    const info = bag.inspect();
    expect(info.filledSlots).toEqual(['personality']);
    expect(info.unfilledSlots).toContain('emotion');
    expect(info.unfilledSlots).toContain('relationship');
  });
});
