/**
 * ContextBag unit tests.
 *
 * 覆盖：fill/get/has、compile 行为（顺序、过滤、裁剪）、inspect。
 */

import { ContextBag } from '../context-bag';
import { defineSlot } from '../context-slot.types';

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
    full: (d) => `性格(full): ${d.text}`,
    compact: (d) => `性格: ${d.text}`,
  },
});

const EmotionSlot = defineSlot<{ joy: number; sadness: number }>({
  id: 'emotion',
  title: '情绪',
  description: '当前情绪状态',
  category: 'state',
  priority: 80,
  renderers: {
    full: (d) => `joy=${d.joy}, sadness=${d.sadness}`,
    compact: (d) => `J${d.joy}/S${d.sadness}`,
  },
});

const ChannelSlot = defineSlot<{ platform: string }>({
  id: 'channel',
  title: '通信来源',
  description: '对方通过什么渠道联系',
  category: 'ambient',
  priority: 60,
  renderers: {
    full: (d) => `通过 ${d.platform} 联系`,
    compact: (d) => d.platform,
  },
});

/** 只有 full，没有 compact */
const FullOnlySlot = defineSlot<{ text: string }>({
  id: 'fullOnly',
  title: '仅Full',
  description: '测试用',
  category: 'signal',
  priority: 50,
  renderers: {
    full: (d) => d.text,
  },
});

/** renderer 返回 null（条件跳过） */
const ConditionalSlot = defineSlot<{ activated: boolean; detail: string }>({
  id: 'conditional',
  title: '条件',
  description: '测试条件跳过',
  category: 'depth',
  priority: 70,
  renderers: {
    full: (d) => (d.activated ? d.detail : null),
    compact: (d) => (d.activated ? d.detail : null),
  },
});

