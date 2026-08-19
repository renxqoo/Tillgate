/**
 * 计费日窗口（单一真相）：每日限额的「一天」= 服务器本地时区自然日
 * （部署以 TZ 声明业务时区）。账本限额与网关免费计数必须共用本实现，
 * 各自实现会导致窗口错位（限额重置时刻互相矛盾）。
 */

/** 本地自然日 0 点（含此刻所在日的起点） */
export function billingDayStart(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** 本地计费日键（YYYY-MM-DD），用于 Redis 计数器分桶 */
export function billingDayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 距下一个本地计费日 0 点的秒数（至少 1，用于 Retry-After） */
export function secondsUntilNextBillingDay(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
}
