/** 订阅窗口纯函数（S3 抽取）：顺延规则单一真相。 */

/** 续费起点：未到期续费从旧 end 起（顺延），到期后续费从 now 起。 */
export function renewalStart(oldEnd: Date, now: Date): Date {
  return oldEnd.getTime() > now.getTime()
    ? new Date(oldEnd.getTime())
    : new Date(now.getTime());
}

/** 周期末点：start + periodDays 天（变更/购买一律从 now 起算新窗口）。 */
export function periodEnd(start: Date, periodDays: number): Date {
  return new Date(start.getTime() + periodDays * 86_400_000);
}
