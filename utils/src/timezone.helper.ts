/**
 * 时区处理工具函数
 *
 * 设计意图：
 * - 统一处理系统中存在的三种时区格式
 * - 为 formatInTimeZone 提供兼容的 IANA 时区格式
 * - 保持向后兼容性，不破坏现有业务逻辑
 */

/**
 * 常见时区偏移量到 IANA 时区的映射
 *
 * 设计理念：
 * - 选择每个时区最具代表性的城市
 * - 考虑夏令时：使用不实行夏令时或以标准时间为主的地区
 * - 优先选择人口密集、经济发达的地区
 */
const OFFSET_TO_IANA_MAP: Record<string, string> = {
  // UTC 和欧洲
  '+0': 'Europe/London', // UTC+0
  '+00:00': 'Europe/London',
  '+1': 'Europe/Paris', // UTC+1
  '+01:00': 'Europe/Paris',
  '+2': 'Europe/Athens', // UTC+2
  '+02:00': 'Europe/Athens',
  '+3': 'Europe/Moscow', // UTC+3
  '+03:00': 'Europe/Moscow',
  '+4': 'Asia/Dubai', // UTC+4
  '+04:00': 'Asia/Dubai',
  '+5': 'Asia/Karachi', // UTC+5
  '+05:00': 'Asia/Karachi',
  '+5:30': 'Asia/Kolkata', // UTC+5:30 (印度)
  '+05:30': 'Asia/Kolkata',
  '+6': 'Asia/Dhaka', // UTC+6
  '+06:00': 'Asia/Dhaka',
  '+7': 'Asia/Bangkok', // UTC+7
  '+07:00': 'Asia/Bangkok',
  '+8': 'Asia/Shanghai', // UTC+8 (中国)
  '+08:00': 'Asia/Shanghai',
  '+9': 'Asia/Tokyo', // UTC+9 (日本)
  '+09:00': 'Asia/Tokyo',
  '+10': 'Australia/Sydney', // UTC+10
  '+10:00': 'Australia/Sydney',
  '+11': 'Pacific/Noumea', // UTC+11
  '+11:00': 'Pacific/Noumea',
  '+12': 'Pacific/Auckland', // UTC+12 (新西兰)
  '+12:00': 'Pacific/Auckland',

  // 西半球
  '-5': 'America/New_York', // UTC-5 (美东)
  '-05:00': 'America/New_York',
  '-6': 'America/Chicago', // UTC-6 (美中)
  '-06:00': 'America/Chicago',
  '-7': 'America/Denver', // UTC-7 (美山)
  '-07:00': 'America/Denver',
  '-8': 'America/Los_Angeles', // UTC-8 (美西)
  '-08:00': 'America/Los_Angeles',
  '-4': 'America/Santiago', // UTC-4
  '-04:00': 'America/Santiago',
  '-3': 'America/Sao_Paulo', // UTC-3 (巴西)
  '-03:00': 'America/Sao_Paulo',
};

/**
 * 检测字符串是否为 IANA 时区格式
 *
 * IANA 格式分两种：
 * 1. 区域/城市格式：如 "Asia/Shanghai"、"America/New_York"
 * 2. 特殊标识符：如 "UTC"、"GMT"
 *
 * 设计意图：支持所有标准 IANA 时区标识符
 */
function isIANATimezone(tz: string): boolean {
  // 区域/城市格式
  if (tz.includes('/')) return true;

  // 特殊 IANA 标识符
  const specialTimezones = ['UTC', 'GMT'];
  if (specialTimezones.includes(tz)) return true;

  return false;
}

/**
 * 规范化时区格式
 *
 * 支持三种输入格式：
 * 1. "+8" / "-5" （旧格式，只有小时）
 * 2. "+08:00" / "-05:30" （新格式，带分钟）
 * 3. "Asia/Shanghai" （IANA 格式）
 *
 * @param timezone 时区字符串（任意格式）
 * @returns IANA 格式的时区字符串，或 null（使用 UTC）
 *
 * @example
 * normalizeTimezone("+8")           // => "Asia/Shanghai"
 * normalizeTimezone("+08:00")       // => "Asia/Shanghai"
 * normalizeTimezone("Asia/Shanghai") // => "Asia/Shanghai"
 * normalizeTimezone(null)           // => null
 * normalizeTimezone("+99:99")       // => null (无效格式)
 */
export function normalizeTimezone(timezone: string | null | undefined): string | null {
  // null 或 undefined 直接返回 null（使用 UTC）
  if (!timezone) {
    return null;
  }

  const tz = timezone.trim();

  // 空字符串返回 null
  if (!tz) {
    return null;
  }

  // 如果已经是 IANA 格式，直接返回
  if (isIANATimezone(tz)) {
    return tz;
  }

  // 尝试从映射表查找
  const ianaTimezone = OFFSET_TO_IANA_MAP[tz];
  if (ianaTimezone) {
    return ianaTimezone;
  }

  // 无法识别的格式，返回 null（使用 UTC）
  // 这样不会抛错，但会 fallback 到 UTC
  return null;
}

/**
 * 安全地规范化时区（带日志）
 *
 * 用于需要追踪时区转换的场景
 *
 * @param timezone 时区字符串
 * @param logger 日志记录器（可选）
 * @param context 日志上下文（可选）
 */
export function normalizeTimezoneWithLog(
  timezone: string | null | undefined,
  logger?: { debug: (message: string) => void },
  context?: string,
): string | null {
  const result = normalizeTimezone(timezone);

  if (logger && timezone && result !== timezone) {
    const ctx = context ? `[${context}] ` : '';
    logger.debug(`${ctx}时区格式转换: "${timezone}" -> "${result || 'UTC'}"`);
  }

  return result;
}

/**
 * 解析偏移量格式的时区为小时数
 *
 * 用于需要数值计算的场景（如 diary 模块）
 *
 * @param timezone 时区字符串（如 "+8" 或 "+08:00"）
 * @returns 小时数偏移量，或 8（默认东八区）
 *
 * @example
 * parseTimezoneOffset("+8")      // => 8
 * parseTimezoneOffset("+08:00")  // => 8
 * parseTimezoneOffset("-05:30")  // => -5.5
 * parseTimezoneOffset(null)      // => 8 (默认)
 */
export function parseTimezoneOffset(timezone: string | null | undefined): number {
  if (!timezone) {
    return 8; // 默认东八区
  }

  const tz = timezone.trim();

  // 匹配 "+8" 或 "+08:00" 格式
  const match = tz.match(/^([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!match) {
    return 8; // 无法解析，返回默认值
  }

  const sign = match[1] === '+' ? 1 : -1;
  const hours = parseInt(match[2], 10);
  const minutes = match[3] ? parseInt(match[3], 10) : 0;

  return sign * (hours + minutes / 60);
}
