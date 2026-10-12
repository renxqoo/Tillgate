/**
 * 趋势窗口与补零序列推导（可测）：day 粒度窗口起点 = 起始日 00:00（DISPLAY_TZ 日界），
 * hour 粒度为今日当地 00:00 起 24 桶；序列按桶补零（无消费桶不再从图上消失）。
 * 后端桶日界 = CLIENT_USAGE_TZ，与 DISPLAY_TZ 默认同源（config/display.ts）。
 */
import type { UsageDayRow, UsageTrendRow } from '@tillgate/api-client';

import { todayKey } from './kpi';

/** 趋势窗口天数（含今日；概览图「近 14 天」口径） */
export const TREND_WINDOW_DAYS = 14;

/** hour 粒度桶数（今日 00:00 起含当前小时的 24 桶；未来小时补零） */
export const TREND_HOURS = 24;

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

/** 趋势宽表行：每桶一行，模型 × 度量展开为动态键（`${model}::${metric}`，供 recharts 堆叠） */
export interface TrendPoint {
  bucket: string;
  values: Record<string, number>;
}

/** trend 度量键（堆叠系列粒度）：费用/请求数为单度量，Token 三分 */
export type TrendMetric = 'cost' | 'input' | 'output' | 'cached' | 'requests';

/** 趋势行聚合夹：同桶同模型合并，垃圾值归零（Number(x)||0 口径同 summary） */
function mergeTrendRows(rows: readonly UsageTrendRow[]): Map<string, UsageTrendRow> {
  const byKey = new Map<string, UsageTrendRow>();
  for (const row of rows) {
    const key = `${row.bucket}::${row.model}`;
    const prev = byKey.get(key);
    if (prev == null) {
      byKey.set(key, { ...row, cost: String(Number(row.cost) || 0) });
    } else {
      prev.requests += Number(row.requests) || 0;
      prev.inputTokens += Number(row.inputTokens) || 0;
      prev.outputTokens += Number(row.outputTokens) || 0;
      prev.cachedInputTokens += Number(row.cachedInputTokens) || 0;
      prev.cost = String((Number(prev.cost) || 0) + (Number(row.cost) || 0));
    }
  }
  return byKey;
}

/** 桶内行 → 宽表行（metrics 全集展开；无行桶全零） */
function toTrendPoint(
  bucket: string,
  models: readonly string[],
  byKey: Map<string, UsageTrendRow>,
): TrendPoint {
  const values: Record<string, number> = {};
  for (const model of models) {
    const row = byKey.get(`${bucket}::${model}`);
    values[`${model}::cost`] = Number(row?.cost) || 0;
    values[`${model}::input`] = Number(row?.inputTokens) || 0;
    values[`${model}::output`] = Number(row?.outputTokens) || 0;
    values[`${model}::cached`] = Number(row?.cachedInputTokens) || 0;
    values[`${model}::requests`] = Number(row?.requests) || 0;
  }
  return { bucket, values };
}

/** 出现在趋势行中的模型全集（保序：首现顺序） */
export function trendModels(rows: readonly UsageTrendRow[]): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const row of rows) {
    if (!seen.has(row.model)) {
      seen.add(row.model);
      models.push(row.model);
    }
  }
  return models;
}

/** 指定时区的当前小时桶键（yyyy-MM-DDTHH:00:00；en-CA 前缀恰好为该日期格式） */
export function currentHourBucket(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:00:00`;
}

/** 今日（timeZone 日界）00:00 起的 24 个小时桶键（升序；与后端 to_char 桶同格式） */
export function hourlyBuckets(timeZone: string, now: Date = new Date()): string[] {
  const start = zonedDayStart(todayKey(timeZone, now), timeZone);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  });
  const keys: string[] = [];
  for (let i = 0; i < TREND_HOURS; i++) {
    const parts = fmt.formatToParts(new Date(start.getTime() + i * 3_600_000));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
    const hour = get('hour') === '24' ? '00' : get('hour');
    keys.push(`${get('year')}-${get('month')}-${get('day')}T${hour}:00:00`);
  }
  return keys;
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

/**
 * 趋势行 → day 粒度宽表序列（窗口内补零；窗口外行丢弃）。
 * 桶键 = yyyy-MM-dd；窗口由 days/timeZone/now 推导（与 fillDailyCostSeries 同口径）。
 */
export function fillDailyTrendSeries(opts: {
  rows: readonly UsageTrendRow[];
  days: number;
  timeZone: string;
  now?: Date;
}): { points: TrendPoint[]; models: string[] } {
  const { rows, days, timeZone, now = new Date() } = opts;
  const today = todayKey(timeZone, now);
  // 只收窗口内日键（垃圾桶键丢弃）
  const inWindow = rows.filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.bucket));
  const windowKeys = new Set(
    Array.from({ length: days }, (_, i) => dayKeyMinus(today, days - 1 - i)),
  );
  const filtered = inWindow.filter((row) => windowKeys.has(row.bucket));
  const models = trendModels(filtered);
  const byKey = mergeTrendRows(filtered);
  const points: TrendPoint[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    points.push(toTrendPoint(dayKeyMinus(today, i), models, byKey));
  }
  return { points, models };
}

/**
 * 趋势行 → hour 粒度宽表序列（今日 24 桶补零含未来小时；非小时键行丢弃）。
 */
export function fillHourlyTrendSeries(opts: {
  rows: readonly UsageTrendRow[];
  timeZone: string;
  now?: Date;
}): { points: TrendPoint[]; models: string[] } {
  const { rows, timeZone, now = new Date() } = opts;
  const inWindow = rows.filter((row) => /^\d{4}-\d{2}-\d{2}T\d{2}:00:00$/.test(row.bucket));
  const models = trendModels(inWindow);
  const byKey = mergeTrendRows(inWindow);
  const points = hourlyBuckets(timeZone, now).map((bucket) => toTrendPoint(bucket, models, byKey));
  return { points, models };
}
