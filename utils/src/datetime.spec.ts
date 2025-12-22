import { normalizeTimezone, parseTimezoneOffset } from './datetime';

/**
 * 时区规范化工具测试
 *
 * 设计意图：
 * - 验证三种时区格式的正确转换
 * - 确保兜底逻辑正常工作
 * - 覆盖边界情况和无效输入
 */
describe('timezone.helper', () => {
  describe('normalizeTimezone', () => {
    describe('旧格式："+8" / "-5"', () => {
      it('应该正确转换 "+8" 为 "Asia/Shanghai"', () => {
        expect(normalizeTimezone('+8')).toBe('Asia/Shanghai');
      });

      it('应该正确转换 "-5" 为 "America/New_York"', () => {
        expect(normalizeTimezone('-5')).toBe('America/New_York');
      });

      it('应该正确转换 "+0" 为 "Europe/London"', () => {
        expect(normalizeTimezone('+0')).toBe('Europe/London');
      });

      it('应该正确转换 "+9" 为 "Asia/Tokyo"', () => {
        expect(normalizeTimezone('+9')).toBe('Asia/Tokyo');
      });
    });

    describe('新格式："+08:00" / "-05:30"', () => {
      it('应该正确转换 "+08:00" 为 "Asia/Shanghai"', () => {
        expect(normalizeTimezone('+08:00')).toBe('Asia/Shanghai');
      });

      it('应该正确转换 "-05:00" 为 "America/New_York"', () => {
        expect(normalizeTimezone('-05:00')).toBe('America/New_York');
      });

      it('应该正确转换 "+05:30" 为 "Asia/Kolkata" (印度)', () => {
        expect(normalizeTimezone('+05:30')).toBe('Asia/Kolkata');
      });

      it('应该正确转换 "+00:00" 为 "Europe/London"', () => {
        expect(normalizeTimezone('+00:00')).toBe('Europe/London');
      });

      it('应该正确转换 "+09:00" 为 "Asia/Tokyo"', () => {
        expect(normalizeTimezone('+09:00')).toBe('Asia/Tokyo');
      });
    });

    describe('IANA 格式', () => {
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

      it('应该将无法识别的偏移量转换为 null', () => {
        expect(normalizeTimezone('+99')).toBe(null);
      });
    });

    describe('特殊时区', () => {
      it('应该支持半小时偏移 "+5:30"', () => {
        expect(normalizeTimezone('+5:30')).toBe('Asia/Kolkata');
      });

      it('应该支持负时区 "-8" (美西)', () => {
        expect(normalizeTimezone('-8')).toBe('America/Los_Angeles');
      });

      it('应该支持负时区 "-08:00" (美西)', () => {
        expect(normalizeTimezone('-08:00')).toBe('America/Los_Angeles');
      });
    });

    describe('去除前后空格', () => {
      it('应该正确处理带空格的 " +8 "', () => {
        expect(normalizeTimezone(' +8 ')).toBe('Asia/Shanghai');
      });

      it('应该正确处理带空格的 " Asia/Shanghai "', () => {
        expect(normalizeTimezone(' Asia/Shanghai ')).toBe('Asia/Shanghai');
      });
    });
  });

  describe('parseTimezoneOffset', () => {
    describe('旧格式解析', () => {
      it('应该正确解析 "+8" 为 8', () => {
        expect(parseTimezoneOffset('+8')).toBe(8);
      });

      it('应该正确解析 "-5" 为 -5', () => {
        expect(parseTimezoneOffset('-5')).toBe(-5);
      });

      it('应该正确解析 "+0" 为 0', () => {
        expect(parseTimezoneOffset('+0')).toBe(0);
      });
    });

    describe('新格式解析', () => {
      it('应该正确解析 "+08:00" 为 8', () => {
        expect(parseTimezoneOffset('+08:00')).toBe(8);
      });

      it('应该正确解析 "-05:00" 为 -5', () => {
        expect(parseTimezoneOffset('-05:00')).toBe(-5);
      });

      it('应该正确解析 "+05:30" 为 5.5', () => {
        expect(parseTimezoneOffset('+05:30')).toBe(5.5);
      });

      it('应该正确解析 "-05:30" 为 -5.5', () => {
        expect(parseTimezoneOffset('-05:30')).toBe(-5.5);
      });
    });

    describe('默认值', () => {
      it('应该将 null 返回默认值 8', () => {
        expect(parseTimezoneOffset(null)).toBe(8);
      });

      it('应该将 undefined 返回默认值 8', () => {
        expect(parseTimezoneOffset(undefined)).toBe(8);
      });

      it('应该将无效格式返回默认值 8', () => {
        expect(parseTimezoneOffset('invalid')).toBe(8);
      });
    });
  });
});
