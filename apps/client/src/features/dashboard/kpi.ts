/**
 * 概览页 KPI 纯推导（可测）：今日费用按 DISPLAY_TZ 日界取行
 * （v1 用 +8h 硬编码近似——B8 修复为显式时区推导）。
 */
import type { UsageDayRow } from '@tokenlens/api-client';

/** 指定时区的「今天」日期键（yyyy-MM-dd；en-CA locale 恰为该格式） */
export function todayKey(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
}

/** 按日汇总行中「今天」那一行的费用（无行/无值 → 0） */
export function todayCost(rows: readonly UsageDayRow[], timeZone: string, now: Date = new Date()): number {
  const key = todayKey(timeZone, now);
  return Number(rows.find((row) => row.date === key)?.cost ?? 0) || 0;
}
