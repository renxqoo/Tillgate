/**
 * 近 14 日费用趋势窗口推导（可测）：窗口起点 = 起始日 00:00（DISPLAY_TZ 日界，
 * 不带时分秒——首日不再半桶），序列按日补零（无消费日不再从图上消失）。
 * 后端按日桶日界 = CLIENT_USAGE_TZ，与 DISPLAY_TZ 默认同源（config/display.ts）。
 */
import type { UsageDayRow } from '@tillgate/api-client';

import { todayKey } from './kpi';

/** 趋势窗口天数（含今日；概览图「近 14 天」口径） */
export const TREND_WINDOW_DAYS = 14;

/** 日期键减 N 天（yyyy-MM-dd；UTC 轴纯日历算术，无时区语义） */
export function dayKeyMinus(key: string, days: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** 指定时区在 at 时刻的 UTC 偏移（ms，东正西负） */
function tzOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (
    Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second'),
    ) - at.getTime()
  );
}

/** 指定时区某日期键当地 00:00 对应的时刻（两段式消偏——DST 边界偏移随日期变化也正确） */
export function zonedDayStart(key: string, timeZone: string): Date {
  const naive = new Date(`${key}T00:00:00Z`);
  const shifted = new Date(naive.getTime() - tzOffsetMs(naive, timeZone));
  return new Date(naive.getTime() - tzOffsetMs(shifted, timeZone));
}

/** 趋势窗口查询起点：起始日（今日 -(days-1)）当地 00:00 */
export function trendWindowFrom(days: number, timeZone: string, now: Date = new Date()): Date {
  return zonedDayStart(dayKeyMinus(todayKey(timeZone, now), days - 1), timeZone);
}

export interface DailyCostPoint {
  date: string;
  value: number;
}

/** 按日汇总行 → 窗口内连续补零序列（升序到今日；窗口外行与垃圾费用不计） */
export function fillDailyCostSeries(opts: {
  rows: readonly UsageDayRow[];
  /** 窗口天数（含今日） */
  days: number;
  /** 日界时区（与后端按日桶同源） */
  timeZone: string;
  /** now 可注入（测试/服务端预渲染），缺省取当前时间 */
  now?: Date;
}): DailyCostPoint[] {
  const { rows, days, timeZone, now = new Date() } = opts;
  const today = todayKey(timeZone, now);
  const costByKey = new Map(rows.map((row) => [row.date, Number(row.cost) || 0]));
  const series: DailyCostPoint[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = dayKeyMinus(today, i);
    series.push({ date, value: costByKey.get(date) ?? 0 });
  }
  return series;
}
