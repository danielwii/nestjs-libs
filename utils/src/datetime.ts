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
 */
const OFFSET_TO_IANA_MAP: Record<string, string> = {
  // UTC 和欧洲
  '+0': 'Europe/London',
  '+00:00': 'Europe/London',
  '+1': 'Europe/Paris',
  '+01:00': 'Europe/Paris',
  '+2': 'Europe/Athens',
  '+02:00': 'Europe/Athens',
  '+3': 'Europe/Moscow',
  '+03:00': 'Europe/Moscow',
  '+4': 'Asia/Dubai',
  '+04:00': 'Asia/Dubai',
  '+5': 'Asia/Karachi',
  '+05:00': 'Asia/Karachi',
  '+5:30': 'Asia/Kolkata',
  '+05:30': 'Asia/Kolkata',
  '+6': 'Asia/Dhaka',
  '+06:00': 'Asia/Dhaka',
  '+7': 'Asia/Bangkok',
  '+07:00': 'Asia/Bangkok',
  '+8': 'Asia/Shanghai',
  '+08:00': 'Asia/Shanghai',
  '+9': 'Asia/Tokyo',
  '+09:00': 'Asia/Tokyo',
  '+10': 'Australia/Sydney',
  '+10:00': 'Australia/Sydney',
  '+11': 'Pacific/Noumea',
  '+11:00': 'Pacific/Noumea',
  '+12': 'Pacific/Auckland',
  '+12:00': 'Pacific/Auckland',

  // 西半球
  '-5': 'America/New_York',
  '-05:00': 'America/New_York',
  '-6': 'America/Chicago',
  '-06:00': 'America/Chicago',
  '-7': 'America/Denver',
  '-07:00': 'America/Denver',
  '-8': 'America/Los_Angeles',
  '-08:00': 'America/Los_Angeles',
  '-4': 'America/Santiago',
  '-04:00': 'America/Santiago',
  '-3': 'America/Sao_Paulo',
  '-03:00': 'America/Sao_Paulo',
};

function isIANATimezone(tz: string): boolean {
  if (tz.includes('/')) return true;
  const specialTimezones = ['UTC', 'GMT'];
  return specialTimezones.includes(tz);
}

export function normalizeTimezone(timezone: string | null | undefined): string | null {
  if (!timezone) return null;
  const tz = timezone.trim();
  if (!tz) return null;
  if (isIANATimezone(tz)) return tz;
  return OFFSET_TO_IANA_MAP[tz] || null;
}

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

export function parseTimezoneOffset(timezone: string | null | undefined): number {
  if (!timezone) return 8;
  const tz = timezone.trim();
  const match = tz.match(/^([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return 8;
  const sign = match[1] === '+' ? 1 : -1;
  const hours = parseInt(match[2], 10);
  const minutes = match[3] ? parseInt(match[3], 10) : 0;
  return sign * (hours + minutes / 60);
}

// YMD 相关的逻辑从原 utils.ts 移动过来

const YMD_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

export function formatDateToYmd(date: Date | null | undefined): string | null {
  if (!date) return null;
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const mm = month.toString().padStart(2, '0');
  const dd = day.toString().padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

export function parseYmdToUtcDate(value: string): Date {
  const match = YMD_REGEX.exec(value);
  if (!match) throw new Error('Invalid YMD format');
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('Invalid YMD calendar date');
  }
  return date;
}

export function isValidYmdDate(value: string): boolean {
  try {
    parseYmdToUtcDate(value);
    return true;
  } catch {
    return false;
  }
}
