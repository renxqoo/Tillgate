/**
 * 北京时间日界口径:
 * 面板/计价面向中国时区——UTC 零点切日会把早 8 点前的量算进昨日。
 * 中国标准时间无夏令时,固定 +8h 偏移是口径常量而非可配值。
 * SQL 侧同名口径 = adapters/postgres/usage-store 的 at time zone 'Asia/Shanghai'。
 */

/** 中国标准时间固定 UTC 偏移(+8h;无夏令时) */
export const BEIJING_ZONE_OFFSET_MS = 8 * 3_600_000;

/** 一天毫秒数(趋势窗口步进) */
export const DAY_MS = 86_400_000;

/**
 * now 所在的北京时间日界时刻(该日的 UTC 00:00 起点减去 8h 偏移)。
 * 公式:bj = now + 8h;since = UTC(bj 的年月日零点) - 8h。
 */
export function beijingDayStart(now: Date): Date {
  const bj = new Date(now.getTime() + BEIJING_ZONE_OFFSET_MS);
  return new Date(
    Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - BEIJING_ZONE_OFFSET_MS,
  );
}

/** 近 N 天趋势下界(含今日,共 N 天;日界与 beijingDayStart 同口径) */
export function beijingTrendsFrom(days: number, now: Date): Date {
  return new Date(beijingDayStart(now).getTime() - (days - 1) * DAY_MS);
}

/**
 * now 的北京日历日键(YYYY-MM-DD)。
 * 与 SQL 侧 to_char(... at time zone 'Asia/Shanghai') 同口径——补零窗口按此键对齐稀疏行。
 */
export function beijingDayKey(now: Date): string {
  return new Date(now.getTime() + BEIJING_ZONE_OFFSET_MS).toISOString().slice(0, 10);
}