/** renderer 返回空字符串 */
const EmptySlot = defineSlot<{ text: string }>({
  id: 'empty',
  title: '空',
  description: '测试空内容跳过',
  category: 'system',
  priority: 30,
  renderers: {
    full: () => '',
    compact: () => '   ',
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// fill / get / has
// ═══════════════════════════════════════════════════════════════════════════

describe('ContextBag — fill/get/has', () => {
  it('fill 后 get 返回正确类型的数据', () => {
    const bag = new ContextBag();
    bag.fill(PersonalitySlot, { text: '活泼' });

    const result = bag.get(PersonalitySlot);
    expect(result).toEqual({ text: '活泼' });
  });

  it('未 fill 的 slot get 返回 undefined', () => {
    const bag = new ContextBag();
    expect(bag.get(PersonalitySlot)).toBeUndefined();
  });

  it('has 正确判断是否已 fill', () => {
    const bag = new ContextBag();
    expect(bag.has(PersonalitySlot)).toBe(false);

    bag.fill(PersonalitySlot, { text: '活泼' });
    expect(bag.has(PersonalitySlot)).toBe(true);
  });

  it('重复 fill 同一 slot 覆盖 data', () => {
    const bag = new ContextBag();
    bag.fill(PersonalitySlot, { text: '第一次' });
    bag.fill(PersonalitySlot, { text: '覆盖' });

    expect(bag.get(PersonalitySlot)).toEqual({ text: '覆盖' });
  });

  it('fill 返回 this（链式调用）', () => {
    const bag = new ContextBag();
    const result = bag.fill(PersonalitySlot, { text: 'A' }).fill(EmotionSlot, { joy: 0.8, sadness: 0.1 });

    expect(result).toBe(bag);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// compile — 基本行为
// ═══════════════════════════════════════════════════════════════════════════

describe('ContextBag — compile 基本行为', () => {
  it('输出顺序 = fill 顺序', () => {
    const bag = new ContextBag();
    bag.fill(ChannelSlot, { platform: 'Telegram' }); // priority 60
    bag.fill(PersonalitySlot, { text: '活泼' }); // priority 95
    bag.fill(EmotionSlot, { joy: 0.8, sadness: 0.1 }); // priority 80

    const result = bag.compile({ fidelity: 'full' });

    expect(result).toHaveLength(3);
    expect(result[0]?.id).toBe('channel'); // fill 顺序第一
    expect(result[1]?.id).toBe('personality'); // fill 顺序第二
    expect(result[2]?.id).toBe('emotion'); // fill 顺序第三
  });

  it('使用指定 fidelity 的 renderer', () => {
    const bag = new ContextBag();
    bag.fill(PersonalitySlot, { text: '活泼' });

    const full = bag.compile({ fidelity: 'full' });
    const compact = bag.compile({ fidelity: 'compact' });

    expect(full[0]?.content).toBe('性格(full): 活泼');
    expect(compact[0]?.content).toBe('性格: 活泼');
  });

  it('CompiledBlock 包含完整元信息', () => {
    const bag = new ContextBag();
    bag.fill(PersonalitySlot, { text: '活泼' });

    const result = bag.compile({ fidelity: 'full' });

    expect(result[0]).toEqual({
      id: 'personality',
      title: '性格',
      content: '性格(full): 活泼',
      priority: 95,
      category: 'identity',
    });
  });

  it('空 bag 编译返回空数组', () => {
    const bag = new ContextBag();
    expect(bag.compile({ fidelity: 'full' })).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// compile — 过滤行为
// ═══════════════════════════════════════════════════════════════════════════

describe('ContextBag — compile 过滤', () => {
  it('跳过 fidelity 不存在的 renderer', () => {
    const bag = new ContextBag();
    bag.fill(FullOnlySlot, { text: '只有full' });

    expect(bag.compile({ fidelity: 'full' })).toHaveLength(1);
    expect(bag.compile({ fidelity: 'compact' })).toHaveLength(0);
  });

  it('renderer 返回 null 时跳过', () => {
    const bag = new ContextBag();
    bag.fill(ConditionalSlot, { activated: false, detail: '不应出现' });

    expect(bag.compile({ fidelity: 'full' })).toHaveLength(0);
  });

  it('renderer 返回非 null 时保留', () => {
    const bag = new ContextBag();
    bag.fill(ConditionalSlot, { activated: true, detail: '防御触发' });

    const result = bag.compile({ fidelity: 'full' });
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe('防御触发');
  });

  it('renderer 返回空字符串/纯空白时跳过', () => {
    const bag = new ContextBag();
    bag.fill(EmptySlot, { text: '' });

    expect(bag.compile({ fidelity: 'full' })).toHaveLength(0);
    expect(bag.compile({ fidelity: 'compact' })).toHaveLength(0);
  });

  it('minPriority 过滤低优先级 slot', () => {
    const bag = new ContextBag();
    bag.fill(PersonalitySlot, { text: 'A' }); // 95
    bag.fill(EmotionSlot, { joy: 0.5, sadness: 0.3 }); // 80
    bag.fill(ChannelSlot, { platform: 'Telegram' }); // 60

    const result = bag.compile({ fidelity: 'full', minPriority: 70 });
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('personality');
    expect(result[1]?.id).toBe('emotion');
  });

  it('categories 过滤指定分类', () => {
    const bag = new ContextBag();
    bag.fill(PersonalitySlot, { text: 'A' }); // identity
    bag.fill(EmotionSlot, { joy: 0.5, sadness: 0.3 }); // state
    bag.fill(ChannelSlot, { platform: 'Telegram' }); // ambient

    const result = bag.compile({ fidelity: 'full', categories: ['identity', 'ambient'] });
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('personality');
    expect(result[1]?.id).toBe('channel');
  });

  it('exclude 排除指定 slot', () => {
    const bag = new ContextBag();
    bag.fill(PersonalitySlot, { text: 'A' });
    bag.fill(EmotionSlot, { joy: 0.5, sadness: 0.3 });

    const result = bag.compile({ fidelity: 'full', exclude: ['emotion'] });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('personality');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// compile — maxSlots 裁剪
// ═══════════════════════════════════════════════════════════════════════════

describe('ContextBag — compile maxSlots', () => {
  function fillAll(bag: ContextBag): void {
    bag.fill(ChannelSlot, { platform: 'Telegram' }); // p60, fill#0
    bag.fill(PersonalitySlot, { text: 'A' }); // p95, fill#1
    bag.fill(EmotionSlot, { joy: 0.5, sadness: 0.3 }); // p80, fill#2
  }

  it('按 priority 选择 keeper，保持 fill 顺序输出', () => {
    const bag = new ContextBag();
    fillAll(bag);

    const result = bag.compile({ fidelity: 'full', maxSlots: 2 });

    // keeper: personality(95) + emotion(80)，但输出按 fill 顺序
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('personality'); // fill#1, 但 channel 被裁掉
    expect(result[1]?.id).toBe('emotion'); // fill#2
  });

  it('maxSlots=1 只保留最高 priority', () => {
    const bag = new ContextBag();
    fillAll(bag);

    const result = bag.compile({ fidelity: 'full', maxSlots: 1 });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('personality');
  });

  it('maxSlots 大于可用数量时不影响结果', () => {
    const bag = new ContextBag();
    fillAll(bag);

    const result = bag.compile({ fidelity: 'full', maxSlots: 100 });
    expect(result).toHaveLength(3);
  });

  it('maxSlots=0 返回空数组', () => {
    const bag = new ContextBag();
    fillAll(bag);

    expect(bag.compile({ fidelity: 'full', maxSlots: 0 })).toEqual([]);
  });

  it('同 priority 按 fill 顺序 tie-break', () => {
    const SlotA = defineSlot<{ v: string }>({
      id: 'a',
      title: 'A',
      description: '',
      category: 'test',
      priority: 50,
      renderers: { full: (d) => d.v },
    });
    const SlotB = defineSlot<{ v: string }>({
      id: 'b',
      title: 'B',
      description: '',
      category: 'test',
      priority: 50,
      renderers: { full: (d) => d.v },
    });
    const SlotC = defineSlot<{ v: string }>({
      id: 'c',
      title: 'C',
      description: '',
      category: 'test',
      priority: 50,
      renderers: { full: (d) => d.v },
    });

    const bag = new ContextBag();
    bag.fill(SlotA, { v: 'a' }); // fill#0
    bag.fill(SlotB, { v: 'b' }); // fill#1
    bag.fill(SlotC, { v: 'c' }); // fill#2

    const result = bag.compile({ fidelity: 'full', maxSlots: 2 });

    // 同 priority，fill 顺序靠前的优先保留
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('a');
    expect(result[1]?.id).toBe('b');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// compile — maxTokens 裁剪
// ═══════════════════════════════════════════════════════════════════════════

describe('ContextBag — compile maxTokens', () => {
  // 自定义估算器：1 char = 1 token（方便测试）
  const charEstimator = (text: string) => text.length;

  it('按 priority 贪心选择直到预算用完', () => {
    const S1 = defineSlot<string>({
      id: 's1',
      title: 'S1',
      description: '',
      category: 'test',
      priority: 90,
      renderers: { full: (d) => d }, // 内容即 data
    });
    const S2 = defineSlot<string>({
      id: 's2',
      title: 'S2',
      description: '',
      category: 'test',
      priority: 80,
      renderers: { full: (d) => d },
    });
    const S3 = defineSlot<string>({
      id: 's3',
      title: 'S3',
      description: '',
      category: 'test',
      priority: 70,
      renderers: { full: (d) => d },
    });

    const bag = new ContextBag();
    bag.fill(S1, 'aaaa'); // 4 tokens, priority 90
    bag.fill(S2, 'bbb'); // 3 tokens, priority 80
    bag.fill(S3, 'cc'); // 2 tokens, priority 70

    // 预算 7: S1(4) + S2(3) = 7, S3 放不下
    const result = bag.compile({ fidelity: 'full', maxTokens: 7, tokenEstimator: charEstimator });

    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('s1');
    expect(result[1]?.id).toBe('s2');
  });

  it('跳过超预算 slot，选择更小的 slot', () => {
    const Big = defineSlot<string>({
      id: 'big',
      title: 'Big',
      description: '',
      category: 'test',
      priority: 90,
      renderers: { full: (d) => d },
    });
    const Small = defineSlot<string>({
      id: 'small',
      title: 'Small',
      description: '',
      category: 'test',
      priority: 80,
      renderers: { full: (d) => d },
    });

    const bag = new ContextBag();
    bag.fill(Big, 'a'.repeat(100)); // 100 tokens
    bag.fill(Small, 'bb'); // 2 tokens

    // 预算 10: Big 放不下，Small 可以
    const result = bag.compile({ fidelity: 'full', maxTokens: 10, tokenEstimator: charEstimator });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('small');
  });

  it('所有 slot 单个都超预算 → 返回空数组', () => {
    const S1 = defineSlot<string>({
      id: 's1',
      title: 'S1',
      description: '',
      category: 'test',
      priority: 90,
      renderers: { full: (d) => d },
    });
    const S2 = defineSlot<string>({
      id: 's2',
      title: 'S2',
      description: '',
      category: 'test',
      priority: 80,
      renderers: { full: (d) => d },
    });

    const bag = new ContextBag();
    bag.fill(S1, 'a'.repeat(100));
    bag.fill(S2, 'b'.repeat(100));

    const result = bag.compile({ fidelity: 'full', maxTokens: 5, tokenEstimator: charEstimator });
    expect(result).toEqual([]);
  });

  it('maxTokens=0 返回空数组', () => {
    const bag = new ContextBag();
    bag.fill(PersonalitySlot, { text: 'A' });

    expect(bag.compile({ fidelity: 'full', maxTokens: 0 })).toEqual([]);
  });

  it('默认 token 估算器（chars/2）', () => {
    const S1 = defineSlot<string>({
      id: 's1',
      title: 'S1',
      description: '',
      category: 'test',
      priority: 90,
      renderers: { full: (d) => d },
    });

    const bag = new ContextBag();
    bag.fill(S1, 'a'.repeat(20)); // 20 chars → ~10 tokens

    // 预算 5: 10 tokens > 5 → 空
    const result = bag.compile({ fidelity: 'full', maxTokens: 5 });
    expect(result).toEqual([]);

    // 预算 15: 10 tokens < 15 → 保留
    const result2 = bag.compile({ fidelity: 'full', maxTokens: 15 });
    expect(result2).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// compile — 重复 fill
// ═══════════════════════════════════════════════════════════════════════════

describe('ContextBag — 重复 fill', () => {
  it('重复 fill 覆盖 data，保留原始 fill 位置', () => {
    const bag = new ContextBag();
    bag.fill(PersonalitySlot, { text: '第一次' }); // fill#0
    bag.fill(EmotionSlot, { joy: 0.5, sadness: 0.3 }); // fill#1
    bag.fill(PersonalitySlot, { text: '覆盖' }); // 覆盖 fill#0

    const result = bag.compile({ fidelity: 'full' });

    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('personality'); // 保持 fill#0 位置
    expect(result[0]?.content).toBe('性格(full): 覆盖'); // data 已覆盖
    expect(result[1]?.id).toBe('emotion'); // fill#1
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// inspect
// ═══════════════════════════════════════════════════════════════════════════

describe('ContextBag — inspect', () => {
  it('列出已填充的 slot', () => {
    const bag = new ContextBag();
    bag.fill(PersonalitySlot, { text: 'A' });
    bag.fill(EmotionSlot, { joy: 0.5, sadness: 0.3 });

    const info = bag.inspect();

    expect(info.filledSlots).toEqual(['personality', 'emotion']);
    expect(info.categoryCounts).toEqual({ identity: 1, state: 1 });
  });

  it('无 catalog 时 unfilledSlots 为空', () => {
    const bag = new ContextBag();
    bag.fill(PersonalitySlot, { text: 'A' });

    expect(bag.inspect().unfilledSlots).toEqual([]);
  });

  it('有 catalog 时报告未 fill 的 slot', () => {
    const registered = new Set(['personality', 'emotion', 'channel']);
    const bag = new ContextBag(registered);
    bag.fill(PersonalitySlot, { text: 'A' });

    const info = bag.inspect();

    expect(info.filledSlots).toEqual(['personality']);
    expect(info.unfilledSlots).toContain('emotion');
    expect(info.unfilledSlots).toContain('channel');
    expect(info.unfilledSlots).not.toContain('personality');
  });
});
