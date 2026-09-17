import { normalizeTimezone } from './datetime';

import { describe, expect, it } from 'bun:test';

/**
 * 渲染侧时区宽容层的测试。
 *
 * 设计意图：
 * - 验证有效时区格式被保留（IANA 和偏移格式）
 * - 验证无效格式返回 null，由调用方决定回落
 * - 偏移量原样放行是本模块的既定行为，不是疏漏——它只服务渲染，不服务归属
 */
describe('timezone.helper', () => {
  describe('normalizeTimezone', () => {
    describe('偏移格式：标准化为 +HH:MM（formatInTimeZone 要求）', () => {
      it('应该标准化 "+8" 为 "+08:00"', () => {
        expect(normalizeTimezone('+8')).toBe('+08:00');
      });

      it('应该标准化 "-5" 为 "-05:00"', () => {
        expect(normalizeTimezone('-5')).toBe('-05:00');
      });

      it('应该标准化 "+0" 为 "+00:00"', () => {
        expect(normalizeTimezone('+0')).toBe('+00:00');
      });

      it('应该保留 "+08:00"', () => {
        expect(normalizeTimezone('+08:00')).toBe('+08:00');
      });

      it('应该保留 "-05:00"', () => {
        expect(normalizeTimezone('-05:00')).toBe('-05:00');
      });

      it('应该保留 "+05:30" (印度)', () => {
        expect(normalizeTimezone('+05:30')).toBe('+05:30');
      });

      it('应该保留 "-06:00" (美中)', () => {
        expect(normalizeTimezone('-06:00')).toBe('-06:00');
      });

      it('应该标准化无符号格式 "8" 为 "+08:00"', () => {
        expect(normalizeTimezone('8')).toBe('+08:00');
      });
    });

    describe('IANA 格式：直接返回', () => {
      it('应该保持 "Asia/Shanghai" 不变', () => {
        expect(normalizeTimezone('Asia/Shanghai')).toBe('Asia/Shanghai');
      });

      it('应该保持 "America/New_York" 不变', () => {
        expect(normalizeTimezone('America/New_York')).toBe('America/New_York');
      });

      it('应该保持 "Europe/London" 不变', () => {
        expect(normalizeTimezone('Europe/London')).toBe('Europe/London');
      });

      it('应该保持 "UTC" 不变', () => {
        expect(normalizeTimezone('UTC')).toBe('UTC');
      });

      it('应该保持 "GMT" 不变', () => {
        expect(normalizeTimezone('GMT')).toBe('GMT');
      });
    });

    describe('边界情况', () => {
      it('应该将 null 转换为 null', () => {
        expect(normalizeTimezone(null)).toBe(null);
      });

      it('应该将 undefined 转换为 null', () => {
        expect(normalizeTimezone(undefined)).toBe(null);
      });

      it('应该将空字符串转换为 null', () => {
        expect(normalizeTimezone('')).toBe(null);
      });

      it('应该将空白字符串转换为 null', () => {
        expect(normalizeTimezone('   ')).toBe(null);
      });
    });

    describe('无效格式', () => {
      it('应该将无效格式 "+99:99" 转换为 null', () => {
        expect(normalizeTimezone('+99:99')).toBe(null);
      });

      it('应该将无效格式 "invalid" 转换为 null', () => {
        expect(normalizeTimezone('invalid')).toBe(null);
      });

      it('应该将三位数偏移 "+999" 转换为 null', () => {
        expect(normalizeTimezone('+999')).toBe(null);
      });
    });

    describe('去除前后空格', () => {
      it('应该正确处理带空格的 " +8 "', () => {
        expect(normalizeTimezone(' +8 ')).toBe('+08:00');
      });

      it('应该正确处理带空格的 " Asia/Shanghai "', () => {
        expect(normalizeTimezone(' Asia/Shanghai ')).toBe('Asia/Shanghai');
      });
    });
  });
});
